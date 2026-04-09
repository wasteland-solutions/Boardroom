import { NextResponse } from 'next/server';
import { asc, eq } from 'drizzle-orm';
import { auth } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { messages } from '@/lib/schema';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { id } = await ctx.params;
  const db = getDb();
  const rows = db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, id))
    .orderBy(asc(messages.seq))
    .all();

  // Parse JSON columns before returning.
  const hydrated = rows.map((r) => ({
    ...r,
    content: JSON.parse(r.content),
    toolCalls: r.toolCalls ? JSON.parse(r.toolCalls) : null,
  }));
  return NextResponse.json({ messages: hydrated });
}
