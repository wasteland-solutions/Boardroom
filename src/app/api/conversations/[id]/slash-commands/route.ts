import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { auth } from '@/lib/auth';
import { agentClient } from '@/lib/agent-client';
import { getDb } from '@/lib/db';
import { conversations } from '@/lib/schema';
import { getSettings } from '@/lib/settings-store';
import type { ModelId, PermissionMode } from '@/lib/types';

export const runtime = 'nodejs';

// GET /api/conversations/:id/slash-commands
//
// Returns the list of slash commands (skills) the active SDK Query for
// this conversation knows about. Used by the composer to drive the `/`
// autocomplete popup. If there's no active session in the worker yet
// we lazily start one so the SDK can introspect.
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { id: conversationId } = await ctx.params;
  const db = getDb();
  const conv = db.select().from(conversations).where(eq(conversations.id, conversationId)).get();
  if (!conv) return NextResponse.json({ error: 'not found' }, { status: 404 });

  // Ensure a session exists so the SDK has something to introspect.
  const appSettings = getSettings();
  await agentClient
    .call({
      op: 'start_or_resume',
      conversationId,
      cwd: conv.cwd,
      model: conv.model as ModelId,
      permissionMode: conv.permissionMode as PermissionMode,
      sdkSessionId: conv.sdkSessionId,
      mcpServers: appSettings.mcpServers,
      permissionTimeoutMs: appSettings.permissionTimeoutMs,
      authMode: appSettings.authMode,
      anthropicApiKey: appSettings.anthropicApiKey,
      claudeCodeOauthToken: appSettings.claudeCodeOauthToken,
    })
    .catch(() => {
      // best-effort — fall through and return an empty list
    });

  const result = (await agentClient
    .call({ op: 'list_slash_commands', conversationId })
    .catch(() => ({ commands: [] }))) as {
    commands: Array<{ name: string; description: string; argumentHint: string }>;
  };

  return NextResponse.json({ commands: result.commands ?? [] });
}
