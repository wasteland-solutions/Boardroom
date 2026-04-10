import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { agentClient } from '@/lib/agent-client';
import { getDb } from '@/lib/db';
import { conversations } from '@/lib/schema';
import { getSettings } from '@/lib/settings-store';
import type { ModelId, PermissionMode } from '@/lib/types';

const InputSchema = z.union([
  z.object({ type: z.literal('send'), text: z.string().min(1) }),
  z.object({
    type: z.literal('permission_reply'),
    requestId: z.string(),
    decision: z.enum(['allow', 'deny']),
    updatedInput: z.unknown().optional(),
  }),
  z.object({ type: z.literal('interrupt') }),
]);

export async function POST(req: Request, ctx: { params: Promise<{ conversationId: string }> }) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { conversationId } = await ctx.params;
  const body = await req.json().catch(() => null);
  const parsed = InputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid body', issues: parsed.error.issues }, { status: 400 });
  }

  const db = getDb();
  const conv = db.select().from(conversations).where(eq(conversations.id, conversationId)).get();
  if (!conv) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const input = parsed.data;

  if (input.type === 'send') {
    // Lazily start or resume the session in the worker.
    const appSettings = getSettings();
    await agentClient.call({
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
      systemPromptAppend: conv.systemPromptAppend,
      workspaceMemoryFiles: appSettings.workspaceMemoryFiles,
    });
    await agentClient.call({ op: 'send_user_message', conversationId, text: input.text });
    return NextResponse.json({ ok: true });
  }

  if (input.type === 'permission_reply') {
    await agentClient.call({
      op: 'resolve_permission',
      conversationId,
      requestId: input.requestId,
      decision: input.decision,
      updatedInput: input.updatedInput,
    });
    return NextResponse.json({ ok: true });
  }

  // interrupt
  await agentClient.call({ op: 'interrupt', conversationId }).catch(() => {});
  return NextResponse.json({ ok: true });
}
