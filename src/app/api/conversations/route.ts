import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { conversations, cwds } from '@/lib/schema';
import { getSettings } from '@/lib/settings-store';
import { DEFAULT_MODELS, type ModelId, type PermissionMode } from '@/lib/types';

type Scope = 'active' | 'archived' | 'all';

const CreateSchema = z.object({
  title: z.string().max(200).optional(),
  cwd: z.string().min(1),
  model: z.enum(DEFAULT_MODELS as [ModelId, ...ModelId[]]).optional(),
  permissionMode: z.enum(['ask', 'acceptEdits', 'bypassPermissions']).optional(),
  systemPromptAppend: z.string().max(8192).optional(),
});

export async function GET(req: Request) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const scopeParam = searchParams.get('scope');
  const scope: Scope =
    scopeParam === 'archived' || scopeParam === 'all' ? (scopeParam as Scope) : 'active';

  const db = getDb();
  const all = db.select().from(conversations).orderBy(desc(conversations.updatedAt)).all();
  const rows =
    scope === 'all'
      ? all
      : scope === 'archived'
      ? all.filter((c) => c.archived)
      : all.filter((c) => !c.archived);

  return NextResponse.json({ conversations: rows });
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => null);
  const parsed = CreateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid body', issues: parsed.error.issues }, { status: 400 });
  }

  const db = getDb();
  // cwd must be in the allowlist
  const allowed = db.select().from(cwds).where(eq(cwds.path, parsed.data.cwd)).get();
  if (!allowed) {
    return NextResponse.json({ error: 'cwd not allowed' }, { status: 400 });
  }

  const settings = getSettings();
  const id = randomUUID();
  const now = Date.now();
  db.insert(conversations)
    .values({
      id,
      title: parsed.data.title ?? null,
      cwd: parsed.data.cwd,
      model: parsed.data.model ?? settings.defaultModel,
      permissionMode: (parsed.data.permissionMode ?? settings.defaultPermissionMode) as PermissionMode,
      sdkSessionId: null,
      systemPromptAppend: parsed.data.systemPromptAppend?.trim() || null,
      createdAt: now,
      updatedAt: now,
      archived: false,
    })
    .run();

  const created = db.select().from(conversations).where(eq(conversations.id, id)).get();
  return NextResponse.json({ conversation: created }, { status: 201 });
}
