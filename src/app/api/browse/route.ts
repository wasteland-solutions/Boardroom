import { NextResponse } from 'next/server';
import { promises as fs } from 'node:fs';
import { dirname, isAbsolute, normalize, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { parseHostString } from '@/lib/workspace';

export const runtime = 'nodejs';

// POST /api/browse
//
// Authenticated directory listing for the workspace picker. Two modes:
//
//   { path: '/abs/path' }                     → local browse via fs.readdir
//   { host: 'user@host[:port]', path: '/...' } → remote browse via ssh + ls
//
// Returns:
//   { path: '/normalized/abs/path',
//     parent: '/parent/path' | null,
//     entries: [{ name, isDir }] }
//
// Local browsing is scoped only by what the worker user can read on disk —
// no extra allowlist beyond the existing OS permissions. Remote browsing
// uses the same SSH ControlMaster machinery as the SDK wrapper and the
// terminal pty so connections are reused.

const Body = z.object({
  path: z.string().min(1),
  host: z.string().optional(),
});

export async function POST(req: Request) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => null);
  const parsed = Body.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: 'invalid body' }, { status: 400 });

  const requestedPath = normalize(parsed.data.path);
  if (!isAbsolute(requestedPath)) {
    return NextResponse.json({ error: 'path must be absolute' }, { status: 400 });
  }
  // Reject paths that could be used for command injection in the SSH
  // code path. Single quotes are our shell-quoting mechanism; backticks,
  // $(), and newlines could escape the quoting context.
  if (/[`\n\r$]/.test(requestedPath)) {
    return NextResponse.json({ error: 'path contains disallowed characters' }, { status: 400 });
  }

  if (parsed.data.host && parsed.data.host.trim()) {
    return browseRemote(parsed.data.host.trim(), requestedPath);
  }
  return browseLocal(requestedPath);
}

async function browseLocal(path: string) {
  const absPath = resolve(path);
  let entries: Array<{ name: string; isDir: boolean }>;
  try {
    const dirents = await fs.readdir(absPath, { withFileTypes: true });
    entries = dirents
      .map((d) => {
        let isDir = d.isDirectory();
        // Resolve symlinks pointing at directories.
        if (d.isSymbolicLink()) {
          try {
            const stat = require('node:fs').statSync(`${absPath}/${d.name}`);
            isDir = stat.isDirectory();
          } catch {
            isDir = false;
          }
        }
        return { name: d.name, isDir };
      })
      .sort((a, b) => {
        // Directories first, then alphabetical.
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
  } catch (err) {
    return NextResponse.json(
      { error: `cannot read directory: ${(err as Error).message}` },
      { status: 400 },
    );
  }
  return NextResponse.json({
    path: absPath,
    parent: absPath === '/' ? null : dirname(absPath),
    entries,
  });
}

async function browseRemote(hostInput: string, path: string) {
  const host = parseHostString(hostInput);
  if (!host) {
    return NextResponse.json({ error: 'invalid host' }, { status: 400 });
  }
  const sshTarget = host.user ? `${host.user}@${host.host}` : host.host;

  // List directory entries on the remote. We use ls -1Ap which:
  //   -1   one entry per line
  //   -A   include dotfiles but exclude . and ..
  //   -p   append `/` to directory names so we can tell them apart
  //
  // Same `bash -lic` trick as the SDK wrapper — `-i` is needed to make
  // .bashrc actually run on Debian/Ubuntu where the interactive guard
  // returns early for non-interactive shells. Without it, `ls` is fine
  // (it's in /bin) but the same code path won't find user-installed
  // tools, which would surprise users.
  const remoteCmd = `cd '${path.replace(/'/g, "'\\''")}' && ls -1Ap`;
  const wrapped = `bash -lic '${remoteCmd.replace(/'/g, "'\\''")}'`;

  const sshArgs = [
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ControlMaster=auto',
    '-o', `ControlPath=/tmp/.boardroom-ssh-${process.getuid?.() ?? 'x'}-%C`,
    '-o', 'ControlPersist=10m',
  ];
  if (host.port) sshArgs.push('-p', String(host.port));
  sshArgs.push(sshTarget, '--', wrapped);

  let stdout = '';
  let stderr = '';
  const code = await new Promise<number>((resolve) => {
    const child = spawn('ssh', sshArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', () => resolve(127));
    child.on('exit', (c) => resolve(c ?? 1));
  });

  if (code !== 0) {
    return NextResponse.json(
      {
        error: `ssh ls failed (exit ${code})`,
        detail: stderr.trim() || 'no stderr',
      },
      { status: 502 },
    );
  }

  const entries = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const isDir = line.endsWith('/');
      const name = isDir ? line.slice(0, -1) : line;
      return { name, isDir };
    })
    .sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

  // Compute the parent path the same way Node would for absolute paths,
  // since the remote OS conventions match (dirname semantics).
  const parent = path === '/' ? null : path.replace(/\/+$/, '').replace(/\/[^/]*$/, '') || '/';

  return NextResponse.json({
    path,
    parent,
    entries,
  });
}
