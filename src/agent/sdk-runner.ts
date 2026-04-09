import { randomUUID } from 'node:crypto';
import { query, type Query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { persistence } from './persistence';
import type { PermissionBroker } from './permission-broker';
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
  private q: Query;
  private queue: SDKUserMessage[] = [];
  private queueResolvers: Array<(v: IteratorResult<SDKUserMessage>) => void> = [];
  private done = false;
  public readonly abortController = new AbortController();
  public lastActivity = Date.now();

  constructor(
    private readonly opts: StartOptions,
    private readonly broker: PermissionBroker,
    private readonly emit: (conversationId: string, frame: StreamFrame) => void,
  ) {
    const canUseTool = this.broker.createCallback(opts.conversationId, opts.permissionTimeoutMs);

    this.q = query({
      prompt: this.iterator(),
      options: {
        cwd: opts.cwd,
        model: opts.model,
        permissionMode: opts.permissionMode === 'ask' ? 'default' : opts.permissionMode,
        canUseTool,
        mcpServers: opts.mcpServers,
        settingSources: ['project'],
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        tools: { type: 'preset', preset: 'claude_code' },
        includePartialMessages: true,
        abortController: this.abortController,
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
        message: err instanceof Error ? err.message : String(err),
      });
    });
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
    this.lastActivity = Date.now();
    const sdkMode = mode === 'ask' ? 'default' : mode;
    await this.q.setPermissionMode(sdkMode as 'default' | 'acceptEdits' | 'bypassPermissions');
  }

  async setModel(model: ModelId) {
    this.lastActivity = Date.now();
    await this.q.setModel(model);
  }

  async interrupt() {
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
        const messageId = persistence.writeMessage({
          conversationId: convId,
          role: 'assistant',
          sdkMessageType: 'assistant',
          content,
          toolCalls: toolUses.length > 0 ? toolUses : undefined,
          seq,
        });
        this.emit(convId, {
          type: 'assistant_message',
          conversationId: convId,
          seq,
          messageId,
          content,
        });
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
          event?: { type?: string; delta?: { type?: string; text?: string } };
          uuid?: string;
        };
        if (ev.event?.type === 'content_block_delta' && ev.event.delta?.type === 'text_delta') {
          const seq = persistence.nextSeq(convId);
          this.emit(convId, {
            type: 'partial_assistant_text',
            conversationId: convId,
            seq,
            delta: ev.event.delta.text ?? '',
            messageId: ev.uuid ?? 'partial',
          });
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
