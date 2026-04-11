import { randomUUID } from 'node:crypto';
import { query, type Query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { SpawnOptions as SdkSpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import { persistence } from './persistence';
import type { PermissionBroker } from './permission-broker';
import { parseWorkspacePath, type RemoteWorkspace } from '../lib/workspace';
import { SshTunnel } from './ssh-tunnel';
import { spawnRemoteClaude } from './remote-spawn';
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
};


// One ActiveQuery per conversation. Owns the bounded async queue that feeds
// SDKUserMessage's into the SDK, the reader loop that drains SDKMessages out,
// and the AbortController used for Stop.
export class ActiveQuery {
  private q: Query | null = null;
  private queue: SDKUserMessage[] = [];
  private queueResolvers: Array<(v: IteratorResult<SDKUserMessage>) => void> = [];
  private done = false;
  private dead = false;
  private onDeadCallback: (() => void) | null = null;
  private readonly streamState: StreamingState = { currentStreamingMessageId: null };
  private tunnel: SshTunnel | null = null;
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
    // Kick off async init (tunnel open for remote, then query + reader loop).
    this.init().catch((err) => {
      console.error(`[sdk-runner] init failed for ${opts.conversationId}:`, err);
      const seq = persistence.nextSeq(opts.conversationId);
      this.emit(opts.conversationId, {
        type: 'error',
        conversationId: opts.conversationId,
        seq,
        message: friendlyErrorMessage(err),
      });
      this.markDead();
    });
  }

  // Async initialization: opens the SSH tunnel (if remote), creates the SDK
  // query, and starts the reader loop.
  private async init() {
    const canUseTool = this.broker.createCallback(this.opts.conversationId, this.opts.permissionTimeoutMs);

    const parsed = parseWorkspacePath(this.opts.cwd);
    const isRemote = parsed.kind === 'remote';
    const remote = isRemote ? (parsed as RemoteWorkspace) : null;

    // For remote workspaces, open the tunnel BEFORE creating the query.
    // The SDK's spawnClaudeCodeProcess callback must be synchronous — it
    // can't await tunnel.open() inside the callback.
    if (remote) {
      this.tunnel = new SshTunnel(remote, this.opts.conversationId);
      await this.tunnel.open();
    }

    const tunnel = this.tunnel;

    this.q = query({
      prompt: this.iterator(),
      options: {
        cwd: remote ? process.cwd() : this.opts.cwd,
        model: this.opts.model,
        permissionMode: this.opts.permissionMode === 'ask' ? 'default' : this.opts.permissionMode,
        canUseTool,
        mcpServers: this.opts.mcpServers,
        settingSources: ['project'],
        systemPrompt: { type: 'preset' as const, preset: 'claude_code' as const },
        tools: { type: 'preset', preset: 'claude_code' },
        includePartialMessages: true,
        abortController: this.abortController,
        // For remote workspaces, spawn the CLI via the remote control
        // server's RPC protocol. The tunnel is already open so this
        // callback is synchronous — it just connects and spawns.
        ...(remote && tunnel
          ? {
              spawnClaudeCodeProcess: (sdkOpts: SdkSpawnOptions) =>
                spawnRemoteClaude(remote, tunnel, sdkOpts),
            }
          : {}),
        ...(this.opts.sdkSessionId && this.opts.sdkSessionId.length > 0
          ? { resume: this.opts.sdkSessionId, forkSession: false }
          : {}),
      },
    });

    // Reader loop.
    try {
      await this.runReaderLoop();
    } catch (err) {
      console.error(`[sdk-runner] reader loop crashed for ${this.opts.conversationId}:`, err);
      const seq = persistence.nextSeq(this.opts.conversationId);
      this.emit(this.opts.conversationId, {
        type: 'error',
        conversationId: this.opts.conversationId,
        seq,
        message: friendlyErrorMessage(err),
      });
      this.markDead();
    }
  }

  private markDead() {
    if (this.dead) return;
    this.dead = true;
    this.done = true;
    for (const r of this.queueResolvers) {
      try {
        r({ value: undefined as never, done: true });
      } catch {
        // ignore
      }
    }
    this.queueResolvers = [];
    this.broker.clearForConversation(this.opts.conversationId);
    if (this.onDeadCallback) {
      try {
        this.onDeadCallback();
      } catch (err) {
        console.error('[sdk-runner] onDead callback threw:', err);
      }
    }
  }

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
    if (this.dead || !this.q) return;
    this.lastActivity = Date.now();
    const sdkMode = mode === 'ask' ? 'default' : mode;
    try {
      await this.q.setPermissionMode(sdkMode as 'default' | 'acceptEdits' | 'bypassPermissions');
    } catch (err) {
      console.error('[sdk-runner] setPermissionMode failed:', err);
    }
  }

  async setModel(model: ModelId) {
    if (this.dead || !this.q) return;
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
      if (this.q) await this.q.interrupt();
    } catch (err) {
      console.error('[sdk-runner] interrupt failed:', err);
    }
    this.abortController.abort();
    persistence.setSdkSessionId(this.opts.conversationId, '');
  }

  async listSlashCommands(): Promise<Array<{ name: string; description: string; argumentHint: string }>> {
    if (this.dead || !this.q) return [];
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
    if (this.tunnel) {
      this.tunnel.close();
      this.tunnel = null;
    }
  }

  get conversationId() {
    return this.opts.conversationId;
  }

  private async runReaderLoop() {
    if (!this.q) return;
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
    handleSdkMessage(convId, msg as unknown as Record<string, unknown>, this.emit, this.streamState);
  }
}

