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
//
// Authentication: we deliberately do NOT forward any local credentials.
// The remote `claude` uses whatever auth lives in its own ~/.claude (or
// the remote's own ANTHROPIC_API_KEY env var, etc.) — exactly as if you'd
// run `claude` over `ssh` by hand. Run `claude auth login` on the remote
// once and you're set. This avoids account-mismatch / stale-token / API-
// key-vs-subscription confusion when the remote is already configured
// for a different account than the local Boardroom.
//
// Caveats — see README for the full list:
//   - claude must be on PATH for the remote login shell.
//   - The SSH key auth must be non-interactive (BatchMode=yes is set).
//   - The remote claude version should be compatible with the local SDK.

import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const host = process.env.BOARDROOM_SSH_HOST;
const remoteCwd = process.env.BOARDROOM_SSH_CWD;
const port = process.env.BOARDROOM_SSH_PORT;

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

// The inner command we want a login shell on the remote to run: cd into
// the workspace and exec the remote claude with the SDK's argv. The
// remote claude reads its own auth from ~/.claude (the result of having
// run `claude auth login` on the host) — we don't touch it.
const innerCmd = `cd ${shq(remoteCwd)} && exec claude ${remoteArgString}`;

// Wrap the inner command in `bash -lic '...'` — login + interactive +
// command. The `-i` (interactive) flag is critical: most ~/.bashrc files
// on Debian/Ubuntu (and many custom dotfiles) start with:
//
//     case $- in *i*) ;; *) return;; esac
//
// which makes `.bashrc` bail for non-interactive shells. Without -i,
// `bash -lc` is a non-interactive login shell, the guard fires, and all
// the PATH setup in .bashrc (including nvm/asdf/mise bootstrapping and
// ~/.local/bin additions) is skipped — so `claude` exits 127.
//
// The `-i` flag forces $- to include `i`, the guard passes, .bashrc
// finishes, and PATH is populated. bash may warn "cannot set terminal
// process group" to stderr since there's no tty, but that's harmless
// and our stderr capture below drops it on a successful run.
const remoteCmd = `bash -lic ${shq(innerCmd)}`;

const sshArgs = [
  '-o', 'BatchMode=yes',
  '-o', 'ServerAliveInterval=30',
  '-o', 'ServerAliveCountMax=3',
  '-o', 'ControlMaster=auto',
  '-o', `ControlPath=/tmp/.boardroom-ssh-${process.getuid?.() ?? 'x'}-%C`,
  '-o', 'ControlPersist=10m',
];
if (port) sshArgs.push('-p', String(port));
sshArgs.push(host, '--', remoteCmd);

// Strip any local Anthropic credentials from the env we hand to ssh so we
// can't accidentally smuggle them across the wire. The remote claude is
// authoritative for its own auth.
const childEnv = { ...process.env };
delete childEnv.CLAUDE_CODE_OAUTH_TOKEN;
delete childEnv.ANTHROPIC_API_KEY;

// We capture ssh's stderr so that on a non-zero exit we have something to
// show the user. Stdin and stdout are inherited 1:1 — that's the SDK
// stream-json protocol channel.
const child = spawn('ssh', sshArgs, {
  stdio: ['inherit', 'inherit', 'pipe'],
  env: childEnv,
});

const stderrChunks = [];
child.stderr.on('data', (chunk) => {
  stderrChunks.push(chunk);
  // Also pass through to our own stderr in case the parent SDK / harness
  // surfaces it. The SDK currently throws away child stderr but that may
  // change.
  process.stderr.write(chunk);
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

function writeDebugLog(code, signal) {
  // Even on success we leave a tiny log so the user can confirm the
  // wrapper actually ran. On failure we dump everything we know about
  // the invocation so it's possible to debug without re-running.
  try {
    const logPath = '/tmp/boardroom-ssh-last.log';
    mkdirSync(dirname(logPath), { recursive: true });
    const stderrText = Buffer.concat(stderrChunks).toString('utf8');
    const lines = [
      `# ${new Date().toISOString()}  exit=${code ?? 'null'} signal=${signal ?? 'null'}`,
      `host: ${host}`,
      `cwd:  ${remoteCwd}`,
      `port: ${port ?? 'default'}`,
      `auth: remote (we don't forward credentials)`,
      `args: ${JSON.stringify(passthroughArgs)}`,
      `cmd:  ssh ${sshArgs.join(' ')}`,
      stderrText ? `stderr:\n${stderrText}` : 'stderr: (empty)',
      '',
    ];
    appendFileSync(logPath, lines.join('\n'));
  } catch {
    // ignore log failures — never block on diagnostics
  }
}

child.on('exit', (code, signal) => {
  writeDebugLog(code, signal);
  if (code !== 0) {
    const stderrText = Buffer.concat(stderrChunks).toString('utf8').trim();
    process.stderr.write(
      `[boardroom-ssh] ssh exited with code ${code}${signal ? ` (signal ${signal})` : ''}\n` +
        (stderrText ? `[boardroom-ssh] stderr: ${stderrText}\n` : '') +
        `[boardroom-ssh] full debug log: /tmp/boardroom-ssh-last.log\n`,
    );
  }
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

child.on('error', (err) => {
  process.stderr.write(`[boardroom-ssh] failed to spawn ssh: ${err.message}\n`);
  writeDebugLog(127, null);
  process.exit(127);
});
