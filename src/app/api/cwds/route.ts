import { NextResponse } from 'next/server';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { cwds } from '@/lib/schema';

const AddSchema = z.object({
  path: z.string().min(1),
  label: z.string().min(1).max(200),
});

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const db = getDb();
  return NextResponse.json({ cwds: db.select().from(cwds).all() });
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => null);
  const parsed = AddSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: 'invalid body' }, { status: 400 });

  const absolute = resolve(parsed.data.path);
  try {
    const stat = statSync(absolute);
    if (!stat.isDirectory()) {
      return NextResponse.json({ error: 'not a directory' }, { status: 400 });
    }
  } catch {
    return NextResponse.json({ error: 'path does not exist' }, { status: 400 });
  }

  const db = getDb();
  const existing = db.select().from(cwds).where(eq(cwds.path, absolute)).get();
  if (existing) {
    db.update(cwds).set({ label: parsed.data.label }).where(eq(cwds.path, absolute)).run();
  } else {
    db.insert(cwds).values({ path: absolute, label: parsed.data.label }).run();
  }
  return NextResponse.json({ cwd: { path: absolute, label: parsed.data.label } }, { status: 201 });
}

export async function DELETE(req: Request) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { searchParams } = new URL(req.url);
  const path = searchParams.get('path');
  if (!path) return NextResponse.json({ error: 'path required' }, { status: 400 });
  const db = getDb();
  db.delete(cwds).where(eq(cwds.path, path)).run();
  return NextResponse.json({ ok: true });
}
