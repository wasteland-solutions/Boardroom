import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { dirname } from 'node:path';
import { query, type Query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { SpawnOptions as SdkSpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import { persistence } from './persistence';
import type { PermissionBroker } from './permission-broker';
import { parseWorkspacePath, sshTarget, type RemoteWorkspace } from '../lib/workspace';
import type {
  McpServerConfig,
  ModelId,
  PermissionMode,
  StreamFrame,
} from '../lib/types';

export type StartOptions = {
  conversationId: string;
  cwd: string;
  model: ModelId;
  permissionMode: PermissionMode;
  sdkSessionId: string | null;
  mcpServers: Record<string, McpServerConfig>;
  permissionTimeoutMs: number;
  systemPromptAppend: string | null;
  // Filenames at the workspace root that we read at session start and
  // prepend to the system prompt. Defaults are set in DEFAULT_SETTINGS;
  // user can override in Settings.
  workspaceMemoryFiles: string[];
};

// Cap on combined memory file content (in characters, not tokens) so a
// runaway file doesn't blow out the system prompt or wedge the SSH
// transport. ~256KB ≈ ~65k tokens; well under any model's context.
const MAX_MEMORY_BYTES = 256 * 1024;

// One ActiveQuery per conversation. Owns the bounded async queue that feeds
// SDKUserMessage's into the SDK, the reader loop that drains SDKMessages out,
// and the AbortController used for Stop.
export class ActiveQuery {
  private q: Query;
  private queue: SDKUserMessage[] = [];
  private queueResolvers: Array<(v: IteratorResult<SDKUserMessage>) => void> = [];
  private done = false;
  // True once the underlying claude process has crashed or been closed.
  // sendUserText / setPermissionMode / setModel all bail when this is set
  // so we don't try to write to a dead transport (which the SDK throws on
  // synchronously, killing the worker).
  private dead = false;
  // Callback the SessionManager subscribes to so it can evict this entry
  // from its map when we self-terminate.
  private onDeadCallback: (() => void) | null = null;
  // ID of the Anthropic assistant message currently being streamed. Set on
  // message_start and reused for every content_block_delta in that turn so
  // the UI can key every delta against one stable message ID and append to
  // a single growing bubble. Cleared when the final SDKAssistantMessage for
  // the same turn is persisted.
  private currentStreamingMessageId: string | null = null;
  public readonly abortController = new AbortController();
  public lastActivity = Date.now();

  get isDead() {
    return this.dead;
  }

  setOnDead(cb: () => void) {
    this.onDeadCallback = cb;
  }

  constructor(
    private readonly opts: StartOptions,
    private readonly broker: PermissionBroker,
    private readonly emit: (conversationId: string, frame: StreamFrame) => void,
  ) {
    const canUseTool = this.broker.createCallback(opts.conversationId, opts.permissionTimeoutMs);

    const parsed = parseWorkspacePath(opts.cwd);
    const isRemote = parsed.kind === 'remote';
    const remote = isRemote ? (parsed as RemoteWorkspace) : null;

    // Use the standard claude_code preset with no modifications.
    // The agent's identity comes from the workspace's own files
    // (CLAUDE.md, .claude/, etc.) via settingSources: ['project'] —
    // we don't inject anything extra into the system prompt.
    const systemPromptOption = {
      type: 'preset' as const,
      preset: 'claude_code' as const,
    };

    this.q = query({
      prompt: this.iterator(),
      options: {
        // For remote workspaces, the wrapper does its own remote `cd`, so
        // the local cwd just needs to be a real existing directory. Use
        // process.cwd() as a stable fallback.
        cwd: remote ? process.cwd() : opts.cwd,
        model: opts.model,
        permissionMode: opts.permissionMode === 'ask' ? 'default' : opts.permissionMode,
        canUseTool,
        mcpServers: opts.mcpServers,
        // Project-scoped only — Boardroom deliberately does NOT load
        // ~/.claude/ ('user' source) so the agent's behavior is
        // determined entirely by what's in the workspace itself
        // (CLAUDE.md, .claude/agents/, .claude/commands/, .claude/
        // skills/, .claude/settings.json walked up from cwd). This
        // makes each workspace self-contained and reproducible —
        // the same workspace mounted on a different host gets the
        // same agent personality, regardless of whose ~/.claude
        // happens to live there.
        settingSources: ['project'],
        systemPrompt: systemPromptOption,
        tools: { type: 'preset', preset: 'claude_code' },
        includePartialMessages: true,
        abortController: this.abortController,
        // For SSH workspaces we use the SDK's spawnClaudeCodeProcess
        // callback instead of pathToClaudeCodeExecutable. This is the
        // SDK's *intended* extension point for VMs / containers / SSH —
        // it keeps the client identity / headers identical to a standard
        // SDK spawn, which avoids Anthropic's third-party-harness
        // classification. pathToClaudeCodeExecutable swaps the binary
        // and the SDK reports it as a non-standard executable.
        ...(remote
          ? {
              spawnClaudeCodeProcess: (sdkOpts: SdkSpawnOptions) =>
                spawnSshClaude(remote, sdkOpts),
            }
          : {}),
        ...(opts.sdkSessionId && opts.sdkSessionId.length > 0
          ? { resume: opts.sdkSessionId, forkSession: false }
          : {}),
      },
    });

    // Kick off the reader loop (fire and forget).
    this.runReaderLoop().catch((err) => {
      console.error(`[sdk-runner] reader loop crashed for ${opts.conversationId}:`, err);
      const seq = persistence.nextSeq(opts.conversationId);
      this.emit(opts.conversationId, {
        type: 'error',
        conversationId: opts.conversationId,
        seq,
        message: friendlyErrorMessage(err),
      });
      // Tear ourselves down so the next sendUserText doesn't try to write
      // to the dead transport (which throws inside the SDK and crashes
      // the worker if not caught).
      this.markDead();
    });
  }

  private markDead() {
    if (this.dead) return;
    this.dead = true;
    this.done = true;
    // Drain any pending input resolvers so the SDK iterator returns
    // cleanly and the SDK lets go of its end of the stream.
    for (const r of this.queueResolvers) {
      try {
        r({ value: undefined as never, done: true });
      } catch {
        // ignore
      }
    }
    this.queueResolvers = [];
    // Resolve any pending permission prompts with deny so the UI doesn't
    // hang on a bubble forever.
    this.broker.clearForConversation(this.opts.conversationId);
    // Tell the SessionManager to evict us so the next start_or_resume
    // creates a fresh ActiveQuery.
    if (this.onDeadCallback) {
      try {
        this.onDeadCallback();
      } catch (err) {
        console.error('[sdk-runner] onDead callback threw:', err);
      }
    }
  }

  // Implements the AsyncIterable<SDKUserMessage> that the SDK consumes.
  private async *iterator(): AsyncGenerator<SDKUserMessage> {
    while (!this.done) {
      if (this.queue.length > 0) {
        yield this.queue.shift()!;
        continue;
      }
      const next = await new Promise<IteratorResult<SDKUserMessage>>((resolve) => {
        this.queueResolvers.push(resolve);
      });
      if (next.done) return;
      yield next.value;
    }
  }

  sendUserText(text: string) {
    if (this.dead) {
      // The underlying claude process is gone — likely the previous
      // attempt crashed. Surface a clear error and let the route handler
      // re-spawn on next start_or_resume.
      const seq = persistence.nextSeq(this.opts.conversationId);
      this.emit(this.opts.conversationId, {
        type: 'error',
        conversationId: this.opts.conversationId,
        seq,
        message: 'Session is dead — open the conversation again to retry.',
      });
      return;
    }
    this.lastActivity = Date.now();
    const userMessage: SDKUserMessage = {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text }],
      },
      parent_tool_use_id: null,
      session_id: this.opts.sdkSessionId ?? '',
    } as unknown as SDKUserMessage;

    // Persist the user message immediately so it shows up in history even
    // before the SDK echoes it back.
    const seq = persistence.nextSeq(this.opts.conversationId);
    const messageId = persistence.writeMessage({
      conversationId: this.opts.conversationId,
      role: 'user',
      sdkMessageType: 'user_input',
      content: [{ type: 'text', text }],
      seq,
    });
    this.emit(this.opts.conversationId, {
      type: 'user_message',
      conversationId: this.opts.conversationId,
      seq,
      messageId,
      content: [{ type: 'text', text }],
    });

    if (this.queueResolvers.length > 0) {
      const resolver = this.queueResolvers.shift()!;
      resolver({ value: userMessage, done: false });
    } else {
      this.queue.push(userMessage);
    }
  }

  async setPermissionMode(mode: PermissionMode) {
    if (this.dead) return;
    this.lastActivity = Date.now();
    const sdkMode = mode === 'ask' ? 'default' : mode;
    try {
      await this.q.setPermissionMode(sdkMode as 'default' | 'acceptEdits' | 'bypassPermissions');
    } catch (err) {
      console.error('[sdk-runner] setPermissionMode failed:', err);
    }
  }

  async setModel(model: ModelId) {
    if (this.dead) return;
    this.lastActivity = Date.now();
    try {
      await this.q.setModel(model);
    } catch (err) {
      console.error('[sdk-runner] setModel failed:', err);
    }
  }

  async interrupt() {
    if (this.dead) return;
    try {
      await this.q.interrupt();
    } catch (err) {
      console.error('[sdk-runner] interrupt failed:', err);
    }
    this.abortController.abort();
    // Clear the saved session ID so the next start_or_resume creates a
    // fresh session instead of trying to --resume a session file that
    // was potentially corrupted by the interrupt (the remote claude
    // gets SIGHUPed when ssh drops and may not save cleanly).
    persistence.setSdkSessionId(this.opts.conversationId, '');
  }

  async listSlashCommands(): Promise<Array<{ name: string; description: string; argumentHint: string }>> {
    if (this.dead) return [];
    try {
      const cmds = await this.q.supportedCommands();
      return cmds;
    } catch (err) {
      console.error('[sdk-runner] supportedCommands failed:', err);
      return [];
    }
  }

  close() {
    this.done = true;
    for (const r of this.queueResolvers) r({ value: undefined as never, done: true });
    this.queueResolvers = [];
    this.abortController.abort();
    this.broker.clearForConversation(this.opts.conversationId);
  }

  get conversationId() {
    return this.opts.conversationId;
  }

  // Drain SDKMessages from the SDK and turn each into SQLite writes + SSE frames.
  private async runReaderLoop() {
    const convId = this.opts.conversationId;
    try {
      for await (const msg of this.q) {
        this.lastActivity = Date.now();
        this.handleSdkMessage(convId, msg);
      }
    } finally {
      const seq = persistence.nextSeq(convId);
      this.emit(convId, { type: 'stream_closed', conversationId: convId, seq });
    }
  }

  private handleSdkMessage(convId: string, msg: SDKMessage) {
    switch (msg.type) {
      case 'system': {
        const anyMsg = msg as unknown as { session_id?: string; subtype?: string };
        if (anyMsg.session_id) persistence.setSdkSessionId(convId, anyMsg.session_id);
        const seq = persistence.nextSeq(convId);
        // Persist init/system metadata so we can debug what claude
        // actually loaded — memory paths, skills list, mcp status, etc.
        // The frontend currently ignores `system` rows when hydrating
        // so they don't clutter the chat view.
        persistence.writeMessage({
          conversationId: convId,
          role: 'system',
          sdkMessageType: `system${anyMsg.subtype ? `:${anyMsg.subtype}` : ''}`,
          content: msg,
          seq,
        });
        if (anyMsg.subtype === 'init') {
          // Compact one-line console log so we can spot what claude
          // loaded without grovelling through the SQLite blob.
          const init = msg as unknown as {
            cwd?: string;
            tools?: string[];
            mcp_servers?: Array<{ name?: string; status?: string }>;
            slash_commands?: string[];
          };
          console.log(
            `[sdk-runner] system:init for ${convId}: cwd=${init.cwd ?? '?'} ` +
              `tools=${(init.tools ?? []).length} ` +
              `mcp=${(init.mcp_servers ?? []).map((m) => `${m.name}(${m.status})`).join(',') || 'none'} ` +
              `commands=${(init.slash_commands ?? []).length}`,
          );
        }
        this.emit(convId, { type: 'system', conversationId: convId, seq, payload: msg });
        return;
      }
      case 'assistant': {
        const assistantMsg = msg as unknown as {
          message: { id?: string; content: unknown };
        };
        const content = assistantMsg.message?.content ?? [];
        const toolUses = Array.isArray(content)
          ? (content as Array<{ type?: string }>).filter((b) => b.type === 'tool_use')
          : [];
        const seq = persistence.nextSeq(convId);
        // Prefer the Anthropic message id so the UI can match this final
        // frame against the partial deltas it was streaming. Fall back to
        // the persistence row id for anything exotic.
        const anthropicMessageId = assistantMsg.message?.id ?? null;
        const rowId = persistence.writeMessage({
          conversationId: convId,
          role: 'assistant',
          sdkMessageType: 'assistant',
          content,
          toolCalls: toolUses.length > 0 ? toolUses : undefined,
          seq,
        });
        const messageId = anthropicMessageId ?? rowId;
        this.emit(convId, {
          type: 'assistant_message',
          conversationId: convId,
          seq,
          messageId,
          content,
        });
        // Done streaming this turn.
        if (anthropicMessageId && anthropicMessageId === this.currentStreamingMessageId) {
          this.currentStreamingMessageId = null;
        }
        // Also emit tool_use frames for the UI to render collapsible cards.
        for (const tu of toolUses as Array<{ id?: string; name?: string; input?: unknown }>) {
          const tuSeq = persistence.nextSeq(convId);
          this.emit(convId, {
            type: 'tool_use',
            conversationId: convId,
            seq: tuSeq,
            toolUseId: tu.id ?? randomUUID(),
            name: tu.name ?? 'unknown',
            input: tu.input ?? {},
          });
        }
        return;
      }
      case 'user': {
        // Tool results from the SDK are delivered as user messages with tool_result blocks.
        const userMsg = msg as unknown as { message: { content: unknown } };
        const content = userMsg.message?.content ?? [];
        if (Array.isArray(content)) {
          for (const block of content as Array<{
            type?: string;
            tool_use_id?: string;
            content?: unknown;
            is_error?: boolean;
          }>) {
            if (block.type === 'tool_result') {
              const seq = persistence.nextSeq(convId);
              persistence.writeMessage({
                conversationId: convId,
                role: 'tool_result',
                sdkMessageType: 'tool_result',
                content: block,
                seq,
              });
              this.emit(convId, {
                type: 'tool_result',
                conversationId: convId,
                seq,
                toolUseId: block.tool_use_id ?? '',
                content: block.content ?? '',
                isError: block.is_error ?? false,
              });
            }
          }
        }
        return;
      }
      case 'stream_event' as SDKMessage['type']: {
        // Partial assistant token deltas — emit without persisting.
        const ev = msg as unknown as {
          event?: {
            type?: string;
            message?: { id?: string };
            delta?: { type?: string; text?: string };
          };
        };
        const inner = ev.event;
        if (!inner) return;

        // Capture the Anthropic message id for this turn so every delta
        // gets the same messageId and the UI streams into one bubble.
        if (inner.type === 'message_start' && inner.message?.id) {
          this.currentStreamingMessageId = inner.message.id;
          return;
        }

        if (inner.type === 'content_block_delta' && inner.delta?.type === 'text_delta') {
          // If we somehow missed message_start, still emit but with a
          // placeholder id; worst case the UI falls back to batching on
          // the last streaming bubble.
          const messageId = this.currentStreamingMessageId ?? 'streaming';
          const seq = persistence.nextSeq(convId);
          this.emit(convId, {
            type: 'partial_assistant_text',
            conversationId: convId,
            seq,
            delta: inner.delta.text ?? '',
            messageId,
          });
          return;
        }

        if (inner.type === 'message_stop') {
          // Don't clear currentStreamingMessageId here — the final
          // SDKAssistantMessage may still arrive with more content; we
          // clear in the 'assistant' case once we've seen it.
          return;
        }
        return;
      }
      case 'result': {
        const result = msg as unknown as {
          duration_ms?: number;
          num_turns?: number;
          total_cost_usd?: number;
          is_error?: boolean;
        };
        const seq = persistence.nextSeq(convId);
        this.emit(convId, {
          type: 'result',
          conversationId: convId,
          seq,
          durationMs: result.duration_ms,
          numTurns: result.num_turns,
          totalCostUsd: result.total_cost_usd,
          isError: result.is_error,
        });
        return;
      }
      default: {
        const seq = persistence.nextSeq(convId);
        this.emit(convId, { type: 'system', conversationId: convId, seq, payload: msg });
      }
    }
  }
}

