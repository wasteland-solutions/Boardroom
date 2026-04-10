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
// The remote `claude` uses whatever auth lives in its own ~/.claude (run
// `claude auth login` on the host once). See README → Auth on the remote
// host for the rationale.
//
// Why this script is so careful about shell setup
// -----------------------------------------------
// The Anthropic SDK's stream-json protocol is binary-clean over stdout —
// any byte that isn't a valid JSON line corrupts the next parse and the
// SDK throws "Unexpected token … is not valid JSON". So absolutely
// nothing other than `claude` may write to stdout in this remote pipe.
//
// The naive approach `ssh host -- 'bash -lic "exec claude"'` doesn't
// work because:
//   1. `bash -lc` (non-interactive) → .bashrc bails on its `case $- in
//      *i*) ;; *) return;; esac` guard → PATH never picks up nvm/asdf/
//      ~/.local/bin → claude exits 127.
//   2. `bash -lic` (interactive) → .bashrc runs in full → PATH is good
//      → claude is found → BUT now anything in .bashrc that prints to
//      stdout (p10k instant prompt, fastfetch, completion init scripts,
//      `echo "Welcome..."`, asdf shim warnings) gets prepended to the
//      stream-json pipe. SDK sees garbage + JSON, dies.
//
// The fix is a two-shell dance:
//   1. The OUTER shell uses `bash --noprofile --norc -c '...'` so ZERO
//      init files run on the process whose stdout becomes the SDK's
//      pipe. No noise.
//   2. The OUTER shell runs an INNER `bash -lic` subshell *just to read
//      $PATH*. The inner shell's stdout is captured into a variable —
//      it never reaches the SDK pipe — so .bashrc can be as noisy as
//      it wants. We use sentinel strings (BRBEGIN…BREND) to extract
//      the real PATH from any garbage the inner shell prepended.
//   3. The outer shell sets PATH from the captured value, cd's into the
//      workspace, and exec's claude. claude's stdout is the SDK pipe,
//      pristine.
//
// We hand the script to the remote bash via base64 + eval rather than
// inline single-quoted -c, because nested single-quoted heredocs (-c
// containing -c containing single-quoted format strings) get
// unreadable fast.

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

// The bash script that actually runs on the remote. We base64-encode it
// before sending so we don't have to worry about quoting at the ssh /
// remote-shell level.
const remoteScript = [
  'set -e',
  '',
  '# Capture the user\'s interactive-login PATH from a separate bash -lic',
  '# subshell. Its stdout (which may include p10k instant prompt, fastfetch,',
  '# .bashrc echos, openclaw completion errors, etc.) is captured into the',
  '# RAW variable, so it NEVER reaches the SDK protocol stream. Sentinel',
  '# strings let us extract just $PATH from any garbage the init scripts',
  '# prepended.',
  'RAW="$(bash -lic \'command printf "BRBEGIN%sBREND" "$PATH"\' </dev/null 2>/dev/null)" || RAW=""',
  '',
  '# Defensive guard: only override PATH if we actually got a properly-',
  '# delimited value back. If the inner shell crashed or .bashrc errored',
  '# out before printf, fall through to the bare PATH inherited from ssh',
  '# (which probably won\'t find claude — but the error will be cleaner).',
  'case "$RAW" in',
  '  *BRBEGIN*BREND*)',
  '    P="${RAW#*BRBEGIN}"',
  '    P="${P%BREND*}"',
  '    if [ -n "$P" ]; then',
  '      export PATH="$P"',
  '    fi',
  '    ;;',
  'esac',
  '',
  `cd ${shq(remoteCwd)} || { echo "[boardroom-ssh] cd failed: ${remoteCwd}" >&2; exit 1; }`,
  '',
  '# exec claude — its stdout takes over our stdout (which is the SDK',
  '# pipe), and the parent SDK starts reading stream-json from a clean',
  '# pipe with no init noise.',
  `exec claude ${remoteArgString}`,
  '',
].join('\n');

const b64 = Buffer.from(remoteScript, 'utf8').toString('base64');

// We feed the script to the remote bash via `eval "$(printf %s B64 |
// base64 -d)"`. The outer remote bash uses --noprofile --norc so its
// own startup is silent. eval runs the decoded multi-line script in
// that same bash, which means stdin (the SDK input pipe) and stdout
// (the SDK output pipe) flow straight through to `claude` after exec.
//
// Note: `base64 -d` is GNU/coreutils. Modern macOS supports both `-d`
// and `-D`. Tested OSes (Ubuntu, Debian, RHEL, Alpine, modern macOS)
// all accept `-d`. If you hit a host where it doesn't, swap to
// `openssl base64 -d` here.
const innerEval = `eval "$(printf %s ${b64} | base64 -d)"`;

const sshArgs = [
  '-o', 'BatchMode=yes',
  '-o', 'ServerAliveInterval=30',
  '-o', 'ServerAliveCountMax=3',
  '-o', 'ControlMaster=auto',
  '-o', `ControlPath=/tmp/.boardroom-ssh-${process.getuid?.() ?? 'x'}-%C`,
  '-o', 'ControlPersist=10m',
];
if (port) sshArgs.push('-p', String(port));
sshArgs.push(host, '--', 'bash', '--noprofile', '--norc', '-c', innerEval);

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
      `cmd:  ssh ${sshArgs.map((a) => (a.includes(' ') || a.includes('"') ? JSON.stringify(a) : a)).join(' ')}`,
      `decoded remote script (${remoteScript.length} bytes):`,
      remoteScript
        .split('\n')
        .map((l) => `  | ${l}`)
        .join('\n'),
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
