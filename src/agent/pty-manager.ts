import * as pty from 'node-pty';
import { eq } from 'drizzle-orm';
import { getDb } from '../lib/db';
import { conversations, cwds as cwdsTable } from '../lib/schema';
import { parseWorkspacePath, sshTarget } from '../lib/workspace';

export type PtyClient = {
  onData: (chunk: string) => void;
  onExit: (code: number) => void;
};

type Session = {
  conversationId: string;
  proc: pty.IPty;
  clients: Set<PtyClient>;
  cwd: string;
  lastActivity: number;
  closeTimer: NodeJS.Timeout | null;
};

const IDLE_TIMEOUT_MS = 60 * 60 * 1000; // 1h with no clients → kill

// Owns the pty child processes. One pty per conversation, spawned in the
// conversation's cwd on first client connection, torn down when the last
// client disconnects (after a grace period so a page reload doesn't kill
// the shell). Clients subscribe with an onData/onExit pair.
export class PtyManager {
  private sessions = new Map<string, Session>();

  // Attach a client to the pty for a given conversation. Spawns the pty if
  // it doesn't already exist. Returns unsubscribe + write + resize handles.
  attach(
    conversationId: string,
    client: PtyClient,
    cols: number,
    rows: number,
  ): {
    write: (data: string) => void;
    resize: (cols: number, rows: number) => void;
    detach: () => void;
    cwd: string;
  } | null {
    const existing = this.sessions.get(conversationId);
    if (existing) {
      if (existing.closeTimer) {
        clearTimeout(existing.closeTimer);
        existing.closeTimer = null;
      }
      existing.clients.add(client);
      existing.lastActivity = Date.now();
      // Resize to the new client's viewport.
      try {
        existing.proc.resize(cols, rows);
      } catch {
        // ignore
      }
      return {
        write: (data) => this.safeWrite(existing, data),
        resize: (c, r) => this.safeResize(existing, c, r),
        detach: () => this.detach(conversationId, client),
        cwd: existing.cwd,
      };
    }

    // Look up the conversation's cwd + validate against the allowlist.
    const db = getDb();
    const conv = db.select().from(conversations).where(eq(conversations.id, conversationId)).get();
    if (!conv) return null;
    const allowed = db.select().from(cwdsTable).where(eq(cwdsTable.path, conv.cwd)).get();
    if (!allowed) return null;

    // For remote (ssh://) workspaces we spawn `ssh -tt` instead of a local
    // shell, so the user lands directly in a real shell session on the
    // remote host. The local pty cwd just needs to be a stable existing
    // dir; we use process.cwd() as a fallback.
    const parsed = parseWorkspacePath(conv.cwd);
    let command: string;
    let args: string[];
    let spawnCwd: string;
    if (parsed.kind === 'remote') {
      command = 'ssh';
      args = [
        '-tt',
        '-o',
        'ServerAliveInterval=30',
        '-o',
        'ServerAliveCountMax=3',
        '-o',
        'ControlMaster=auto',
        '-o',
        `ControlPath=/tmp/.boardroom-ssh-${process.getuid?.() ?? 'x'}-%C`,
        '-o',
        'ControlPersist=10m',
      ];
      if (parsed.port) {
        args.push('-p', String(parsed.port));
      }
      args.push(sshTarget(parsed));
      // After login, cd into the remote workspace before handing the
      // session to the user. The remote shell is still interactive
      // because we exec the user's $SHELL with -i.
      args.push('--', `cd ${shellQuote(parsed.path)} && exec $SHELL -l`);
      spawnCwd = process.cwd();
    } else {
      command = process.env.SHELL || '/bin/bash';
      args = [];
      spawnCwd = parsed.kind === 'local' ? parsed.path : conv.cwd;
    }

    let proc: pty.IPty;
    try {
      proc = pty.spawn(command, args, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: spawnCwd,
        env: {
          ...process.env,
          TERM: 'xterm-256color',
          BOARDROOM: '1',
        },
      });
    } catch (err) {
      console.error(`[pty-manager] failed to spawn pty for ${conversationId}:`, err);
      return null;
    }

    const session: Session = {
      conversationId,
      proc,
      clients: new Set([client]),
      cwd: conv.cwd,
      lastActivity: Date.now(),
      closeTimer: null,
    };
    this.sessions.set(conversationId, session);

    proc.onData((chunk) => {
      session.lastActivity = Date.now();
      for (const c of session.clients) {
        try {
          c.onData(chunk);
        } catch (err) {
          console.error('[pty-manager] client.onData threw:', err);
        }
      }
    });

    proc.onExit(({ exitCode }) => {
      for (const c of session.clients) {
        try {
          c.onExit(exitCode);
        } catch {
          // ignore
        }
      }
      session.clients.clear();
      this.sessions.delete(conversationId);
      console.log(`[pty-manager] pty exited for ${conversationId} (code ${exitCode})`);
    });

    console.log(`[pty-manager] spawned ${command} ${args.join(' ')} for ${conversationId} in ${conv.cwd}`);
    return {
      write: (data) => this.safeWrite(session, data),
      resize: (c, r) => this.safeResize(session, c, r),
      detach: () => this.detach(conversationId, client),
      cwd: conv.cwd,
    };
  }

  private detach(conversationId: string, client: PtyClient) {
    const session = this.sessions.get(conversationId);
    if (!session) return;
    session.clients.delete(client);
    if (session.clients.size === 0) {
      // Give the user 30s to reconnect (page reload, brief disconnect).
      session.closeTimer = setTimeout(() => {
        // If still empty AND idle, kill the pty.
        const s = this.sessions.get(conversationId);
        if (!s || s.clients.size > 0) return;
        if (Date.now() - s.lastActivity > IDLE_TIMEOUT_MS) {
          this.kill(conversationId);
        } else {
          // Schedule another check later instead of dropping the timer.
          s.closeTimer = setTimeout(() => this.maybeIdleKill(conversationId), IDLE_TIMEOUT_MS);
        }
      }, 30_000);
    }
  }

  private maybeIdleKill(conversationId: string) {
    const s = this.sessions.get(conversationId);
    if (!s) return;
    if (s.clients.size > 0) return;
    if (Date.now() - s.lastActivity >= IDLE_TIMEOUT_MS) {
      this.kill(conversationId);
    }
  }

  kill(conversationId: string) {
    const s = this.sessions.get(conversationId);
    if (!s) return;
    try {
      s.proc.kill();
    } catch {
      // ignore
    }
    if (s.closeTimer) clearTimeout(s.closeTimer);
    this.sessions.delete(conversationId);
  }

  killAll() {
    for (const id of Array.from(this.sessions.keys())) this.kill(id);
  }

  private safeWrite(session: Session, data: string) {
    session.lastActivity = Date.now();
    try {
      session.proc.write(data);
    } catch (err) {
      console.error('[pty-manager] write error:', err);
    }
  }

  private safeResize(session: Session, cols: number, rows: number) {
    try {
      session.proc.resize(cols, rows);
    } catch (err) {
      console.error('[pty-manager] resize error:', err);
    }
  }
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

export const ptyManager = new PtyManager();