// Mutable streaming state shared between the caller's reader loop and this
// function.
export type StreamingState = { currentStreamingMessageId: string | null };

// Standalone message handler. Consumes one parsed message from the claude
// stream-json protocol, persists it, and emits the corresponding StreamFrame(s).
export function handleSdkMessage(
  convId: string,
  msg: Record<string, unknown>,
  emit: (conversationId: string, frame: StreamFrame) => void,
  state: StreamingState,
): void {
  switch (msg.type) {
    case 'system': {
      const anyMsg = msg as { session_id?: string; subtype?: string };
      if (anyMsg.session_id) persistence.setSdkSessionId(convId, anyMsg.session_id);
      const seq = persistence.nextSeq(convId);
      persistence.writeMessage({
        conversationId: convId,
        role: 'system',
        sdkMessageType: `system${anyMsg.subtype ? `:${anyMsg.subtype}` : ''}`,
        content: msg,
        seq,
      });
      if (anyMsg.subtype === 'init') {
        const init = msg as {
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
      emit(convId, { type: 'system', conversationId: convId, seq, payload: msg });
      return;
    }
    case 'assistant': {
      const assistantMsg = msg as {
        message: { id?: string; content: unknown };
      };
      const content = assistantMsg.message?.content ?? [];
      const toolUses = Array.isArray(content)
        ? (content as Array<{ type?: string }>).filter((b) => b.type === 'tool_use')
        : [];
      const seq = persistence.nextSeq(convId);
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
      emit(convId, {
        type: 'assistant_message',
        conversationId: convId,
        seq,
        messageId,
        content,
      });
      if (anthropicMessageId && anthropicMessageId === state.currentStreamingMessageId) {
        state.currentStreamingMessageId = null;
      }
      for (const tu of toolUses as Array<{ id?: string; name?: string; input?: unknown }>) {
        const tuSeq = persistence.nextSeq(convId);
        emit(convId, {
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
      const userMsg = msg as { message: { content: unknown } };
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
            emit(convId, {
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
    case 'stream_event': {
      const ev = msg as {
        event?: {
          type?: string;
          message?: { id?: string };
          delta?: { type?: string; text?: string };
        };
      };
      const inner = ev.event;
      if (!inner) return;

      if (inner.type === 'message_start' && inner.message?.id) {
        state.currentStreamingMessageId = inner.message.id;
        return;
      }

      if (inner.type === 'content_block_delta' && inner.delta?.type === 'text_delta') {
        const messageId = state.currentStreamingMessageId ?? 'streaming';
        const seq = persistence.nextSeq(convId);
        emit(convId, {
          type: 'partial_assistant_text',
          conversationId: convId,
          seq,
          delta: inner.delta.text ?? '',
          messageId,
        });
        return;
      }

      if (inner.type === 'message_stop') {
        return;
      }
      return;
    }
    case 'result': {
      const result = msg as {
        duration_ms?: number;
        num_turns?: number;
        total_cost_usd?: number;
        is_error?: boolean;
      };
      const seq = persistence.nextSeq(convId);
      emit(convId, {
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
      emit(convId, { type: 'system', conversationId: convId, seq, payload: msg });
    }
  }
}

function friendlyErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (/exited with code 127/.test(raw)) {
    return (
      'claude exited with code 127 (command not found). ' +
      'Check that the remote server is running at ~/.claude/remote/.'
    );
  }
  if (/exited with code 255/.test(raw)) {
    return (
      'ssh exited with code 255 (connection failed). Check the host is ' +
      'reachable and your key auth works non-interactively.'
    );
  }
  return raw;
}
