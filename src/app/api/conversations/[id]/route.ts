import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { agentClient } from '@/lib/agent-client';
import { getDb } from '@/lib/db';
import { conversations } from '@/lib/schema';
import { DEFAULT_MODELS, type ModelId } from '@/lib/types';

const PatchSchema = z.object({
  title: z.string().max(200).optional(),
  model: z.enum(DEFAULT_MODELS as [ModelId, ...ModelId[]]).optional(),
  permissionMode: z.enum(['ask', 'acceptEdits', 'bypassPermissions']).optional(),
  archived: z.boolean().optional(),
});

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { id } = await ctx.params;
  const db = getDb();
  const row = db.select().from(conversations).where(eq(conversations.id, id)).get();
  if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ conversation: row });
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { id } = await ctx.params;
  const body = await req.json().catch(() => null);
  const parsed = PatchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid body' }, { status: 400 });
  }

  const db = getDb();
  const existing = db.select().from(conversations).where(eq(conversations.id, id)).get();
  if (!existing) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const update: Partial<typeof conversations.$inferInsert> = { updatedAt: Date.now() };
  if (parsed.data.title !== undefined) update.title = parsed.data.title;
  if (parsed.data.model !== undefined) update.model = parsed.data.model;
  if (parsed.data.permissionMode !== undefined) update.permissionMode = parsed.data.permissionMode;
  if (parsed.data.archived !== undefined) update.archived = parsed.data.archived;

  db.update(conversations).set(update).where(eq(conversations.id, id)).run();

  // Hot-apply model / permission mode if the session is active.
  if (parsed.data.model && parsed.data.model !== existing.model) {
    await agentClient
      .call({ op: 'set_model', conversationId: id, model: parsed.data.model })
      .catch(() => {
        // session may not be active yet — ignore
      });
  }
  if (parsed.data.permissionMode && parsed.data.permissionMode !== existing.permissionMode) {
    await agentClient
      .call({ op: 'set_permission_mode', conversationId: id, mode: parsed.data.permissionMode })
      .catch(() => {
        // session may not be active yet — ignore
      });
  }

  // Archiving → tear down the SDK session and the terminal pty so we
  // aren't holding resources for work that's "done". Unarchiving does
  // nothing at the worker level — the session will be recreated lazily
  // on the next send or stream attach.
  if (parsed.data.archived === true && !existing.archived) {
    await agentClient.call({ op: 'close_session', conversationId: id }).catch(() => {
      // ignore
    });
  }

  const updated = db.select().from(conversations).where(eq(conversations.id, id)).get();
  return NextResponse.json({ conversation: updated });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { id } = await ctx.params;
  const db = getDb();
  db.delete(conversations).where(eq(conversations.id, id)).run();
  await agentClient.call({ op: 'close_session', conversationId: id }).catch(() => {});
  return NextResponse.json({ ok: true });
}
