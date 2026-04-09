import { resolve } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';

// Manually load .env (we don't want to drag dotenv in for one file).
for (const candidate of [resolve(process.cwd(), '.env')]) {
  if (existsSync(candidate)) {
    for (const line of readFileSync(candidate, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (!m) continue;
      const [, k, v] = m;
      if (process.env[k] === undefined) {
        process.env[k] = v.replace(/^['"]|['"]$/g, '');
      }
    }
    break;
  }
}

// Remember the original ANTHROPIC_API_KEY loaded from .env. `authMode`
// toggles whether we expose it to the spawned Claude Code child or strip it
// so the CLI falls back to its stored OAuth token.
const originalApiKey = process.env.ANTHROPIC_API_KEY;

function applyAuthMode(mode: 'api_key' | 'claude_code') {
  if (mode === 'api_key') {
    if (originalApiKey) process.env.ANTHROPIC_API_KEY = originalApiKey;
  } else {
    delete process.env.ANTHROPIC_API_KEY;
  }
}

import { RpcServer } from './rpc';
import { SessionManager } from './session-manager';
import { PermissionBroker } from './permission-broker';
import type { StreamFrame, WorkerRpcRequest } from '../lib/types';

const socketPath = process.env.AGENT_WORKER_SOCKET ?? './.agent.sock';

// Late-bound reference so the broker can push frames via the rpc server.
let rpc: RpcServer;

const emit = (conversationId: string, frame: StreamFrame) => {
  rpc?.publish(conversationId, frame);
};

const broker = new PermissionBroker(emit);
const sessions = new SessionManager(broker, emit);

async function handle(req: WorkerRpcRequest): Promise<unknown> {
  switch (req.op) {
    case 'ping':
      return { pong: true };

    case 'start_or_resume': {
      applyAuthMode(req.authMode);
      const session = sessions.startOrResume({
        conversationId: req.conversationId,
        cwd: req.cwd,
        model: req.model,
        permissionMode: req.permissionMode,
        sdkSessionId: req.sdkSessionId,
        mcpServers: req.mcpServers,
        permissionTimeoutMs: req.permissionTimeoutMs,
      });
      return { conversationId: session.conversationId };
    }

    case 'send_user_message': {
      const session = sessions.get(req.conversationId);
      if (!session) throw new Error('no active session — start_or_resume first');
      session.sendUserText(req.text);
      return { ok: true };
    }

    case 'set_permission_mode': {
      const session = sessions.get(req.conversationId);
      if (!session) throw new Error('no active session');
      await session.setPermissionMode(req.mode);
      return { ok: true };
    }

    case 'set_model': {
      const session = sessions.get(req.conversationId);
      if (!session) throw new Error('no active session');
      await session.setModel(req.model);
      return { ok: true };
    }

    case 'resolve_permission': {
      const ok = broker.resolve(req.conversationId, req.requestId, req.decision, req.updatedInput);
      return { resolved: ok };
    }

    case 'interrupt': {
      const session = sessions.get(req.conversationId);
      if (!session) throw new Error('no active session');
      await session.interrupt();
      return { ok: true };
    }

    case 'close_session': {
      sessions.close(req.conversationId);
      return { ok: true };
    }

    default:
      throw new Error(`unknown op: ${(req as { op: string }).op}`);
  }
}

async function main() {
  rpc = new RpcServer(socketPath, handle);
  await rpc.listen();
  console.log(`[boardroom-agent] listening on ${socketPath}`);

  const shutdown = (signal: string) => {
    console.log(`[boardroom-agent] ${signal} received, shutting down...`);
    sessions.closeAll();
    rpc.close();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[boardroom-agent] fatal:', err);
  process.exit(1);
});
