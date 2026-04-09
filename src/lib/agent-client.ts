import { createConnection, type Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { streamBus } from './bus';
import type {
  WorkerEvent,
  WorkerRpcRequest,
  WorkerRpcRequestBody,
  WorkerRpcResponse,
  StreamFrame,
} from './types';

type PendingCall = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
};

// Long-lived JSONL client for the Next.js runtime. Exactly one socket is
// opened per Next.js process, and RPC calls are multiplexed over it by `id`.
// Worker-pushed events land on the `streamBus` so SSE routes can re-emit them.
class AgentClient {
  private socket: Socket | null = null;
  private connecting: Promise<Socket> | null = null;
  private pending = new Map<string, PendingCall>();
  private buffer = '';

  private get socketPath() {
    return process.env.AGENT_WORKER_SOCKET ?? './.agent.sock';
  }

  private async connect(): Promise<Socket> {
    if (this.socket && !this.socket.destroyed) return this.socket;
    if (this.connecting) return this.connecting;

    this.connecting = new Promise((resolve, reject) => {
      const sock = createConnection(this.socketPath);
      sock.setEncoding('utf8');
      sock.once('connect', () => {
        this.socket = sock;
        this.connecting = null;
        resolve(sock);
      });
      sock.once('error', (err) => {
        this.connecting = null;
        reject(err);
      });
      sock.on('data', (chunk) => this.onData(chunk.toString()));
      sock.on('close', () => {
        this.socket = null;
        for (const [, p] of this.pending) p.reject(new Error('worker socket closed'));
        this.pending.clear();
      });
    });
    return this.connecting;
  }

  private onData(chunk: string) {
    this.buffer += chunk;
    let newlineIdx;
    while ((newlineIdx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newlineIdx);
      this.buffer = this.buffer.slice(newlineIdx + 1);
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line) as WorkerRpcResponse | WorkerEvent;
        if ('kind' in msg && msg.kind === 'event') {
          streamBus.publish(msg.conversationId, msg.frame as StreamFrame);
        } else {
          const response = msg as WorkerRpcResponse;
          const pending = this.pending.get(response.id);
          if (!pending) continue;
          this.pending.delete(response.id);
          if (response.ok) pending.resolve(response.result);
          else pending.reject(new Error(response.error));
        }
      } catch (err) {
        console.error('[agent-client] bad frame from worker:', err, line);
      }
    }
  }

  async call<T = unknown>(req: WorkerRpcRequestBody): Promise<T> {
    const socket = await this.connect();
    const id = randomUUID();
    const fullReq = { id, ...req } as WorkerRpcRequest;

    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
      });
      socket.write(JSON.stringify(fullReq) + '\n', (err) => {
        if (err) {
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }
}

const globalForClient = globalThis as unknown as { __boardroomAgentClient?: AgentClient };
export const agentClient: AgentClient =
  globalForClient.__boardroomAgentClient ?? (globalForClient.__boardroomAgentClient = new AgentClient());
