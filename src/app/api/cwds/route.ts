import { NextResponse } from 'next/server';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { cwds } from '@/lib/schema';
import { parseWorkspacePath } from '@/lib/workspace';

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

  // Workspace path can be either an absolute local path OR an ssh:// URI.
  // For local paths we still verify the directory exists; for SSH workspaces
  // we trust the user to know their remote layout (no liveness check on add).
  const ws = parseWorkspacePath(parsed.data.path);
  if (ws.kind === 'invalid') {
    return NextResponse.json({ error: `invalid path: ${ws.reason}` }, { status: 400 });
  }

  let storedPath: string;
  if (ws.kind === 'local') {
    const absolute = resolve(ws.path);
    try {
      const stat = statSync(absolute);
      if (!stat.isDirectory()) {
        return NextResponse.json({ error: 'not a directory' }, { status: 400 });
      }
    } catch {
      return NextResponse.json({ error: 'path does not exist' }, { status: 400 });
    }
    storedPath = absolute;
  } else {
    // Remote workspaces are stored as the original ssh:// URI string.
    storedPath = ws.raw;
  }

  const db = getDb();
  const existing = db.select().from(cwds).where(eq(cwds.path, storedPath)).get();
  if (existing) {
    db.update(cwds).set({ label: parsed.data.label }).where(eq(cwds.path, storedPath)).run();
  } else {
    db.insert(cwds).values({ path: storedPath, label: parsed.data.label }).run();
  }
  return NextResponse.json({ cwd: { path: storedPath, label: parsed.data.label } }, { status: 201 });
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