// Single-quote a string for safe inclusion in a remote sh command.
function shq(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

// Spawn `claude` on a remote host over SSH and return a ChildProcess that
// satisfies the SDK's SpawnedProcess interface. This is the
// spawnClaudeCodeProcess callback — the SDK calls it instead of its
// default local spawn, receives the ChildProcess back, and pipes the
// stream-json protocol through ssh transparently. Because we're using
// the SDK's proper extension point (not pathToClaudeCodeExecutable), the
// client identity / API headers stay identical to a standard SDK spawn —
// no third-party-harness classification.
function spawnSshClaude(
  remote: RemoteWorkspace,
  sdkOpts: SdkSpawnOptions,
) {
  const target = sshTarget(remote);

  // Build the remote bootstrap script. Same two-shell dance: bash
  // --noprofile --norc outer shell (silent stdout) captures PATH from
  // a bash -lic subshell, then cd + exec claude with the SDK's args.
  //
  // The SDK passes args as ['/local/path/to/cli.js', '--flags...']
  // because it normally spawns `node cli.js --flags`. We only want
  // the CLI flags for the remote — the entry-script path is a local
  // path that doesn't exist on the remote box. Filter out anything
  // that looks like a local script path (starts with / and ends with
  // .js/.mjs) so we just get the --flag arguments.
  const cliFlags = sdkOpts.args.filter(
    (a) => !(/^\//.test(a) && /\.(m?js|cjs)$/.test(a)),
  );
  const argsString = cliFlags.map((a) => shq(a)).join(' ');
  const remoteScript = [
    'set -e',
    '',
    'RAW="$(bash -lic \'command printf "BRBEGIN%sBREND" "$PATH"\' </dev/null 2>/dev/null)" || RAW=""',
    'case "$RAW" in',
    '  *BRBEGIN*BREND*)',
    '    P="${RAW#*BRBEGIN}"',
    '    P="${P%BREND*}"',
    '    if [ -n "$P" ]; then',
    '      export PATH="$P"',
    '    fi',
    '    ;;',
    'esac',
    '',
    `cd ${shq(remote.path)} || { echo "[boardroom-ssh] cd failed: ${remote.path}" >&2; exit 1; }`,
    `exec claude ${argsString}`,
    '',
  ].join('\n');

  const b64 = Buffer.from(remoteScript, 'utf8').toString('base64');
  const remoteCommand = `bash --noprofile --norc -c 'eval "$(printf %s ${b64} | base64 -d)"'`;

  const sshArgs = [
    '-o', 'BatchMode=yes',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'ControlMaster=auto',
    '-o', `ControlPath=/tmp/.boardroom-ssh-${process.getuid?.() ?? 'x'}-%C`,
    '-o', 'ControlPersist=10m',
  ];
  if (remote.port) sshArgs.push('-p', String(remote.port));
  sshArgs.push(target, '--', remoteCommand);

  // Strip local Anthropic credentials from the child env so they can't
  // leak to the remote. The remote claude uses its own auth.
  const childEnv: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(sdkOpts.env)) {
    if (k === 'ANTHROPIC_API_KEY' || k === 'CLAUDE_CODE_OAUTH_TOKEN') continue;
    childEnv[k] = v;
  }

  const child = spawn('ssh', sshArgs, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: childEnv as NodeJS.ProcessEnv,
  });

  // Wire the SDK's abort signal to kill the ssh child.
  const onAbort = () => {
    if (!child.killed) child.kill('SIGTERM');
  };
  sdkOpts.signal.addEventListener('abort', onAbort, { once: true });

  // Debug logging — capture stderr and dump on exit.
  const stderrChunks: Buffer[] = [];
  child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
  child.on('exit', (code, signal) => {
    try {
      const logPath = '/tmp/boardroom-ssh-last.log';
      mkdirSync(dirname(logPath), { recursive: true });
      const stderrText = Buffer.concat(stderrChunks).toString('utf8');
      const lines = [
        `# ${new Date().toISOString()}  exit=${code ?? 'null'} signal=${signal ?? 'null'}`,
        `host: ${target}`,
        `cwd:  ${remote.path}`,
        `port: ${remote.port ?? 'default'}`,
        `auth: remote (we don't forward credentials)`,
        `args: ${JSON.stringify(sdkOpts.args)}`,
        `cmd:  ssh ${sshArgs.join(' ')}`,
        stderrText ? `stderr:\n${stderrText}` : 'stderr: (empty)',
        '',
      ];
      appendFileSync(logPath, lines.join('\n'));
    } catch {
      // ignore log failures
    }
    if (code !== 0) {
      const stderrText = Buffer.concat(stderrChunks).toString('utf8').trim();
      console.error(
        `[spawnSshClaude] ssh exited ${code}${signal ? ` (${signal})` : ''}` +
          (stderrText ? ` stderr: ${stderrText}` : '') +
          ` — debug log: /tmp/boardroom-ssh-last.log`,
      );
    }
  });

  // ChildProcess satisfies SpawnedProcess at runtime (stdin/stdout are
  // Writable/Readable when spawned with stdio: 'pipe'). TypeScript
  // complains because ChildProcess types stdin as `Writable | null` —
  // we know it's non-null here because of the pipe stdio config.
  return child as unknown as import('@anthropic-ai/claude-agent-sdk').SpawnedProcess;
}

