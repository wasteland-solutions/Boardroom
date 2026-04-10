import { ActiveQuery, type StartOptions } from './sdk-runner';
import type { PermissionBroker } from './permission-broker';
import type { StreamFrame } from '../lib/types';

const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 min

export class SessionManager {
  private sessions = new Map<string, ActiveQuery>();
  private sweepInterval: NodeJS.Timeout;

  constructor(
    private readonly broker: PermissionBroker,
    private readonly emit: (conversationId: string, frame: StreamFrame) => void,
  ) {
    this.sweepInterval = setInterval(() => this.sweepIdle(), 60_000).unref();
  }

  get(conversationId: string): ActiveQuery | undefined {
    return this.sessions.get(conversationId);
  }

  startOrResume(opts: StartOptions): ActiveQuery {
    const existing = this.sessions.get(opts.conversationId);
    if (existing && !existing.isDead) return existing;
    if (existing && existing.isDead) {
      // Drop the corpse so we spawn a fresh one below.
      this.sessions.delete(opts.conversationId);
    }
    const session = new ActiveQuery(opts, this.broker, this.emit);
    // Self-evict on reader-loop crash so the next start_or_resume creates
    // a fresh ActiveQuery with a fresh child process.
    session.setOnDead(() => {
      const current = this.sessions.get(opts.conversationId);
      if (current === session) this.sessions.delete(opts.conversationId);
    });
    this.sessions.set(opts.conversationId, session);
    return session;
  }

  close(conversationId: string) {
    const s = this.sessions.get(conversationId);
    if (!s) return;
    s.close();
    this.sessions.delete(conversationId);
  }

  closeAll() {
    clearInterval(this.sweepInterval);
    for (const [id] of this.sessions) this.close(id);
  }

  private sweepIdle() {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (now - session.lastActivity > IDLE_TIMEOUT_MS) {
        console.log(`[session-manager] idle-timeout ${id}`);
        this.close(id);
      }
    }
  }
}
