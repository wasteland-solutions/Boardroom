#!/usr/bin/env node
// First-run setup script. Checks prerequisites, creates directories,
// generates .env if missing, runs migrations. Idempotent — safe to
// run multiple times.

import { existsSync, mkdirSync, copyFileSync, readFileSync, chmodSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

const root = resolve(import.meta.dirname, '..');
const log = (msg) => console.log(`[setup] ${msg}`);
const warn = (msg) => console.warn(`[setup] ⚠ ${msg}`);
let hasErrors = false;

// 1. Check Node version
const [major] = process.versions.node.split('.').map(Number);
if (major < 22) {
  warn(`Node 22+ required, you have ${process.versions.node}. Things may break.`);
}

// 2. Check build tools (needed for better-sqlite3 + node-pty)
try {
  execSync('which make', { stdio: 'ignore' });
  execSync('which g++ || which gcc', { stdio: 'ignore' });
} catch {
  warn(
    'Build tools (make, g++) not found. Native modules may fail to compile.\n' +
    '         Fix: sudo apt-get install -y build-essential   (Debian/Ubuntu)\n' +
    '              xcode-select --install                    (macOS)',
  );
  hasErrors = true;
}

// 3. Create data directory
const dataDir = resolve(root, 'data');
if (!existsSync(dataDir)) {
  mkdirSync(dataDir, { recursive: true });
  log('Created data/ directory.');
}

// 4. Create .env from .env.example if missing
const envPath = resolve(root, '.env');
const envExample = resolve(root, '.env.example');
if (!existsSync(envPath)) {
  if (existsSync(envExample)) {
    let content = readFileSync(envExample, 'utf8');
    // Auto-generate AUTH_SECRET
    const secret = randomBytes(32).toString('base64');
    content = content.replace(/^AUTH_SECRET=$/m, `AUTH_SECRET=${secret}`);
    const { writeFileSync } = await import('node:fs');
    writeFileSync(envPath, content, { mode: 0o600 });
    log('Created .env from .env.example (AUTH_SECRET auto-generated, mode 600).');
    log('Edit .env to set BOARDROOM_USERNAME and BOARDROOM_PASSWORD.');
  } else {
    warn('.env.example not found — create .env manually.');
    hasErrors = true;
  }
} else {
  log('.env already exists.');
}

// 5. Check .env has required values
if (existsSync(envPath)) {
  const env = readFileSync(envPath, 'utf8');
  if (!env.match(/^AUTH_SECRET=.+$/m)) {
    warn('AUTH_SECRET is empty in .env. Generate one: openssl rand -base64 32');
    hasErrors = true;
  }
  const hasUsername = env.match(/^BOARDROOM_USERNAME=.+$/m);
  const hasOidc = env.match(/^OIDC_ISSUER_URL=.+$/m);
  if (!hasUsername && !hasOidc) {
    warn('No sign-in method configured. Set BOARDROOM_USERNAME + BOARDROOM_PASSWORD in .env.');
    hasErrors = true;
  }
}

// 6. Run migrations
log('Running database migrations...');
try {
  execSync('npx tsx scripts/migrate.ts', { cwd: root, stdio: 'inherit' });
} catch {
  warn('Migration failed. Check the error above.');
  hasErrors = true;
}

// 7. Clean stale .next cache
const nextDir = resolve(root, '.next');
if (existsSync(nextDir)) {
  const { rmSync } = await import('node:fs');
  rmSync(nextDir, { recursive: true, force: true });
  log('Cleared stale .next cache.');
}

if (hasErrors) {
  console.log('\n[setup] Finished with warnings. Fix the issues above, then run: npm run dev\n');
} else {
  console.log('\n[setup] Ready! Run: npm run dev\n');
}
