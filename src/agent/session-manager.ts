import { ActiveQuery, type StartOptions } from './sdk-runner';
import { CodexSession, type CodexStartOptions } from './codex-runner';
import type { PermissionBroker } from './permission-broker';
import type { StreamFrame, Provider } from '../lib/types';

const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 min

// Unified session interface — both ActiveQuery (claude) and CodexSession
// expose these properties so the session manager and the worker RPC can
// treat them generically.
export type AnySession = {
  readonly conversationId: string;
  readonly isDead: boolean;
  lastActivity: number;
  sendUserText(text: string): void;
  interrupt(): Promise<void> | void;
  close(): void;
  // Optional — only ActiveQuery has these.
  setOnDead?(cb: () => void): void;
  setPermissionMode?(mode: string): Promise<void>;
  setModel?(model: string): Promise<void>;
  listSlashCommands?(): Promise<Array<{ name: string; description: string; argumentHint: string }>>;
};

export class SessionManager {
  private sessions = new Map<string, AnySession>();
  private sweepInterval: NodeJS.Timeout;

  constructor(
    private readonly broker: PermissionBroker,
    private readonly emit: (conversationId: string, frame: StreamFrame) => void,
  ) {
    this.sweepInterval = setInterval(() => this.sweepIdle(), 60_000).unref();
  }

  get(conversationId: string): AnySession | undefined {
    return this.sessions.get(conversationId);
  }

  startOrResume(opts: StartOptions & { provider?: Provider }): AnySession {
    const existing = this.sessions.get(opts.conversationId);
    if (existing && !existing.isDead) return existing;
    if (existing && existing.isDead) {
      this.sessions.delete(opts.conversationId);
    }

    const provider = opts.provider ?? 'claude';

    if (provider === 'codex') {
      const codexOpts: CodexStartOptions = {
        conversationId: opts.conversationId,
        cwd: opts.cwd,
        model: opts.model,
        permissionMode: opts.permissionMode,
      };
      const session = new CodexSession(codexOpts, this.emit);
      this.sessions.set(opts.conversationId, session);
      return session;
    }

    // Default: Claude via the Agent SDK.
    const session = new ActiveQuery(opts, this.broker, this.emit);
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
