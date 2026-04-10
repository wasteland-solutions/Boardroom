import { NextResponse } from 'next/server';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { agentClient } from '@/lib/agent-client';
import { getDb } from '@/lib/db';
import { conversations } from '@/lib/schema';
import { DEFAULT_MODELS, type ModelId } from '@/lib/types';
import { claudeProjectSlug, parseWorkspacePath, sshTarget } from '@/lib/workspace';

const PatchSchema = z.object({
  title: z.string().max(200).optional(),
  model: z.enum(DEFAULT_MODELS as [ModelId, ...ModelId[]]).optional(),
  permissionMode: z.enum(['ask', 'acceptEdits', 'bypassPermissions']).optional(),
  archived: z.boolean().optional(),
  systemPromptAppend: z.string().max(8192).nullable().optional(),
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
  if (parsed.data.systemPromptAppend !== undefined) {
    const trimmed = parsed.data.systemPromptAppend?.trim() ?? '';
    update.systemPromptAppend = trimmed.length > 0 ? trimmed : null;
  }

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

  // The SDK has no setSystemPrompt() — to apply a new
  // systemPromptAppend we have to close the session so the next
  // start_or_resume rebuilds the Query with the new system prompt.
  // Resume preserves the conversation history from the persisted
  // sdkSessionId, so the user doesn't lose context.
  if (
    parsed.data.systemPromptAppend !== undefined &&
    (parsed.data.systemPromptAppend?.trim() ?? '') !== (existing.systemPromptAppend ?? '')
  ) {
    await agentClient.call({ op: 'close_session', conversationId: id }).catch(() => {
      // ignore — session may not be active yet
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

  // Look up the conversation BEFORE deleting so we can clean up the
  // backing claude-code session file (local or remote) afterwards.
  const existing = db.select().from(conversations).where(eq(conversations.id, id)).get();
  if (!existing) {
    return NextResponse.json({ ok: true, alreadyGone: true });
  }

  // Tear down any in-flight worker session + pty for this conversation,
  // then drop the row (cascades to messages + pending_permissions).
  await agentClient.call({ op: 'close_session', conversationId: id }).catch(() => {});
  db.delete(conversations).where(eq(conversations.id, id)).run();

  // Best-effort: also remove the on-disk claude-code session transcript
  // so it can't be resumed by accident. Local conversations have the
  // file under ~/.claude/projects on the Boardroom host; remote (SSH)
  // conversations have it on the dev box and require a small ssh + rm.
  // Failures here are logged but never fail the request — the user
  // already accepted that the conversation should disappear.
  if (existing.sdkSessionId) {
    deleteClaudeSessionFile(existing.cwd, existing.sdkSessionId).catch((err) => {
      console.warn(`[delete] session file cleanup failed for ${id}:`, err);
    });
  }

  return NextResponse.json({ ok: true });
}

// Best-effort removal of the claude-code session transcript for a given
// (cwd, sdkSessionId) pair. Local cwds → fs.unlink. Remote cwds → ssh +
// rm with the same ControlMaster pattern as everywhere else. Returns
// once both attempts have either succeeded or been logged as skipped.
async function deleteClaudeSessionFile(cwd: string, sdkSessionId: string): Promise<void> {
  const ws = parseWorkspacePath(cwd);

  if (ws.kind === 'local') {
    const slug = claudeProjectSlug(ws.path);
    const file = join(homedir(), '.claude', 'projects', slug, `${sdkSessionId}.jsonl`);
    try {
      await fs.unlink(file);
      console.log(`[delete] removed local session file: ${file}`);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        console.log(`[delete] session file already gone: ${file}`);
      } else {
        throw err;
      }
    }
    return;
  }

  if (ws.kind === 'remote') {
    const slug = claudeProjectSlug(ws.path);
    const remoteFile = `~/.claude/projects/${slug}/${sdkSessionId}.jsonl`;
    const sshArgs = [
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=10',
      '-o', 'ServerAliveInterval=30',
      '-o', 'ControlMaster=auto',
      '-o', `ControlPath=/tmp/.boardroom-ssh-${process.getuid?.() ?? 'x'}-%C`,
      '-o', 'ControlPersist=10m',
    ];
    if (ws.port) sshArgs.push('-p', String(ws.port));
    sshArgs.push(sshTarget(ws), '--', `rm -f '${remoteFile.replace(/'/g, "'\\''")}'`);

    await new Promise<void>((resolve) => {
      const child = spawn('ssh', sshArgs, { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      child.on('error', (err) => {
        console.warn(`[delete] ssh rm failed: ${err.message}`);
        resolve();
      });
      child.on('exit', (code) => {
        if (code === 0) {
          console.log(`[delete] removed remote session file via ssh: ${remoteFile}`);
        } else {
          console.warn(
            `[delete] ssh rm exited ${code} for ${remoteFile}: ${stderr.trim() || 'no stderr'}`,
          );
        }
        resolve();
      });
    });
  }
}
