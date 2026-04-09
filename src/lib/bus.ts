import { EventEmitter } from 'node:events';
import type { StreamFrame } from './types';

// Process-local pub/sub used inside the Next.js runtime to fan `StreamFrame`s
// out to SSE subscribers. The *source* of truth is the agent worker (via the
// agent-client RPC), but the route handler re-publishes received events on
// this bus so that multiple concurrent SSE clients for the same conversation
// each get a copy.
class StreamBus extends EventEmitter {
  publish(conversationId: string, frame: StreamFrame) {
    this.emit(`conv:${conversationId}`, frame);
  }

  subscribe(conversationId: string, listener: (frame: StreamFrame) => void) {
    const key = `conv:${conversationId}`;
    this.on(key, listener);
    return () => this.off(key, listener);
  }
}

// Avoid creating a new bus on every HMR reload in dev.
const globalForBus = globalThis as unknown as { __boardroomBus?: StreamBus };
export const streamBus: StreamBus =
  globalForBus.__boardroomBus ?? (globalForBus.__boardroomBus = new StreamBus());

streamBus.setMaxListeners(1000);
