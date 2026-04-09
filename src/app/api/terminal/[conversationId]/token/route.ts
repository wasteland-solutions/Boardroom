import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { auth } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { conversations } from '@/lib/schema';
import { mintTerminalToken } from '@/lib/terminal-token';

export const runtime = 'nodejs';

// POST /api/terminal/:conversationId/token
//
// Authenticated endpoint that mints a short-lived HMAC token the browser
// uses as its first message when it opens a WebSocket to the terminal
// server (the agent worker's WS endpoint). The HMAC binds the token to
// this specific conversation id and is verified against AUTH_SECRET —
// which both the Next.js process and the agent worker share.
//
// The response also tells the browser *where* to open the WebSocket. In
// production that's wss://<same host>:AGENT_WORKER_WS_PORT/terminal; in
// dev it's ws://localhost:8099/terminal. The client-side code fills in
// the protocol (ws/wss) and host based on window.location.
export async function POST(_req: Request, ctx: { params: Promise<{ conversationId: string }> }) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { conversationId } = await ctx.params;
  const db = getDb();
  const conv = db.select().from(conversations).where(eq(conversations.id, conversationId)).get();
  if (!conv) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const token = mintTerminalToken(conversationId);
  const wsPort = Number(process.env.AGENT_WORKER_WS_PORT ?? 8099);
  return NextResponse.json({
    token,
    wsPort,
    path: '/terminal',
    cwd: conv.cwd,
  });
}
