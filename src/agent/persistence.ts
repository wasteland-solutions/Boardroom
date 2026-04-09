import { randomUUID } from 'node:crypto';
import { and, eq, max } from 'drizzle-orm';
import { getDb } from '../lib/db';
import { messages, conversations } from '../lib/schema';
import type { StreamFrame } from '../lib/types';

// Persists `SDKMessage`s to SQLite and returns the monotonic `seq` for SSE
// frames. Each conversation has its own sequence. Call `nextSeq()` for any
// frame you want to emit; the `seq` is authoritative for replay.
export class Persistence {
  private seqs = new Map<string, number>();

  private loadSeq(conversationId: string): number {
    if (this.seqs.has(conversationId)) return this.seqs.get(conversationId)!;
    const db = getDb();
    const row = db
      .select({ s: max(messages.seq) })
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .get();
    const current = row?.s ?? 0;
    this.seqs.set(conversationId, current);
    return current;
  }

  nextSeq(conversationId: string): number {
    const cur = this.loadSeq(conversationId);
    const next = cur + 1;
    this.seqs.set(conversationId, next);
    return next;
  }

  setSdkSessionId(conversationId: string, sdkSessionId: string) {
    const db = getDb();
    db.update(conversations)
      .set({ sdkSessionId, updatedAt: Date.now() })
      .where(eq(conversations.id, conversationId))
      .run();
  }

  touch(conversationId: string) {
    const db = getDb();
    db.update(conversations).set({ updatedAt: Date.now() }).where(eq(conversations.id, conversationId)).run();
  }

  // Write a single storable message (non-partial). Partial token deltas are
  // not written here — they are emitted as SSE frames only and the final
  // `assistant_message` frame ends up persisted.
  writeMessage(opts: {
    conversationId: string;
    role: 'user' | 'assistant' | 'system' | 'tool_result';
    sdkMessageType: string;
    content: unknown;
    toolCalls?: unknown;
    seq: number;
  }): string {
    const db = getDb();
    const id = randomUUID();
    db.insert(messages)
      .values({
        id,
        conversationId: opts.conversationId,
        seq: opts.seq,
        role: opts.role,
        content: JSON.stringify(opts.content),
        toolCalls: opts.toolCalls === undefined ? null : JSON.stringify(opts.toolCalls),
        sdkMessageType: opts.sdkMessageType,
      })
      .run();
    this.touch(opts.conversationId);
    return id;
  }

  // Replay all stored messages for a conversation past `afterSeq` as
  // `StreamFrame`s. Used by SSE reconnect.
  replayFrames(conversationId: string, afterSeq: number): StreamFrame[] {
    const db = getDb();
    const rows = db
      .select()
      .from(messages)
      .where(and(eq(messages.conversationId, conversationId)))
      .all()
      .filter((r) => r.seq > afterSeq)
      .sort((a, b) => a.seq - b.seq);

    return rows.map((r): StreamFrame => {
      const content = JSON.parse(r.content);
      if (r.role === 'assistant') {
        return {
          type: 'assistant_message',
          conversationId,
          seq: r.seq,
          messageId: r.id,
          content,
        };
      }
      if (r.role === 'user') {
        return {
          type: 'user_message',
          conversationId,
          seq: r.seq,
          messageId: r.id,
          content,
        };
      }
      if (r.role === 'tool_result') {
        return {
          type: 'tool_result',
          conversationId,
          seq: r.seq,
          toolUseId: (content as { tool_use_id?: string })?.tool_use_id ?? '',
          content,
          isError: (content as { is_error?: boolean })?.is_error ?? false,
        };
      }
      return {
        type: 'system',
        conversationId,
        seq: r.seq,
        payload: content,
      };
    });
  }
}

export const persistence = new Persistence();
