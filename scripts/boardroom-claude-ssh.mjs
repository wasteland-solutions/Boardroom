#!/usr/bin/env node
// SSH bridge wrapper for the Claude Agent SDK.
//
// The SDK has a `pathToClaudeCodeExecutable` option that lets us substitute
// our own binary for the bundled claude CLI. We point it at this script
// when a conversation is bound to a remote SSH workspace. The SDK then
// spawns this script with whatever args/stdio it would have used for the
// real claude — and we forward all of that across an SSH ControlMaster
// connection to a real claude on the remote host.
//
// Required env vars (set by src/agent/sdk-runner.ts before spawning):
//   BOARDROOM_SSH_HOST   the user@host string ssh accepts
//   BOARDROOM_SSH_CWD    absolute remote directory to cd into
// Optional:
//   BOARDROOM_SSH_PORT   ssh port if non-default
//   CLAUDE_CODE_OAUTH_TOKEN   forwarded to the remote claude via the
//                             LC_BOARDROOM_TOKEN env smuggling trick
//                             (most sshd configs `AcceptEnv LC_*`)
//
// Caveats — see README for the full list:
//   - The remote sshd needs `AcceptEnv LC_*` for OAuth token forwarding.
//     Without it, the remote claude will fall back to whatever auth lives
//     in ~/.claude on the remote host.
//   - claude must be on PATH for the remote login shell.
//   - The SSH key auth must be non-interactive (BatchMode=yes is set).
//   - The remote claude version should be compatible with the local SDK.

import { spawn } from 'node:child_process';

const host = process.env.BOARDROOM_SSH_HOST;
const remoteCwd = process.env.BOARDROOM_SSH_CWD;
const port = process.env.BOARDROOM_SSH_PORT;
const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;

if (!host || !remoteCwd) {
  process.stderr.write(
    '[boardroom-ssh] BOARDROOM_SSH_HOST and BOARDROOM_SSH_CWD must be set\n',
  );
  process.exit(2);
}

// Single-quote a string for safe inclusion in a remote sh command.
function shq(s) {
  return `'${String(s).replace(/'/g, "'\\''")}'`;
}

const passthroughArgs = process.argv.slice(2);
const remoteArgString = passthroughArgs.map(shq).join(' ');

// Build the remote command. We unwrap the smuggled token (if any) into the
// real env var name, cd into the remote workspace, then exec claude with
// the original argv.
const remoteCmdParts = [`cd ${shq(remoteCwd)}`];
if (token) {
  remoteCmdParts.push(
    'if [ -n "${LC_BOARDROOM_TOKEN-}" ]; then export CLAUDE_CODE_OAUTH_TOKEN="$LC_BOARDROOM_TOKEN"; fi',
  );
}
remoteCmdParts.push(`exec claude ${remoteArgString}`);
const remoteCmd = remoteCmdParts.join(' && ');

const sshArgs = [
  '-o', 'BatchMode=yes',
  '-o', 'ServerAliveInterval=30',
  '-o', 'ServerAliveCountMax=3',
  '-o', 'ControlMaster=auto',
  '-o', `ControlPath=/tmp/.boardroom-ssh-${process.getuid?.() ?? 'x'}-%C`,
  '-o', 'ControlPersist=10m',
];
if (token) sshArgs.push('-o', 'SendEnv=LC_BOARDROOM_TOKEN');
if (port) sshArgs.push('-p', String(port));
sshArgs.push(host, '--', remoteCmd);

const childEnv = { ...process.env };
if (token) childEnv.LC_BOARDROOM_TOKEN = token;
// Don't leak the local-only OAuth token to ssh's child env beyond the
// LC_ smuggling channel.
delete childEnv.CLAUDE_CODE_OAUTH_TOKEN;

const child = spawn('ssh', sshArgs, {
  stdio: 'inherit',
  env: childEnv,
});

// Propagate signals from the SDK (the parent) down to the remote claude.
const fwd = (sig) => {
  if (!child.killed) {
    try {
      child.kill(sig);
    } catch {
      // ignore
    }
  }
};
['SIGINT', 'SIGTERM', 'SIGHUP'].forEach((sig) => process.on(sig, () => fwd(sig)));

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

child.on('error', (err) => {
  process.stderr.write(`[boardroom-ssh] failed to spawn ssh: ${err.message}\n`);
  process.exit(127);
});
