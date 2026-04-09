import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb } from '../lib/db';
import { pendingPermissions } from '../lib/schema';
import { persistence } from './persistence';
import type { StreamFrame } from '../lib/types';

type Decision =
  | { behavior: 'allow'; updatedInput: Record<string, unknown> }
  | { behavior: 'deny'; message: string; interrupt?: boolean };

type PendingEntry = {
  resolve: (d: Decision) => void;
  timer: NodeJS.Timeout | null;
  conversationId: string;
};

// Owns pending canUseTool Promises. When the SDK asks for permission we:
//   1. insert a row in `pending_permissions`
//   2. publish a `permission_request` frame via `emit`
//   3. return a Promise that resolves when the user replies or the timeout
//      fires — whichever comes first (atomic check).
export class PermissionBroker {
  private pending = new Map<string, PendingEntry>();
  private emitter: (conversationId: string, frame: StreamFrame) => void;

  constructor(emitter: (conversationId: string, frame: StreamFrame) => void) {
    this.emitter = emitter;
  }

  // This is the function passed as `canUseTool` to the SDK. It's bound per
  // conversation so we know which `conversationId` it belongs to.
  createCallback(conversationId: string, timeoutMs: number) {
    return async (
      toolName: string,
      input: Record<string, unknown>,
      extra: { signal: AbortSignal; suggestions?: unknown },
    ): Promise<Decision> => {
      const requestId = randomUUID();
      const db = getDb();
      db.insert(pendingPermissions)
        .values({
          id: requestId,
          conversationId,
          toolName,
          input: JSON.stringify(input),
          status: 'pending',
        })
        .run();

      const seq = persistence.nextSeq(conversationId);
      this.emitter(conversationId, {
        type: 'permission_request',
        conversationId,
        seq,
        requestId,
        toolName,
        input,
        suggestions: extra.suggestions,
      });

      return new Promise<Decision>((resolve) => {
        const entry: PendingEntry = {
          conversationId,
          timer: null,
          resolve: (d) => {
            if (!this.pending.has(requestId)) return; // already settled
            this.pending.delete(requestId);
            if (entry.timer) clearTimeout(entry.timer);
            resolve(d);
          },
        };

        // Signal-driven cancellation (Stop button).
        const onAbort = () => {
          this.markResolved(requestId, 'denied');
          const resolvedSeq = persistence.nextSeq(conversationId);
          this.emitter(conversationId, {
            type: 'permission_resolved',
            conversationId,
            seq: resolvedSeq,
            requestId,
            decision: 'deny',
          });
          entry.resolve({ behavior: 'deny', message: 'User interrupted', interrupt: true });
        };
        extra.signal.addEventListener('abort', onAbort, { once: true });

        // Timeout (auto-deny + interrupt).
        if (timeoutMs > 0) {
          entry.timer = setTimeout(() => {
            this.markResolved(requestId, 'expired');
            const resolvedSeq = persistence.nextSeq(conversationId);
            this.emitter(conversationId, {
              type: 'permission_resolved',
              conversationId,
              seq: resolvedSeq,
              requestId,
              decision: 'expired',
            });
            entry.resolve({ behavior: 'deny', message: 'Permission request timed out', interrupt: true });
          }, timeoutMs);
        }

        this.pending.set(requestId, entry);
      });
    };
  }

  // Called by RPC when the user clicks Approve / Deny in the UI.
  resolve(conversationId: string, requestId: string, decision: 'allow' | 'deny', updatedInput?: unknown) {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    if (entry.conversationId !== conversationId) return false;

    this.markResolved(requestId, decision === 'allow' ? 'allowed' : 'denied');
    const seq = persistence.nextSeq(conversationId);
    this.emitter(conversationId, {
      type: 'permission_resolved',
      conversationId,
      seq,
      requestId,
      decision,
    });

    if (decision === 'allow') {
      entry.resolve({
        behavior: 'allow',
        updatedInput: (updatedInput as Record<string, unknown>) ?? {},
      });
    } else {
      entry.resolve({ behavior: 'deny', message: 'User denied', interrupt: false });
    }
    return true;
  }

  // Called when a session is torn down — reject any outstanding prompts.
  clearForConversation(conversationId: string) {
    for (const [id, entry] of this.pending) {
      if (entry.conversationId === conversationId) {
        this.markResolved(id, 'denied');
        entry.resolve({ behavior: 'deny', message: 'Session closed', interrupt: true });
      }
    }
  }

  private markResolved(requestId: string, status: 'allowed' | 'denied' | 'expired') {
    const db = getDb();
    db.update(pendingPermissions)
      .set({ status, resolvedAt: Date.now() })
      .where(eq(pendingPermissions.id, requestId))
      .run();
  }
}
