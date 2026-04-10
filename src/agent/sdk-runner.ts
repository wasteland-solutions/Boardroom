import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { query, type Query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { persistence } from './persistence';
import type { PermissionBroker } from './permission-broker';
import { parseWorkspacePath, sshTarget, type RemoteWorkspace } from '../lib/workspace';
import type {
  McpServerConfig,
  ModelId,
  PermissionMode,
  StreamFrame,
} from '../lib/types';

// Path to the SSH bridge wrapper script. Resolved relative to the working
// directory because pnpm dev and pnpm start both run from the repo root,
// and the Dockerfile keeps the same layout (`scripts/` lives at /app).
const SSH_WRAPPER_PATH = resolve(process.cwd(), 'scripts', 'boardroom-claude-ssh.mjs');

export type StartOptions = {
  conversationId: string;
  cwd: string;
  model: ModelId;
  permissionMode: PermissionMode;
  sdkSessionId: string | null;
  mcpServers: Record<string, McpServerConfig>;
  permissionTimeoutMs: number;
};

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

    // Detect remote workspaces. For SSH cwds we point the SDK at our
    // wrapper binary instead of the bundled claude, then forward host /
    // remote-cwd / token info via the SDK's per-query env option so the
    // wrapper can SSH to the right place.
    const parsed = parseWorkspacePath(opts.cwd);
    const isRemote = parsed.kind === 'remote';
    const remote = isRemote ? (parsed as RemoteWorkspace) : null;

    const sshEnv: Record<string, string | undefined> = {};
    if (remote) {
      sshEnv.BOARDROOM_SSH_HOST = sshTarget(remote);
      sshEnv.BOARDROOM_SSH_CWD = remote.path;
      if (remote.port) sshEnv.BOARDROOM_SSH_PORT = String(remote.port);
      // CLAUDE_CODE_OAUTH_TOKEN is already set on process.env by
      // applyCredentials() in worker.ts when authMode === 'claude_code'.
      // The wrapper picks it up there and smuggles it to the remote via
      // LC_BOARDROOM_TOKEN. For api_key mode, ANTHROPIC_API_KEY needs to
      // round-trip the same way — but most ssh hosts also accept LC_*
      // for that, so we mirror it here too.
      if (process.env.ANTHROPIC_API_KEY) {
        sshEnv.LC_BOARDROOM_API_KEY = process.env.ANTHROPIC_API_KEY;
      }
    }

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
        settingSources: ['project'],
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        tools: { type: 'preset', preset: 'claude_code' },
        includePartialMessages: true,
        abortController: this.abortController,
        ...(remote
          ? {
              pathToClaudeCodeExecutable: SSH_WRAPPER_PATH,
              executable: 'node' as const,
              env: { ...process.env, ...sshEnv },
            }
          : {}),
        ...(opts.sdkSessionId ? { resume: opts.sdkSessionId, forkSession: false } : {}),
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
