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

// Remember the original ANTHROPIC_API_KEY loaded from .env. It's used only
// as a fallback when the user hasn't pasted an API key into Settings.
const envApiKey = process.env.ANTHROPIC_API_KEY;

// Apply the credentials the user configured in Settings to process.env
// *before* spawning the Claude Code child. The SDK forwards process.env to
// the child, which reads these two vars to decide how to authenticate.
//
// - api_key mode: ANTHROPIC_API_KEY is set to whatever the UI provided,
//   falling back to the value loaded from .env. CLAUDE_CODE_OAUTH_TOKEN is
//   cleared so the CLI doesn't try to prefer OAuth.
// - claude_code mode: CLAUDE_CODE_OAUTH_TOKEN is set to whatever the UI
//   provided (produced by running `claude setup-token` on a machine with a
//   Claude subscription). ANTHROPIC_API_KEY is cleared so the CLI doesn't
//   prefer the Console billing path.
function applyCredentials(opts: {
  mode: 'api_key' | 'claude_code';
  anthropicApiKey: string;
  claudeCodeOauthToken: string;
}) {
  if (opts.mode === 'api_key') {
    const key = opts.anthropicApiKey || envApiKey || '';
    if (key) process.env.ANTHROPIC_API_KEY = key;
    else delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  } else {
    delete process.env.ANTHROPIC_API_KEY;
    if (opts.claudeCodeOauthToken) {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = opts.claudeCodeOauthToken;
    } else {
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    }
  }
}

import { RpcServer } from './rpc';
import { SessionManager } from './session-manager';
import { PermissionBroker } from './permission-broker';
import { TerminalWsServer } from './ws-server';
import { ptyManager } from './pty-manager';
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
      applyCredentials({
        mode: req.authMode,
        anthropicApiKey: req.anthropicApiKey,
        claudeCodeOauthToken: req.claudeCodeOauthToken,
      });
      const session = sessions.startOrResume({
        conversationId: req.conversationId,
        cwd: req.cwd,
        provider: req.provider,
        model: req.model,
        permissionMode: req.permissionMode,
        sdkSessionId: req.sdkSessionId,
        mcpServers: req.mcpServers,
        permissionTimeoutMs: req.permissionTimeoutMs,
        systemPromptAppend: req.systemPromptAppend,
        workspaceMemoryFiles: req.workspaceMemoryFiles,
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
      if (session.setPermissionMode) await session.setPermissionMode(req.mode);
      return { ok: true };
    }

    case 'set_model': {
      const session = sessions.get(req.conversationId);
      if (!session) throw new Error('no active session');
      if (session.setModel) await session.setModel(req.model);
      return { ok: true };
    }

    case 'resolve_permission': {
      const ok = broker.resolve(req.conversationId, req.requestId, req.decision, req.updatedInput);
      return { resolved: ok };
    }

    case 'interrupt': {
      const session = sessions.get(req.conversationId);
      if (!session) return { ok: true, noSession: true };
      if (session.isDead) return { ok: true, wasDead: true };
      await session.interrupt();
      return { ok: true };
    }

    case 'close_session': {
      sessions.close(req.conversationId);
      ptyManager.kill(req.conversationId);
      return { ok: true };
    }

    case 'list_slash_commands': {
      const session = sessions.get(req.conversationId);
      if (!session || !session.listSlashCommands) return { commands: [] };
      const commands = await session.listSlashCommands();
      return { commands };
    }

    default:
      throw new Error(`unknown op: ${(req as { op: string }).op}`);
  }
}

// Safety net: a buggy SDK code path or a misbehaving Claude child can throw
// inside a microtask that we don't have a handle on (e.g. the SDK's internal
// stream pump writing to a transport whose child has already exited). The
// default Node behavior is to crash the worker, which kills *every* active
// session — terrible UX. We log + keep going. Individual ActiveQuery
// instances mark themselves dead in their reader-loop catch handlers, so
// the affected conversation gets a clear error and the worker stays up.
process.on('unhandledRejection', (reason) => {
  console.error('[boardroom-agent] unhandledRejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[boardroom-agent] uncaughtException:', err);
});

async function main() {
  rpc = new RpcServer(socketPath, handle);
  await rpc.listen();
  console.log(`[boardroom-agent] listening on ${socketPath}`);

  // Terminal WebSocket server — separate port so it can be exposed in
  // docker-compose independently. Default 8099.
  const wsPort = Number(process.env.AGENT_WORKER_WS_PORT ?? 8099);
  const wsServer = new TerminalWsServer(wsPort);
  try {
    await wsServer.listen();
  } catch (err) {
    console.error('[boardroom-agent] failed to start terminal WebSocket:', err);
  }

  const shutdown = (signal: string) => {
    console.log(`[boardroom-agent] ${signal} received, shutting down...`);
    sessions.closeAll();
    wsServer.close();
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
