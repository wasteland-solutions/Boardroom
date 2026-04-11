#!/usr/bin/env node
// Production entrypoint:
//   1. Run Drizzle migrations (idempotent — creates tables on first boot).
//   2. Spawn the compiled agent worker as a background child.
//   3. Exec `next start` in the foreground.
// Both children are torn down cleanly on SIGINT / SIGTERM.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

// --- 1. Migrations ---
async function runMigrations() {
  const dbPath = resolve(process.env.DATABASE_PATH ?? './data/boardroom.db');
  const dir = dirname(dbPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const { default: Database } = await import('better-sqlite3');
  const { drizzle } = await import('drizzle-orm/better-sqlite3');
  const { migrate } = await import('drizzle-orm/better-sqlite3/migrator');

  const sqlite = new Database(dbPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');

  const db = drizzle(sqlite);
  const migrationsFolder = resolve(repoRoot, 'drizzle');
  migrate(db, { migrationsFolder });

  console.log(`[boardroom] migrations up-to-date (${dbPath})`);
  sqlite.close();

  // Harden file permissions — secrets and database should not be world-readable.
  for (const f of [dbPath, `${dbPath}-shm`, `${dbPath}-wal`]) {
    if (existsSync(f)) {
      try { chmodSync(f, 0o600); } catch { /* container fs may not support chmod */ }
    }
  }
  const envFile = resolve(repoRoot, '.env');
  if (existsSync(envFile)) {
    try { chmodSync(envFile, 0o600); } catch { /* ignore */ }
  }
}

try {
  await runMigrations();
} catch (err) {
  console.error('[boardroom] migration failed:', err);
  process.exit(1);
}

// Warn if running production without HTTPS — cookies won't have the Secure flag.
if (process.env.NODE_ENV === 'production' && !process.env.NEXTAUTH_URL?.startsWith('https://')) {
  console.warn(
    '[boardroom] ⚠ NODE_ENV=production but NEXTAUTH_URL does not start with https://. ' +
    'Auth cookies will lack the Secure flag. Set NEXTAUTH_URL=https://your-domain to fix.',
  );
}

// --- 2. Agent worker (background child) ---
const workerPath = resolve(repoRoot, 'dist/agent/worker.js');
if (!existsSync(workerPath)) {
  console.error(`[boardroom] agent worker not found at ${workerPath}. Did you run 'pnpm build'?`);
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

let shuttingDown = false;
const shutdown = (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
  if (!worker.killed) worker.kill(signal);
  if (nextProc && !nextProc.killed) nextProc.kill(signal);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Give the worker a tick to bind its Unix socket before Next starts calling it.
await new Promise((r) => setTimeout(r, 300));

// --- 3. Next.js (foreground) ---
// In standalone mode (output: 'standalone' in next.config.mjs), Next
// builds a self-contained server.js. In dev/non-standalone, fall back
// to `next start`.
const standaloneServer = resolve(repoRoot, '.next/standalone/server.js');
const nextArgs = existsSync(standaloneServer)
  ? [standaloneServer]
  : [resolve(repoRoot, 'node_modules/next/dist/bin/next'), 'start'];
const nextProc = spawn(process.execPath, nextArgs, {
  stdio: 'inherit',
  env: process.env,
});

nextProc.on('exit', (code) => {
  shutdown('SIGTERM');
  process.exit(code ?? 0);
});
