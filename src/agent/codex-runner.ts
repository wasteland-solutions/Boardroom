import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { persistence } from './persistence';
import { parseWorkspacePath, sshTarget, type RemoteWorkspace } from '../lib/workspace';
import type { ModelId, StreamFrame } from '../lib/types';

export type CodexStartOptions = {
  conversationId: string;
  cwd: string;
  model: ModelId;
  permissionMode: string; // maps to codex sandbox modes
};

// Codex uses a simpler per-turn model: each user message = one
// `codex exec --json` invocation. The process runs tools, emits JSONL
// events, and exits. No long-running session to manage.
export class CodexSession {
  private proc: ChildProcess | null = null;
  private dead = false;
  public lastActivity = Date.now();

  constructor(
    private readonly opts: CodexStartOptions,
    private readonly emit: (conversationId: string, frame: StreamFrame) => void,
  ) {}

  get isDead() {
    return this.dead;
  }

  get conversationId() {
    return this.opts.conversationId;
  }

  // Each message spawns a new codex exec process. Previous turns are
  // not resumed — codex exec is stateless (unless you use --resume,
  // which we can add later).
  sendUserText(text: string) {
    if (this.dead) {
      const seq = persistence.nextSeq(this.opts.conversationId);
      this.emit(this.opts.conversationId, {
        type: 'error',
        conversationId: this.opts.conversationId,
        seq,
        message: 'Session is dead — create a new conversation.',
      });
      return;
    }
    this.lastActivity = Date.now();
    const convId = this.opts.conversationId;

    // Persist the user message.
    const seq = persistence.nextSeq(convId);
    const messageId = persistence.writeMessage({
      conversationId: convId,
      role: 'user',
      sdkMessageType: 'user_input',
      content: [{ type: 'text', text }],
      seq,
    });
    this.emit(convId, {
      type: 'user_message',
      conversationId: convId,
      seq,
      messageId,
      content: [{ type: 'text', text }],
    });

    this.runTurn(text).catch((err) => {
      console.error(`[codex-runner] turn failed for ${convId}:`, err);
      const errSeq = persistence.nextSeq(convId);
      this.emit(convId, {
        type: 'error',
        conversationId: convId,
        seq: errSeq,
        message: err instanceof Error ? err.message : String(err),
      });
    });
  }

  async interrupt() {
    if (this.proc && !this.proc.killed) {
      this.proc.kill('SIGTERM');
    }
  }

  close() {
    this.dead = true;
    this.interrupt();
  }

