// Workspace path parser. A workspace can be:
//
//   - a local absolute path:        /Users/andre/Code/foo
//   - an SSH URI:                   ssh://user@host[:port]/abs/remote/path
//
// We store whichever the user gave us as a string in the `cwds.path` column,
// and parse on demand. parseWorkspacePath() never throws — invalid input
// just yields { kind: 'invalid' }.

export type LocalWorkspace = { kind: 'local'; path: string };

export type RemoteWorkspace = {
  kind: 'remote';
  user: string | null;
  host: string;
  port: number | null;
  path: string;
  // Original URI as the user provided it. Useful when we want to display
  // back exactly what they typed.
  raw: string;
};

export type Workspace = LocalWorkspace | RemoteWorkspace | { kind: 'invalid'; reason: string };

const SSH_PREFIX = 'ssh://';

export function parseWorkspacePath(input: string): Workspace {
  const trimmed = input.trim();
  if (!trimmed) return { kind: 'invalid', reason: 'empty' };

  if (trimmed.startsWith(SSH_PREFIX)) {
    return parseSshUri(trimmed);
  }

  // Anything else must be an absolute local path.
  if (!trimmed.startsWith('/')) {
    return { kind: 'invalid', reason: 'must be absolute or ssh://' };
  }
  return { kind: 'local', path: trimmed };
}

function parseSshUri(uri: string): Workspace {
  // Use the WHATWG URL parser by swapping the scheme to one it understands.
  // ssh:// isn't in URL's special-scheme list so user/host/port aren't parsed
  // out for us — http:// is.
  let parsed: URL;
  try {
    parsed = new URL(uri.replace(/^ssh:\/\//, 'http://'));
  } catch {
    return { kind: 'invalid', reason: 'invalid ssh:// URI' };
  }
  const host = parsed.hostname;
  if (!host) return { kind: 'invalid', reason: 'missing host' };

  const user = parsed.username ? decodeURIComponent(parsed.username) : null;
  const port = parsed.port ? Number(parsed.port) : null;
  if (port !== null && (!Number.isFinite(port) || port < 1 || port > 65535)) {
    return { kind: 'invalid', reason: 'invalid port' };
  }
  // pathname includes the leading slash, which is what we want for an
  // absolute remote path. Empty path → not allowed (we need a real cwd).
  let path = parsed.pathname || '';
  if (!path || path === '/') {
    return { kind: 'invalid', reason: 'missing remote path' };
  }
  // URL parser percent-encodes some characters; decode for display & cd.
  try {
    path = decodeURIComponent(path);
  } catch {
    // Leave as-is if decoding fails.
  }

  return {
    kind: 'remote',
    user,
    host,
    port,
    path,
    raw: uri.trim(),
  };
}

// Build the `user@host` string SSH expects. Returns just `host` when no user
// was specified (so SSH falls back to the system default / ~/.ssh/config).
export function sshTarget(ws: RemoteWorkspace): string {
  return ws.user ? `${ws.user}@${ws.host}` : ws.host;
}

// Human-readable label for sidebars / chat headers.
export function describeWorkspace(input: string): string {
  const parsed = parseWorkspacePath(input);
  if (parsed.kind === 'remote') return `${sshTarget(parsed)}:${parsed.path}`;
  if (parsed.kind === 'local') return parsed.path;
  return input;
}
