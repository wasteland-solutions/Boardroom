#!/usr/bin/env node
// Production entrypoint: background the compiled agent worker, then exec next start.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

const workerPath = resolve(repoRoot, 'dist/agent/worker.js');
if (!existsSync(workerPath)) {
  console.error(`[boardroom] agent worker not found at ${workerPath}. Did you run pnpm build?`);
  process.exit(1);
}

const worker = spawn(process.execPath, [workerPath], {
  stdio: 'inherit',
  env: process.env,
});

worker.on('exit', (code) => {
  console.error(`[boardroom] agent worker exited with code ${code}. Shutting down.`);
  process.exit(code ?? 1);
});

const shutdown = (signal) => {
  if (!worker.killed) worker.kill(signal);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Give the worker a tick to bind its socket before Next starts calling it.
await new Promise((r) => setTimeout(r, 250));

const next = spawn('npx', ['next', 'start'], {
  stdio: 'inherit',
  env: process.env,
  shell: process.platform === 'win32',
});

next.on('exit', (code) => {
  shutdown('SIGTERM');
  process.exit(code ?? 0);
});