  private async runTurn(prompt: string) {
    const convId = this.opts.conversationId;
    const parsed = parseWorkspacePath(this.opts.cwd);
    const isRemote = parsed.kind === 'remote';

    // Map Boardroom permission modes to codex sandbox modes.
    const sandbox =
      this.opts.permissionMode === 'bypassPermissions'
        ? 'danger-full-access'
        : this.opts.permissionMode === 'acceptEdits'
        ? 'workspace-write'
        : 'read-only';

    let proc: ChildProcess;

    if (isRemote) {
      const remote = parsed as RemoteWorkspace;
      // SSH: run codex on the remote box, same pattern as claude.
      const codexArgs = [
        'exec', '--json', '--ephemeral', '--skip-git-repo-check',
        '-C', remote.path,
        '-m', this.opts.model,
        '-s', sandbox,
        prompt,
      ];
      const shq = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
      const argsStr = codexArgs.map(shq).join(' ');
      const remoteScript = [
        'set -e',
        'RAW="$(bash -lic \'command printf "BRBEGIN%sBREND" "$PATH"\' </dev/null 2>/dev/null)" || RAW=""',
        'case "$RAW" in *BRBEGIN*BREND*) P="${RAW#*BRBEGIN}"; P="${P%BREND*}"; [ -n "$P" ] && export PATH="$P" ;; esac',
        `exec codex ${argsStr}`,
      ].join('\n');
      const b64 = Buffer.from(remoteScript, 'utf8').toString('base64');
      const remoteCommand = `bash --noprofile --norc -c 'eval "$(printf %s ${b64} | base64 -d)"'`;

      const sshArgs = [
        '-o', 'BatchMode=yes',
        '-o', 'ServerAliveInterval=30',
        '-o', 'ControlMaster=auto',
        '-o', `ControlPath=/tmp/.boardroom-ssh-${process.getuid?.() ?? 'x'}-%C`,
        '-o', 'ControlPersist=10m',
      ];
      if (remote.port) sshArgs.push('-p', String(remote.port));
      sshArgs.push(sshTarget(remote), '--', remoteCommand);

      proc = spawn('ssh', sshArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    } else {
      // Local: spawn codex directly.
      const codexBin = 'codex';
      const args = [
        'exec', '--json', '--ephemeral', '--skip-git-repo-check',
        '-C', parsed.kind === 'local' ? parsed.path : this.opts.cwd,
        '-m', this.opts.model,
        '-s', sandbox,
        prompt,
      ];
      proc = spawn(codexBin, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: parsed.kind === 'local' ? parsed.path : undefined,
      });
    }

    this.proc = proc;
    let assistantText = '';
    let currentMessageId = `codex-${Date.now()}`;

    // Parse JSONL from stdout.
    const rl = createInterface({ input: proc.stdout! });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      let ev: Record<string, unknown>;
      try {
        ev = JSON.parse(line);
      } catch {
        return; // skip non-JSON lines (codex prints some plain text too)
      }
      this.lastActivity = Date.now();
      const type = ev.type as string;

      if (type === 'message.delta') {
        const delta = (ev.delta as string) ?? '';
        if (delta) {
          assistantText += delta;
          const dSeq = persistence.nextSeq(convId);
          this.emit(convId, {
            type: 'partial_assistant_text',
            conversationId: convId,
            seq: dSeq,
            delta,
            messageId: currentMessageId,
          });
        }
      } else if (type === 'message.completed' || type === 'turn.completed') {
        if (assistantText) {
          const mSeq = persistence.nextSeq(convId);
          const rowId = persistence.writeMessage({
            conversationId: convId,
            role: 'assistant',
            sdkMessageType: 'codex_assistant',
            content: [{ type: 'text', text: assistantText }],
            seq: mSeq,
          });
          this.emit(convId, {
            type: 'assistant_message',
            conversationId: convId,
            seq: mSeq,
            messageId: currentMessageId,
            content: [{ type: 'text', text: assistantText }],
          });
          assistantText = '';
          currentMessageId = `codex-${Date.now()}`;
        }
      } else if (type === 'tool_call.created' || type === 'function_call') {
        const name = (ev.name as string) ?? (ev.tool as string) ?? 'tool';
        const input = ev.arguments ?? ev.input ?? {};
        const tSeq = persistence.nextSeq(convId);
        this.emit(convId, {
          type: 'tool_use',
          conversationId: convId,
          seq: tSeq,
          toolUseId: (ev.id as string) ?? `codex-tool-${Date.now()}`,
          name,
          input,
        });
      } else if (type === 'tool_call.output' || type === 'function_call_output') {
        const tSeq = persistence.nextSeq(convId);
        this.emit(convId, {
          type: 'tool_result',
          conversationId: convId,
          seq: tSeq,
          toolUseId: (ev.call_id as string) ?? '',
          content: ev.output ?? '',
          isError: false,
        });
      } else if (type === 'error' || type === 'turn.failed') {
        const msg =
          (ev.message as string) ??
          ((ev.error as { message?: string })?.message) ??
          'Codex error';
        const eSeq = persistence.nextSeq(convId);
        this.emit(convId, {
          type: 'error',
          conversationId: convId,
          seq: eSeq,
          message: msg,
        });
      }
    });

    // Capture stderr for logging.
    let stderr = '';
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    return new Promise<void>((resolve) => {
      proc.on('exit', (code) => {
        this.proc = null;
        if (code !== 0 && !assistantText) {
          const eSeq = persistence.nextSeq(convId);
          this.emit(convId, {
            type: 'error',
            conversationId: convId,
            seq: eSeq,
            message: `Codex exited with code ${code}${stderr ? `: ${stderr.trim().slice(0, 200)}` : ''}`,
          });
        }
        // Emit a stream_closed so the UI knows the turn is done.
        const closeSeq = persistence.nextSeq(convId);
        this.emit(convId, { type: 'stream_closed', conversationId: convId, seq: closeSeq });
        resolve();
      });
      proc.on('error', (err) => {
        const eSeq = persistence.nextSeq(convId);
        this.emit(convId, {
          type: 'error',
          conversationId: convId,
          seq: eSeq,
          message: `Failed to spawn codex: ${err.message}`,
        });
        resolve();
      });
    });
  }
}
