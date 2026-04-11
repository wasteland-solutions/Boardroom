import { eq } from 'drizzle-orm';
import { auth } from '@/lib/auth';
import { agentClient } from '@/lib/agent-client';
import { streamBus } from '@/lib/bus';
import { getDb } from '@/lib/db';
import { conversations, messages } from '@/lib/schema';
import { getSettings } from '@/lib/settings-store';
import type { StreamFrame } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const encoder = new TextEncoder();

function sseFrame(frame: StreamFrame): string {
  // id = per-conversation seq (monotonic, present on every frame with a seq field).
  const id = 'seq' in frame ? frame.seq : undefined;
  const lines = [`event: ${frame.type}`, `data: ${JSON.stringify(frame)}`];
  if (id !== undefined) lines.unshift(`id: ${id}`);
  return lines.join('\n') + '\n\n';
}

export async function GET(req: Request, ctx: { params: Promise<{ conversationId: string }> }) {
  const session = await auth();
  if (!session) {
    return new Response('unauthorized', { status: 401 });
  }

  const { conversationId } = await ctx.params;
  const db = getDb();
  const conv = db.select().from(conversations).where(eq(conversations.id, conversationId)).get();
  if (!conv) return new Response('not found', { status: 404 });

  const lastEventId = Number(req.headers.get('last-event-id') ?? '0') || 0;

  // Ensure the worker has a session for this conversation so permission
  // prompts / streams can flow. This is idempotent inside the worker.
  const appSettings = getSettings();
  try {
    await agentClient.call({
      op: 'start_or_resume',
      conversationId,
      cwd: conv.cwd,
      model: conv.model as never,
      permissionMode: conv.permissionMode as never,
      sdkSessionId: conv.sdkSessionId,
      mcpServers: appSettings.mcpServers,
      permissionTimeoutMs: appSettings.permissionTimeoutMs,
      authMode: appSettings.authMode,
      anthropicApiKey: appSettings.anthropicApiKey,
      claudeCodeOauthToken: appSettings.claudeCodeOauthToken,
    });
  } catch (err) {
    console.error('[stream] start_or_resume failed:', err);
  }

  await agentClient.call({ op: 'subscribe', conversationId }).catch(() => {});

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // Initial hydration notice.
      controller.enqueue(encoder.encode(sseFrame({ type: 'hydrated', lastSeq: lastEventId })));

      // Replay missed rows from SQLite before switching to live.
      if (lastEventId > 0) {
        const missed = db
          .select()
          .from(messages)
          .where(eq(messages.conversationId, conversationId))
          .all()
          .filter((r) => r.seq > lastEventId)
          .sort((a, b) => a.seq - b.seq);
        for (const row of missed) {
          const content = JSON.parse(row.content);
          const frame: StreamFrame =
            row.role === 'assistant'
              ? {
                  type: 'assistant_message',
                  conversationId,
                  seq: row.seq,
                  messageId: row.id,
                  content,
                }
              : row.role === 'user'
              ? {
                  type: 'user_message',
                  conversationId,
                  seq: row.seq,
                  messageId: row.id,
                  content,
                }
              : {
                  type: 'system',
                  conversationId,
                  seq: row.seq,
                  payload: content,
                };
          controller.enqueue(encoder.encode(sseFrame(frame)));
        }
      }

      // Subscribe to live frames from the bus.
      const unsub = streamBus.subscribe(conversationId, (frame) => {
        try {
          controller.enqueue(encoder.encode(sseFrame(frame)));
        } catch {
          // client disconnected
        }
      });

      // Heartbeat to keep the connection warm.
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(': heartbeat\n\n'));
        } catch {
          // ignore
        }
      }, 15_000);

      // Cleanup on abort.
      const abort = () => {
        clearInterval(heartbeat);
        unsub();
        agentClient.call({ op: 'unsubscribe', conversationId }).catch(() => {});
        try {
          controller.close();
        } catch {
          // ignore
        }
      };
      req.signal.addEventListener('abort', abort);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
