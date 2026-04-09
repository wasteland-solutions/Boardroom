import { createServer, type Server, type Socket } from 'node:net';
import { existsSync, unlinkSync } from 'node:fs';
import type { StreamFrame, WorkerEvent, WorkerRpcRequest, WorkerRpcResponse } from '../lib/types';

type Handler = (req: WorkerRpcRequest) => Promise<unknown>;

// Subscription set: which sockets want events for which conversation. Every
// Next.js process gets its own connection, and each SSE route subscribes via
// RPC to the conversations it currently serves.
type Subscriptions = Map<string, Set<Socket>>; // conversationId -> sockets

export class RpcServer {
  private server: Server | null = null;
  private subs: Subscriptions = new Map();
  private sockets = new Set<Socket>();

  constructor(private readonly socketPath: string, private readonly handle: Handler) {}

  async listen(): Promise<void> {
    // On Unix, clean up stale socket file if it exists.
    if (!this.socketPath.startsWith('\\\\') && existsSync(this.socketPath)) {
      try {
        unlinkSync(this.socketPath);
      } catch {
        // ignore
      }
    }

    this.server = createServer((socket) => {
      socket.setEncoding('utf8');
      this.sockets.add(socket);
      let buffer = '';

      socket.on('data', (chunk) => {
        buffer += chunk.toString();
        let nl;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          if (!line.trim()) continue;
          this.handleLine(socket, line).catch((err) => {
            console.error('[rpc] handler error:', err);
          });
        }
      });

      socket.on('close', () => {
        this.sockets.delete(socket);
        for (const set of this.subs.values()) set.delete(socket);
      });
      socket.on('error', (err) => {
        console.error('[rpc] socket error:', err);
      });
    });

    return new Promise((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.socketPath, () => resolve());
    });
  }

  private async handleLine(socket: Socket, line: string) {
    let req: WorkerRpcRequest;
    try {
      req = JSON.parse(line);
    } catch (err) {
      console.error('[rpc] bad json:', err, line);
      return;
    }

    // Intercept subscribe/unsubscribe locally.
    if (req.op === 'subscribe') {
      this.addSub(req.conversationId, socket);
      this.sendResponse(socket, { id: req.id, ok: true });
      return;
    }
    if (req.op === 'unsubscribe') {
      this.removeSub(req.conversationId, socket);
      this.sendResponse(socket, { id: req.id, ok: true });
      return;
    }

    try {
      const result = await this.handle(req);
      this.sendResponse(socket, { id: req.id, ok: true, result });
    } catch (err) {
      this.sendResponse(socket, {
        id: req.id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private sendResponse(socket: Socket, response: WorkerRpcResponse) {
    try {
      socket.write(JSON.stringify(response) + '\n');
    } catch (err) {
      console.error('[rpc] write failed:', err);
    }
  }

  // Broadcast a frame to every socket subscribed to the conversation.
  publish(conversationId: string, frame: StreamFrame) {
    const set = this.subs.get(conversationId);
    if (!set || set.size === 0) return;
    const event: WorkerEvent = { kind: 'event', conversationId, frame };
    const line = JSON.stringify(event) + '\n';
    for (const socket of set) {
      try {
        socket.write(line);
      } catch (err) {
        console.error('[rpc] publish write failed:', err);
      }
    }
  }

  private addSub(conversationId: string, socket: Socket) {
    let set = this.subs.get(conversationId);
    if (!set) {
      set = new Set();
      this.subs.set(conversationId, set);
    }
    set.add(socket);
  }

  private removeSub(conversationId: string, socket: Socket) {
    const set = this.subs.get(conversationId);
    if (!set) return;
    set.delete(socket);
    if (set.size === 0) this.subs.delete(conversationId);
  }

  close() {
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    this.subs.clear();
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    if (!this.socketPath.startsWith('\\\\') && existsSync(this.socketPath)) {
      try {
        unlinkSync(this.socketPath);
      } catch {
        // ignore
      }
    }
  }
}
