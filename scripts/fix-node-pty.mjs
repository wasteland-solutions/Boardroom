#!/usr/bin/env node
// node-pty's prebuilt tarballs ship a `spawn-helper` binary on unix that
// loses its executable bit during pnpm extraction. Without the bit,
// posix_spawnp fails at runtime with no useful error. This script finds
// every spawn-helper in node_modules and re-applies `chmod +x` to it.
//
// It's registered as a postinstall script in package.json so it runs once
// after every `pnpm install`, in both dev and in the Docker build.
import { chmodSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const roots = ['node_modules', 'node_modules/.pnpm'];

function walk(dir, fn) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, fn);
    } else if (entry.isFile() && entry.name === 'spawn-helper') {
      fn(full);
    }
  }
}

let fixed = 0;
for (const root of roots) {
  walk(root, (p) => {
    try {
      const s = statSync(p);
      // Check if any execute bit is set.
      if ((s.mode & 0o111) === 0) {
        chmodSync(p, 0o755);
        fixed += 1;
        console.log(`[fix-node-pty] chmod +x ${p}`);
      }
    } catch (err) {
      console.warn(`[fix-node-pty] skip ${p}: ${err instanceof Error ? err.message : err}`);
    }
  });
}

if (fixed === 0) {
  // Quiet success — only log when we actually changed something.
}
