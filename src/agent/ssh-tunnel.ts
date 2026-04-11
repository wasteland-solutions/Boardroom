import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createConnection, type Socket } from 'node:net';
import { unlinkSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { sshTarget, type RemoteWorkspace } from '../lib/workspace';

// Manages an SSH tunnel from a local temporary Unix socket to the remote
// `~/.claude/remote/rpc.sock`. The tunnel is an `ssh -N -L` process that
// forwards a local socket to the remote socket.
//
// Usage:
//   const tunnel = new SshTunnel(remote);
//   await tunnel.open();          // establish tunnel
//   const sock = tunnel.connect(); // get a net.Socket to the local endpoint
//   tunnel.close();               // tear down

export class SshTunnel extends EventEmitter {
  private child: ChildProcess | null = null;
  private _isAlive = false;
  private _localSockPath: string;
  private _remoteHome: string | null = null;
  private _rpcToken: string | null = null;
  private _cliPath: string | null = null;

  constructor(private readonly remote: RemoteWorkspace, id: string) {
    super();
    const uid = process.getuid?.() ?? 'x';
    // Hash the conversation id to keep the path short and unique.
    const hash = id.replace(/[^a-zA-Z0-9]/g, '').slice(0, 12);
    this._localSockPath = `/tmp/.boardroom-tunnel-${uid}-${hash}.sock`;
  }

  get isAlive() {
    return this._isAlive;
  }

  get localSockPath() {
    return this._localSockPath;
  }

  // The CLAUDE_RPC_TOKEN that must be sent as the `auth` field in every
  // JSON-RPC request. Resolved during open() from the server process env.
  get rpcToken() {
    return this._rpcToken;
  }

  // Full path to the bundled CLI binary on the remote host.
  // e.g. /home/ubuntu/.claude/remote/ccd-cli/2.1.92
  get cliPath() {
    return this._cliPath;
  }

  async open(): Promise<void> {
    // Step 1: Resolve remote $HOME and CLAUDE_RPC_TOKEN in one SSH call.
    const target = sshTarget(this.remote);
    const info = this.resolveRemoteInfo(target);
    this._remoteHome = info.home;
    this._rpcToken = info.rpcToken;
    this._cliPath = info.cliPath;

    const remoteSock = `${this._remoteHome}/.claude/remote/rpc.sock`;

    // Clean up stale local socket from a prior crash.
    try {
      unlinkSync(this._localSockPath);
    } catch {
      // doesn't exist — fine
    }

    // Step 2: Spawn the tunnel.
    const sshArgs = [
      '-N', // no remote command
      '-L', `${this._localSockPath}:${remoteSock}`,
      '-o', 'BatchMode=yes',
      '-o', 'ServerAliveInterval=15',
      '-o', 'ServerAliveCountMax=3',
      '-o', 'ExitOnForwardFailure=yes',
      '-o', 'StreamLocalBindUnlink=yes',
    ];
    if (this.remote.port) sshArgs.push('-p', String(this.remote.port));
    sshArgs.push(target);

    this.child = spawn('ssh', sshArgs, {
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    const stderrChunks: Buffer[] = [];
    this.child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    this.child.on('exit', (code, signal) => {
      this._isAlive = false;
      const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
      console.error(
        `[ssh-tunnel] exited code=${code ?? 'null'} signal=${signal ?? 'null'}` +
          (stderr ? ` stderr: ${stderr}` : ''),
      );
      this.emit('close', code, signal, stderr);
    });

    // Step 3: Wait for the local socket to become connectable.
    await this.waitForSocket();
    this._isAlive = true;
    console.log(`[ssh-tunnel] tunnel ready: ${this._localSockPath} → ${target}:${remoteSock}`);
  }

  // Returns a net.Socket connected to the local tunnel endpoint.
  connect(): Socket {
    if (!this._isAlive) throw new Error('Tunnel is not open');
    return createConnection(this._localSockPath);
  }

  close() {
    this._isAlive = false;
    if (this.child && !this.child.killed) {
      this.child.kill('SIGTERM');
    }
    this.child = null;
    try {
      unlinkSync(this._localSockPath);
    } catch {
      // ignore
    }
  }

  // Resolve the remote user's $HOME and the CLAUDE_RPC_TOKEN from the
  // running server process in a single SSH call. The token is extracted
  // from /proc/<pid>/environ of the remote server process.
  private resolveRemoteInfo(target: string): { home: string; rpcToken: string; cliPath: string } {
    const args = [
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=10',
    ];
    if (this.remote.port) args.push('-p', String(this.remote.port));
    // Single compound command that outputs three tagged lines:
    //   HOME=/home/user
    //   TOKEN=<uuid>
    //   CLI=/home/user/.claude/remote/ccd-cli/2.1.92
    const remoteCmd = [
      'echo "HOME=$HOME"',
      // Extract CLAUDE_RPC_TOKEN from the running server process env.
      'TOKEN=$(cat /proc/$(pgrep -f "remote/server.*--socket" | head -1)/environ 2>/dev/null | tr "\\0" "\\n" | grep "^CLAUDE_RPC_TOKEN=" | cut -d= -f2)',
      'echo "TOKEN=$TOKEN"',
      // Find the latest bundled CLI binary (highest version number).
      'CLI=$HOME/.claude/remote/ccd-cli/$(ls -1 $HOME/.claude/remote/ccd-cli/ 2>/dev/null | sort -V | tail -1)',
      'echo "CLI=$CLI"',
    ].join(' && ');
    args.push(target, '--', remoteCmd);

    try {
      const result = execFileSync('ssh', args, {
        encoding: 'utf8',
        timeout: 15_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const lines = result.trim().split('\n');
      let home = '';
      let rpcToken = '';
      let cliPath = '';
      for (const line of lines) {
        if (line.startsWith('HOME=')) home = line.slice(5).trim();
        if (line.startsWith('TOKEN=')) rpcToken = line.slice(6).trim();
        if (line.startsWith('CLI=')) cliPath = line.slice(4).trim();
      }
      if (!home || !home.startsWith('/')) {
        throw new Error(`unexpected $HOME: ${home}`);
      }
      if (!rpcToken) {
        throw new Error(
          'Could not find CLAUDE_RPC_TOKEN — is the remote server running? ' +
          'Check if ~/.claude/remote/server is active on the remote host.',
        );
      }
      if (!cliPath) {
        throw new Error(
          'Could not find bundled CLI at ~/.claude/remote/ccd-cli/ on the remote host.',
        );
      }
      return { home, rpcToken, cliPath };
    } catch (err) {
      throw new Error(
        `Failed to resolve remote info on ${target}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  // Poll the local socket until it accepts a connection.
  private waitForSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      const maxAttempts = 100; // 100 × 100ms = 10s
      let attempt = 0;

      const tryConnect = () => {
        attempt++;
        const sock = createConnection(this._localSockPath);
        sock.on('connect', () => {
          sock.destroy();
          resolve();
        });
        sock.on('error', () => {
          sock.destroy();
          if (attempt >= maxAttempts) {
            reject(new Error(`Tunnel socket not ready after ${maxAttempts * 100}ms`));
            return;
          }
          // Check if ssh already exited (failed to bind).
          if (this.child?.exitCode !== null && this.child?.exitCode !== undefined) {
            reject(new Error(`SSH tunnel process exited early with code ${this.child.exitCode}`));
            return;
          }
          setTimeout(tryConnect, 100);
        });
      };

      tryConnect();
    });
  }
}