// Read configured workspace memory files (e.g. CLAUDE.md, SOUL.md,
// IDENTITY.md) from the workspace root and concatenate their contents
// into a single string with `===== <filename> =====` headers between
// them. Returns the empty string when nothing is found.
//
// For local workspaces this is a straight `fs.readFileSync` per file.
// For SSH workspaces we batch all the file reads into a single ssh
// invocation that uses a tiny remote bash loop to print existing files
// with our header markers — one connection (warm via ControlMaster),
// no extra round-trips.
//
// Anything that fails for any reason returns an empty string. We never
// throw — bad memory files should not block the conversation from
// starting.
function loadWorkspaceMemory(
  workspace: ReturnType<typeof parseWorkspacePath>,
  files: string[],
): string {
  if (!files || files.length === 0) return '';

  // Reject anything with path separators or upward traversal — we only
  // load files at the workspace root, never wander into subdirs.
  const safeFiles = files.filter(
    (f) => f && !f.includes('/') && !f.includes('\\') && !f.includes('..'),
  );
  if (safeFiles.length === 0) return '';

  if (workspace.kind === 'local') {
    return loadLocalMemory(workspace.path, safeFiles);
  }
  if (workspace.kind === 'remote') {
    return loadRemoteMemory(workspace, safeFiles);
  }
  return '';
}

