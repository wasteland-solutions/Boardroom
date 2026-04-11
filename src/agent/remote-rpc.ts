import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';

// JSON-RPC client that speaks the remote control server's protocol over a
// net.Socket (typically connected via SshTunnel to ~/.claude/remote/rpc.sock).
//
// Wire format (validated against actual traffic 2026-04-11):
//
//   Request:  {"jsonrpc":"2.0","id":"<rpc-id>","method":"process.spawn",
//              "auth":"<CLAUDE_RPC_TOKEN>","params":{"id":"<processId>","command":"...","args":[...],"cwd":"..."}}
//
//   Response: {"jsonrpc":"2.0","id":"<rpc-id>","result":{"success":true}}
//
//   Stream:   {"type":"stream","processId":"<processId>","stream":"stdout","data":"<base64>"}
//             {"type":"stream","processId":"<processId>","stream":"exit","exitCode":0}
//
// Key discoveries:
//   - auth is a TOP-LEVEL field (not in params), value is CLAUDE_RPC_TOKEN env var
//   - spawn params use "id" (not "processId") for the client-assigned process ID
//   - stdout/stderr data is BASE64-ENCODED
//   - exit frame uses "exitCode" (not "code") and stream="exit"
//   - stdin/kill params use "processId" for the target process

// --- Wire types ---

interface RpcRequest {
  jsonrpc: '2.0';
  id: string;
  method: string;
  auth: string;
  params: Record<string, unknown>;
}

interface RpcResponse {
  jsonrpc?: '2.0';
  id: string;
  result?: unknown;
  error?: { code?: number; message: string; data?: unknown };
}

// A streaming frame pushed by the server for a spawned process's output.
// The `data` field is base64-encoded.
export interface ProcessFrame {
  processId: string;
  stream: 'stdout' | 'stderr';
  data: string; // base64-encoded
}

// Frame emitted when a spawned process exits.
export interface ProcessExitFrame {
  processId: string;
  stream: 'exit';
  exitCode: number | null;
}

export type RemoteFrame = ProcessFrame | ProcessExitFrame;

type PendingCall = {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
};

const RPC_TIMEOUT_MS = 30_000;
const DEBUG = process.env.BOARDROOM_DEBUG_REMOTE_RPC === '1';

export class RemoteRpcClient extends EventEmitter {
  private pending = new Map<string, PendingCall>();
  private buffer = '';
  private _closed = false;

  constructor(
    private readonly socket: Socket,
    private readonly authToken: string,
  ) {
    super();

    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => this.onData(chunk));
    socket.on('close', () => this.onClose());
    socket.on('error', (err) => {
      console.error('[remote-rpc] socket error:', err.message);
      this.onClose();
    });
  }

  get closed() {
    return this._closed;
  }

  // Start a new CLI process on the remote server.
  // The client generates the processId; the server uses it in stream frames.
  async spawn(
    command: string,
    args: string[],
    cwd: string,
    env?: Record<string, string>,
  ): Promise<string> {
    const processId = randomUUID();
    await this.call('process.spawn', {
      id: processId,
      command,
      args,
      cwd,
      ...(env ? { env } : {}),
    });
    return processId;
  }

  // Write to a spawned process's stdin. The data is base64-encoded before
  // sending (the server expects base64 for both stdin and stdout).
  // Note: all process.* methods use params.id (not params.processId).
  stdin(processId: string, data: string): void {
    const b64 = Buffer.from(data, 'utf8').toString('base64');
    this.send({
      jsonrpc: '2.0',
      id: randomUUID(),
      auth: this.authToken,
      method: 'process.stdin',
      params: { id: processId, data: b64 },
    });
  }

  // Kill a spawned process.
  kill(processId: string): void {
    this.send({
      jsonrpc: '2.0',
      id: randomUUID(),
      auth: this.authToken,
      method: 'process.kill',
      params: { id: processId },
    });
  }

  close() {
    this._closed = true;
    this.socket.destroy();
    this.rejectAll(new Error('Client closed'));
  }

  // --- Private ---

  private async call(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this._closed) throw new Error('RemoteRpcClient is closed');

    const id = randomUUID();
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC timeout: ${method} (${RPC_TIMEOUT_MS}ms)`));
      }, RPC_TIMEOUT_MS);

      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: '2.0', id, auth: this.authToken, method, params });
    });
  }

  private send(msg: RpcRequest): void {
    if (this._closed) return;
    const line = JSON.stringify(msg) + '\n';
    if (DEBUG) console.log('[remote-rpc] →', line.trimEnd());
    this.socket.write(line);
  }

  private onData(chunk: string) {
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      this.handleLine(line);
    }
  }

  private handleLine(line: string) {
    if (DEBUG) console.log('[remote-rpc] ←', line);

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line);
    } catch {
      console.warn('[remote-rpc] ignoring non-JSON line:', line.slice(0, 200));
      return;
    }

    // Is this a response to a pending RPC call?
    if (typeof parsed.id === 'string' && this.pending.has(parsed.id)) {
      const entry = this.pending.get(parsed.id)!;
      this.pending.delete(parsed.id);
      clearTimeout(entry.timer);

      const resp = parsed as unknown as RpcResponse;
      if (resp.error) {
        entry.reject(new Error(resp.error.message ?? 'RPC error'));
      } else {
        entry.resolve(resp.result);
      }
      return;
    }

    // Otherwise it's a streaming frame. Try to classify it.
    const frame = this.parseFrame(parsed);
    if (frame) {
      this.emit('frame', frame);
    }
  }

  // Parse a streaming frame from the server.
  //
  // Wire format:
  //   {"type":"stream","processId":"...","stream":"stdout","data":"<base64>"}
  //   {"type":"stream","processId":"...","stream":"stderr","data":"<base64>"}
  //   {"type":"stream","processId":"...","stream":"exit","exitCode":0}
  private parseFrame(obj: Record<string, unknown>): RemoteFrame | null {
    if (obj.type !== 'stream') return null;

    const processId = obj.processId as string | undefined;
    if (!processId) return null;

    const stream = obj.stream as string | undefined;
    if (!stream) return null;

    // Exit frame.
    if (stream === 'exit') {
      return {
        processId,
        stream: 'exit',
        exitCode: (obj.exitCode as number) ?? null,
      };
    }

    // Data frame (stdout/stderr). Data is base64-encoded.
    if ((stream === 'stdout' || stream === 'stderr') && obj.data !== undefined) {
      return {
        processId,
        stream,
        data: obj.data as string,
      };
    }

    return null;
  }

  private onClose() {
    if (this._closed) return;
    this._closed = true;
    this.rejectAll(new Error('Socket closed'));
    this.emit('disconnect');
  }

  private rejectAll(err: Error) {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
  }
}
