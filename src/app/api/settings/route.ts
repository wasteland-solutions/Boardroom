import { NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { getSettings, updateSettings } from '@/lib/settings-store';
import { DEFAULT_MODELS, type ModelId } from '@/lib/types';

const McpServerSchema = z.union([
  z.object({
    type: z.literal('stdio'),
    command: z.string(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string()).optional(),
  }),
  z.object({ type: z.literal('http'), url: z.string().url(), headers: z.record(z.string()).optional() }),
  z.object({ type: z.literal('sse'), url: z.string().url(), headers: z.record(z.string()).optional() }),
]);

const PatchSchema = z.object({
  authMode: z.enum(['api_key', 'claude_code']).optional(),
  anthropicApiKey: z.string().max(512).optional(),
  claudeCodeOauthToken: z.string().max(4096).optional(),
  defaultModel: z.enum(DEFAULT_MODELS as [ModelId, ...ModelId[]]).optional(),
  defaultPermissionMode: z.enum(['ask', 'acceptEdits', 'bypassPermissions']).optional(),
  mcpServers: z.record(McpServerSchema).optional(),
  permissionTimeoutMs: z.number().int().min(0).max(24 * 60 * 60 * 1000).optional(),
  oidcIssuerUrl: z.string().max(512).optional(),
  oidcClientId: z.string().max(512).optional(),
  oidcClientSecret: z.string().max(512).optional(),
  oidcAllowedEmail: z.string().max(256).optional(),
});

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  return NextResponse.json({ settings: getSettings() });
}

export async function PUT(req: Request) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => null);
  const parsed = PatchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid body', issues: parsed.error.issues }, { status: 400 });
  }
  const updated = updateSettings(parsed.data);
  return NextResponse.json({ settings: updated });
}
