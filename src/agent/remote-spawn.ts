import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import type { SpawnOptions as SdkSpawnOptions, SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';
import { SshTunnel } from './ssh-tunnel';
import { RemoteRpcClient, type ProcessFrame, type ProcessExitFrame, type RemoteFrame } from './remote-rpc';
import type { RemoteWorkspace } from '../lib/workspace';

// Creates a SpawnedProcess that satisfies the Agent SDK's interface by
// bridging stdin/stdout through the remote control server's RPC protocol.
//
// This must be SYNCHRONOUS — the SDK calls spawnClaudeCodeProcess and
// immediately starts reading stdout. We return the RemoteProcess immediately
// and spawn the remote process in the background; stdin writes and stdout
// reads are buffered until the spawn completes.

export function spawnRemoteClaude(
  remote: RemoteWorkspace,
  tunnel: SshTunnel,
  sdkOpts: SdkSpawnOptions,
): SpawnedProcess {
  const authToken = tunnel.rpcToken;
  if (!authToken) throw new Error('No CLAUDE_RPC_TOKEN resolved from remote');
  const cliPath = tunnel.cliPath;
  if (!cliPath) throw new Error('No bundled CLI path resolved from remote');

  const socket = tunnel.connect();
  const rpc = new RemoteRpcClient(socket, authToken);

  // Filter out local script paths — we use the remote's bundled CLI.
  const cliFlags = sdkOpts.args.filter(
    (a) => !(/^\//.test(a) && /\.(m?js|cjs)$/.test(a)),
  );

  // Return the process wrapper immediately. It spawns asynchronously
  // and buffers stdin until ready.
  return new RemoteProcess(rpc, cliPath, cliFlags, remote, sdkOpts.signal);
}

// Wraps the remote server's RPC protocol as a SpawnedProcess. The SDK
// writes to stdin and reads from stdout as if it were a local child process.
class RemoteProcess extends EventEmitter implements SpawnedProcess {
  public readonly stdin: Writable;
  public readonly stdout: Readable;
  private _killed = false;
  private _exitCode: number | null = null;
  private processId: string | null = null;
  // Buffer stdin writes until the spawn RPC completes.
  private pendingStdin: string[] = [];
  private spawnReady = false;

  constructor(
    private readonly rpc: RemoteRpcClient,
    cliPath: string,
    cliFlags: string[],
    remote: RemoteWorkspace,
    signal: AbortSignal,
  ) {
    super();

    // Writable stdin → rpc.stdin (base64-encoded by RemoteRpcClient).
    this.stdin = new Writable({
      write: (chunk: Buffer | string, _encoding, callback) => {
        if (this._killed || this.rpc.closed) {
          callback(new Error('Process is dead'));
          return;
        }
        const data = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        if (this.spawnReady && this.processId) {
          this.rpc.stdin(this.processId, data);
        } else {
          this.pendingStdin.push(data);
        }
        callback();
      },
    });

    // Readable stdout ← rpc frame events (base64-decoded here).
    this.stdout = new Readable({
      read() {}, // push-based
    });

    // Listen for frames.
    this.rpc.on('frame', (frame: RemoteFrame) => this.onFrame(frame));
    this.rpc.on('disconnect', () => {
      if (!this._killed) {
        this._killed = true;
        this._exitCode = 1;
        this.stdout.push(null);
        this.emit('exit', 1, null);
      }
    });

    // Wire abort signal.
    const onAbort = () => this.kill('SIGTERM');
    signal.addEventListener('abort', onAbort, { once: true });

    // Spawn the remote process asynchronously.
    this.rpc.spawn(cliPath, cliFlags, remote.path).then(
      (pid) => {
        this.processId = pid;
        this.spawnReady = true;
        console.log(`[remote-spawn] spawned process ${pid} on ${remote.host}:${remote.path}`);
        // Flush buffered stdin.
        for (const data of this.pendingStdin) {
          this.rpc.stdin(pid, data);
        }
        this.pendingStdin = [];
      },
      (err) => {
        console.error('[remote-spawn] spawn failed:', err);
        this._killed = true;
        this._exitCode = 1;
        this.stdout.push(null);
        this.emit('error', err instanceof Error ? err : new Error(String(err)));
        this.emit('exit', 1, null);
      },
    );
  }

  get killed() {
    return this._killed;
  }

  get exitCode() {
    return this._exitCode;
  }

  kill(signal: NodeJS.Signals): boolean {
    if (this._killed) return false;
    this._killed = true;
    if (this.processId) {
      this.rpc.kill(this.processId);
    }
    return true;
  }

  private onFrame(frame: RemoteFrame) {
    if (this.processId && frame.processId !== this.processId) return;
    // Before spawn completes, accept all frames (there should be none, but be safe).
    if (!this.processId && frame.processId) return;

    if (frame.stream === 'exit') {
      const exitFrame = frame as ProcessExitFrame;
      this._exitCode = exitFrame.exitCode;
      this._killed = true;
      this.stdout.push(null);
      this.emit('exit', exitFrame.exitCode, null);
      this.rpc.close();
      return;
    }

    const dataFrame = frame as ProcessFrame;
    if (dataFrame.stream === 'stdout') {
      const decoded = Buffer.from(dataFrame.data, 'base64');
      this.stdout.push(decoded);
    }
  }
}
