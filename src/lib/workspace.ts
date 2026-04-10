// Workspace path parser. A workspace can be:
//
//   - a local absolute path:        /Users/you/Code/foo
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

// `[user@]host[:port]:/abs/path` — the rsync/scp/git short form. We require
// the path to be absolute (must start with `/` after the colon) so we can
// distinguish from a local Mac/Linux path that happens to contain a colon.
// Host part may not contain `/`. Port part is digits between `:port:` only
// when there's a *second* colon delimiter — to keep parsing unambiguous, we
// require a `host:/` boundary, and `host:port:/path` is rejected (use the
// ssh:// URI form for non-default ports).
const SHORT_FORM_RE = /^(?:([^@/:\s]+)@)?([^@/:\s]+):(\/[^\s].*)$/;

export function parseWorkspacePath(input: string): Workspace {
  const trimmed = input.trim();
  if (!trimmed) return { kind: 'invalid', reason: 'empty' };

  if (trimmed.startsWith(SSH_PREFIX)) {
    return parseSshUri(trimmed);
  }

  // Local absolute path takes priority over the short form so a literal
  // colon in a local path doesn't get misinterpreted.
  if (trimmed.startsWith('/')) {
    return { kind: 'local', path: trimmed };
  }

  // [user@]host:/abs/path short form
  const m = trimmed.match(SHORT_FORM_RE);
  if (m) {
    const [, user, host, path] = m;
    return {
      kind: 'remote',
      user: user ?? null,
      host,
      port: null,
      path,
      raw: `ssh://${user ? user + '@' : ''}${host}${path}`,
    };
  }

  return { kind: 'invalid', reason: 'must be absolute, ssh://, or user@host:/path' };
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

// Parse a host string of the form `[user@]host[:port]` (no path). Used by
// the Settings form's optional Host field. Empty string returns null.
export function parseHostString(
  input: string,
): { user: string | null; host: string; port: number | null } | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  // Reject anything that contains a slash or whitespace.
  if (/[\s/]/.test(trimmed)) return null;
  let user: string | null = null;
  let rest = trimmed;
  const at = trimmed.indexOf('@');
  if (at > 0) {
    user = trimmed.slice(0, at);
    rest = trimmed.slice(at + 1);
  }
  let host = rest;
  let port: number | null = null;
  const colon = rest.lastIndexOf(':');
  if (colon > 0) {
    const portStr = rest.slice(colon + 1);
    const portNum = Number(portStr);
    if (Number.isFinite(portNum) && portNum >= 1 && portNum <= 65535) {
      host = rest.slice(0, colon);
      port = portNum;
    }
  }
  if (!host) return null;
  return { user, host, port };
}

// Build an ssh:// URI from split fields. Used by the cwds POST when the
// caller sends {host, path} instead of a pre-formed URI.
export function buildSshUri(host: string, path: string): string | null {
  const parsedHost = parseHostString(host);
  if (!parsedHost) return null;
  if (!path.startsWith('/')) return null;
  const userPart = parsedHost.user ? `${encodeURIComponent(parsedHost.user)}@` : '';
  const portPart = parsedHost.port ? `:${parsedHost.port}` : '';
  // We don't percent-encode the path beyond what URL would; spaces survive
  // because we decode them on the other end.
  return `ssh://${userPart}${parsedHost.host}${portPart}${path}`;
}

// Human-readable label for sidebars / chat headers.
export function describeWorkspace(input: string): string {
  const parsed = parseWorkspacePath(input);
  if (parsed.kind === 'remote') return `${sshTarget(parsed)}:${parsed.path}`;
  if (parsed.kind === 'local') return parsed.path;
  return input;
}

// Convert an absolute path into the slug claude-code uses to namespace
// session files: every `/` is replaced with `-`. So `/Users/you/foo`
// becomes `-Users-you-foo`. The session file lives at
// `~/.claude/projects/{slug}/{sessionId}.jsonl`.
export function claudeProjectSlug(absPath: string): string {
  return absPath.replace(/\//g, '-');
}