function loadLocalMemory(cwd: string, files: string[]): string {
  const sections: string[] = [];
  let total = 0;
  for (const name of files) {
    const path = join(cwd, name);
    if (!existsSync(path)) continue;
    let content: string;
    try {
      content = readFileSync(path, 'utf8');
    } catch (err) {
      console.warn(`[workspace-memory] failed to read ${path}:`, err);
      continue;
    }
    // Stop adding once we'd exceed the budget; the SDK has limits and
    // dragging in a 5MB file would just OOM the prompt.
    if (total + content.length > MAX_MEMORY_BYTES) {
      console.warn(
        `[workspace-memory] truncating after ${name} — combined memory > ${MAX_MEMORY_BYTES} bytes`,
      );
      break;
    }
    sections.push(`===== ${name} =====\n${content.trim()}`);
    total += content.length;
  }
  return sections.join('\n\n');
}

function loadRemoteMemory(workspace: RemoteWorkspace, files: string[]): string {
  // Build a tiny remote bash script that walks the configured filename
  // list, prints a marker before each existing file, then dumps it.
  // The shell-quote the filenames so weird chars in user-configured
  // names can't escape.
  const quoted = files.map((f) => `'${f.replace(/'/g, "'\\''")}'`).join(' ');
  const remoteScript =
    `cd '${workspace.path.replace(/'/g, "'\\''")}' 2>/dev/null || exit 0; ` +
    `for f in ${quoted}; do ` +
    `  if [ -f "$f" ]; then ` +
    `    printf '<<<BR_FILE:%s>>>\\n' "$f"; ` +
    `    cat "$f"; ` +
    `    printf '\\n<<<BR_END>>>\\n'; ` +
    `  fi; ` +
    `done`;

  const sshArgs = [
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ControlMaster=auto',
    '-o', `ControlPath=/tmp/.boardroom-ssh-${process.getuid?.() ?? 'x'}-%C`,
    '-o', 'ControlPersist=10m',
  ];
  if (workspace.port) sshArgs.push('-p', String(workspace.port));
  sshArgs.push(sshTarget(workspace), '--', remoteScript);

  let stdout: Buffer;
  try {
    stdout = execFileSync('ssh', sshArgs, {
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: MAX_MEMORY_BYTES * 2,
      timeout: 15_000,
    });
  } catch (err) {
    console.warn(
      `[workspace-memory] ssh-cat failed for ${sshTarget(workspace)}:${workspace.path}:`,
      (err as Error).message,
    );
    return '';
  }

  const text = stdout.toString('utf8');
  const sections: string[] = [];
  let total = 0;
  // Parse <<<BR_FILE:name>>>...<<<BR_END>>> blocks.
  const re = /<<<BR_FILE:([^>]+)>>>\n([\s\S]*?)\n<<<BR_END>>>/g;
  let match;
  while ((match = re.exec(text)) !== null) {
    const name = match[1];
    const body = match[2];
    if (total + body.length > MAX_MEMORY_BYTES) {
      console.warn(
        `[workspace-memory] truncating remote memory after ${name} — combined > ${MAX_MEMORY_BYTES} bytes`,
      );
      break;
    }
    sections.push(`===== ${name} =====\n${body.trim()}`);
    total += body.length;
  }
  return sections.join('\n\n');
}

// Convert raw SDK errors into user-facing message strings. Most SDK errors
// are opaque ("Claude Code process exited with code N") — we add a hint
// for the common ones so the UI gives the user something to act on.
function friendlyErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (/exited with code 127/.test(raw)) {
    return (
      'claude exited with code 127 (command not found). For SSH workspaces ' +
      'this usually means `claude` is not on PATH for the remote login shell. ' +
      'Run `bash -lic "which claude"` on the remote — if that prints a path ' +
      'but Boardroom still fails, check /tmp/boardroom-ssh-last.log on the ' +
      'Boardroom host for the captured ssh stderr.'
    );
  }
  if (/exited with code 255/.test(raw)) {
    return (
      'ssh exited with code 255 (connection failed). Check the host is ' +
      'reachable and your key auth works non-interactively. Full debug log: ' +
      '/tmp/boardroom-ssh-last.log on the Boardroom host.'
    );
  }
  return raw;
}
