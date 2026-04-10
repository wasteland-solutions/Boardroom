'use client';

import { useCallback, useEffect, useState } from 'react';

type Entry = { name: string; isDir: boolean };

type Listing = {
  path: string;
  parent: string | null;
  entries: Entry[];
};

export function DirectoryBrowser({
  host,
  initialPath,
  onPick,
  onClose,
}: {
  // Host string (`user@host[:port]`) for remote browsing. Empty/undefined =
  // browse the local filesystem.
  host: string;
  initialPath: string;
  onPick: (path: string) => void;
  onClose: () => void;
}) {
  const [listing, setListing] = useState<Listing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [pathInput, setPathInput] = useState(initialPath);

  const load = useCallback(
    async (path: string) => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch('/api/browse', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            host: host.trim() || undefined,
            path,
          }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(
            `${body.error ?? 'browse failed'}${body.detail ? `\n${body.detail}` : ''}`,
          );
        }
        const data = (await res.json()) as Listing;
        setListing(data);
        setPathInput(data.path);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [host],
  );

  useEffect(() => {
    load(initialPath);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const enter = (entry: Entry) => {
    if (!entry.isDir || !listing) return;
    const sep = listing.path.endsWith('/') ? '' : '/';
    load(`${listing.path}${sep}${entry.name}`);
  };

  const goParent = () => {
    if (listing?.parent !== undefined && listing.parent !== null) load(listing.parent);
  };

  const submitInput = (e: React.FormEvent) => {
    e.preventDefault();
    if (pathInput.trim()) load(pathInput.trim());
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-title">
            Browse {host ? <span className="modal-host">{host}</span> : 'local filesystem'}
          </div>
          <button className="icon-btn" onClick={onClose} title="Close">
            ✕
          </button>
        </div>

        <form className="browser-pathbar" onSubmit={submitInput}>
          <button
            type="button"
            className="icon-btn"
            onClick={goParent}
            disabled={!listing?.parent}
            title="Up one level"
          >
            ↑
          </button>
          <input
            type="text"
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            placeholder="/absolute/path"
            spellCheck={false}
          />
          <button type="submit" className="btn ghost" disabled={loading}>
            Go
          </button>
        </form>

        {error && <div className="browser-error">{error}</div>}

        <div className="browser-list">
          {loading && !listing && <div className="browser-empty">Loading…</div>}
          {!loading && listing && listing.entries.length === 0 && (
            <div className="browser-empty">Empty directory.</div>
          )}
          {listing?.entries.map((entry) => (
            <button
              key={entry.name}
              type="button"
              className={`browser-row${entry.isDir ? '' : ' file'}`}
              onClick={() => enter(entry)}
              disabled={!entry.isDir}
            >
              <span className="browser-icon">{entry.isDir ? '📁' : '📄'}</span>
              <span className="browser-name">{entry.name}</span>
            </button>
          ))}
        </div>

        <div className="modal-footer">
          <div className="modal-current">
            Selected: <code>{listing?.path ?? '—'}</code>
          </div>
          <div className="modal-actions">
            <button className="btn ghost" onClick={onClose}>
              Cancel
            </button>
            <button
              className="btn"
              onClick={() => listing && onPick(listing.path)}
              disabled={!listing}
            >
              Use this directory
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
