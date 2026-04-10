'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Conversation, Cwd } from '@/lib/schema';
import { DEFAULT_MODELS, type ModelId, type PermissionMode, type StreamFrame } from '@/lib/types';
import { TerminalPanel } from './TerminalPanel';

type StoredMessage = {
  id: string;
  seq: number;
  role: string;
  content: unknown;
  toolCalls: unknown;
  sdkMessageType: string;
  createdAt: number;
};

type DisplayBlock =
  | { kind: 'user'; id: string; seq: number; text: string }
  | { kind: 'assistant'; id: string; seq: number; text: string; streaming?: boolean }
  | { kind: 'tool_use'; id: string; seq: number; name: string; input: unknown }
  | { kind: 'tool_result'; id: string; seq: number; content: unknown; isError: boolean }
  | {
      kind: 'permission';
      id: string;
      seq: number;
      requestId: string;
      toolName: string;
      input: unknown;
      resolved?: 'allow' | 'deny' | 'expired';
    }
  | { kind: 'system'; id: string; seq: number; text: string };

export function ChatShell({
  conversations,
  cwds,
  current,
  initialMessages,
}: {
  conversations: Conversation[];
  cwds: Cwd[];
  current: Conversation | null;
  initialMessages: StoredMessage[];
}) {
  const router = useRouter();
  const [blocks, setBlocks] = useState<DisplayBlock[]>(() => hydrateBlocks(initialMessages));
  const [lastSeq, setLastSeq] = useState<number>(() => maxSeq(initialMessages));
  const [sending, setSending] = useState(false);
  const [text, setText] = useState('');
  const [showNew, setShowNew] = useState(current === null);
  const [showTerminal, setShowTerminal] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [busy, setBusy] = useState(false);

  // Persist the Archived group expand/collapse state in localStorage so
  // navigating between conversations / refreshing doesn't reset it.
  // Hydrate on mount; write on change.
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem('boardroom:showArchived');
      if (stored === '1') setShowArchived(true);
      else if (stored === '0') setShowArchived(false);
    } catch {
      // localStorage may be unavailable (private mode etc.) — fall through
      // to the default `false`.
    }
  }, []);
  useEffect(() => {
    try {
      window.localStorage.setItem('boardroom:showArchived', showArchived ? '1' : '0');
    } catch {
      // ignore
    }
  }, [showArchived]);

  const activeConvs = useMemo(() => conversations.filter((c) => !c.archived), [conversations]);
  const archivedConvs = useMemo(() => conversations.filter((c) => c.archived), [conversations]);
  const messagesRef = useRef<HTMLDivElement>(null);
  const blocksRef = useRef(blocks);
  blocksRef.current = blocks;

  // Reset state when switching conversations.
  useEffect(() => {
    setBlocks(hydrateBlocks(initialMessages));
    setLastSeq(maxSeq(initialMessages));
    setShowNew(current === null);
  }, [current?.id, initialMessages]);

  // Auto-scroll on new blocks.
  useEffect(() => {
    const el = messagesRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [blocks]);

  // Open SSE stream for the current conversation.
  useEffect(() => {
    if (!current) return;
    const es = new EventSource(`/api/stream/${current.id}`);
    const pending: StreamFrame[] = [];
    let raf = 0;

    const flush = () => {
      raf = 0;
      if (pending.length === 0) return;
      const batch = pending.splice(0, pending.length);
      setBlocks((prev) => applyFrames(prev, batch));
      const highest = batch.reduce(
        (acc, f) => ('seq' in f && typeof f.seq === 'number' && f.seq > acc ? f.seq : acc),
        -1,
      );
      if (highest >= 0) setLastSeq(highest);
    };

    const enqueue = (frame: StreamFrame) => {
      pending.push(frame);
      if (!raf) raf = requestAnimationFrame(flush);
    };

    const handler = (ev: MessageEvent) => {
      try {
        const frame = JSON.parse(ev.data) as StreamFrame;
        enqueue(frame);
      } catch (err) {
        console.error('[stream] bad frame', err);
      }
    };

    es.addEventListener('partial_assistant_text', handler);
    es.addEventListener('assistant_message', handler);
    es.addEventListener('user_message', handler);
    es.addEventListener('tool_use', handler);
    es.addEventListener('tool_result', handler);
    es.addEventListener('permission_request', handler);
    es.addEventListener('permission_resolved', handler);
    es.addEventListener('system', handler);
    es.addEventListener('result', handler);
    es.addEventListener('error', handler);
    es.addEventListener('stream_closed', handler);

    return () => {
      es.close();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [current?.id]);

  const send = useCallback(async () => {
    if (!current || !text.trim() || sending) return;
    setSending(true);
    try {
      const res = await fetch(`/api/input/${current.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'send', text: text.trim() }),
      });
      if (!res.ok) throw new Error(await res.text());
      setText('');
    } catch (err) {
      console.error('[send]', err);
    } finally {
      setSending(false);
    }
  }, [current, text, sending]);

  const onKey = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Enter alone sends, Shift+Enter inserts a newline. Skip while an
      // IME composition is in progress so Asian input methods don't get
      // their Enter-to-commit swallowed.
      if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault();
        void send();
      }
    },
    [send],
  );

  const stop = useCallback(async () => {
    if (!current) return;
    await fetch(`/api/input/${current.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'interrupt' }),
    });
  }, [current]);

  const resolvePermission = useCallback(
    async (requestId: string, decision: 'allow' | 'deny') => {
      if (!current) return;
      await fetch(`/api/input/${current.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'permission_reply', requestId, decision }),
      });
    },
    [current],
  );

  const setArchived = useCallback(
    async (archived: boolean) => {
      if (!current || busy) return;
      setBusy(true);
      try {
        const res = await fetch(`/api/conversations/${current.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ archived }),
        });
        if (!res.ok) throw new Error(await res.text());
        // Refresh server data + jump somewhere sane.
        if (archived) {
          // Pick the next non-archived conversation that isn't the one we
          // just archived. Falls through to /c/new if there are none.
          const next = activeConvs.find((c) => c.id !== current.id);
          router.push(next ? `/c/${next.id}` : '/c/new');
        }
        router.refresh();
      } catch (err) {
        console.error('[archive]', err);
      } finally {
        setBusy(false);
      }
    },
    [current, busy, activeConvs, router],
  );

  const deleteConversation = useCallback(async () => {
    if (!current || busy) return;
    const ok = window.confirm(
      `Permanently delete "${current.title ?? 'Untitled'}"?\n\n` +
        'This removes the conversation from Boardroom AND deletes the underlying ' +
        'Claude Code session file from disk. The conversation cannot be resumed.',
    );
    if (!ok) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/conversations/${current.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(await res.text());
      const next = activeConvs.find((c) => c.id !== current.id);
      router.push(next ? `/c/${next.id}` : '/c/new');
      router.refresh();
    } catch (err) {
      console.error('[delete]', err);
      window.alert('Delete failed: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setBusy(false);
    }
  }, [current, busy, activeConvs, router]);

  const sidebar = useMemo(
    () => (
      <aside className="sidebar">
        <div className="sidebar-header">
          <div className="sidebar-brand">
            <div className="wordmark">B</div>
            <div className="sidebar-title">Boardroom</div>
          </div>
          <div className="sidebar-actions">
            <button
              className="icon-btn"
              title="New conversation"
              onClick={() => router.push('/c/new')}
            >
              +
            </button>
            <a className="icon-btn" href="/settings" title="Settings">
              ⚙
            </a>
          </div>
        </div>

        <div className="conv-section">
          <div className="sidebar-eyebrow">Conversations</div>
          <div className="conv-list">
            {activeConvs.map((c) => (
              <a
                key={c.id}
                href={`/c/${c.id}`}
                className={`conv-item${current?.id === c.id ? ' active' : ''}`}
              >
                <div className="title">{c.title ?? 'Untitled'}</div>
                <div className="meta">{c.cwd}</div>
              </a>
            ))}
            {activeConvs.length === 0 && <div className="conv-empty">No conversations yet</div>}
          </div>
        </div>

        {archivedConvs.length > 0 && (
          <div className="conv-section">
            <button
              type="button"
              className="conv-toggle"
              onClick={() => setShowArchived((v) => !v)}
              aria-expanded={showArchived}
            >
              <span>{showArchived ? '▾' : '▸'}</span>
              <span>Archived</span>
              <span className="conv-toggle-count">{archivedConvs.length}</span>
            </button>
            {showArchived && (
              <div className="conv-list">
                {archivedConvs.map((c) => (
                  <a
                    key={c.id}
                    href={`/c/${c.id}`}
                    className={`conv-item archived${current?.id === c.id ? ' active' : ''}`}
                  >
                    <div className="title">{c.title ?? 'Untitled'}</div>
                    <div className="meta">{c.cwd}</div>
                  </a>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="sidebar-footer">
          <span className="dot" />
          Agent worker online
        </div>
      </aside>
    ),
    [activeConvs, archivedConvs, current?.id, router, showArchived],
  );

  if (showNew) {
    return (
      <div className="app">
        {sidebar}
        <main className="main-panel">
          <NewConversationForm cwds={cwds} />
        </main>
      </div>
    );
  }

  if (!current) {
    return (
      <div className="app">
        {sidebar}
        <main className="main-panel">
          <div className="chat">
            <div className="empty-state">
              <div className="wordmark">B</div>
              <h2>Nothing here yet</h2>
              <p>Create a new conversation from the sidebar to get started.</p>
            </div>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="app">
      {sidebar}
      <main className="main-panel">
        <div className={`workspace-split${showTerminal ? ' with-terminal' : ''}`}>
        <section className="chat">
          <header className="chat-header">
            <div>
              <div className="chat-title">{current.title ?? 'Untitled'}</div>
              <div className="chat-subtitle">
                <span className="chip">{current.model}</span>
                <span className="chip">{current.permissionMode}</span>
                <span className="chip">{current.cwd}</span>
                {current.archived && <span className="chip chip-archived">archived</span>}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                className={`btn ghost${showTerminal ? ' active' : ''}`}
                onClick={() => setShowTerminal((v) => !v)}
                title="Toggle terminal"
              >
                {showTerminal ? 'Hide terminal' : 'Terminal'}
              </button>
              {current.archived ? (
                <>
                  <button
                    className="btn ghost"
                    onClick={() => setArchived(false)}
                    disabled={busy}
                    title="Move back to active conversations"
                  >
                    Unarchive
                  </button>
                  <button
                    className="btn stop"
                    onClick={deleteConversation}
                    disabled={busy}
                    title="Permanently delete the conversation and its Claude Code session file"
                  >
                    Delete
                  </button>
                </>
              ) : (
                <button
                  className="btn ghost"
                  onClick={() => setArchived(true)}
                  disabled={busy}
                  title="Archive — tears down the SDK session and pty"
                >
                  Archive
                </button>
              )}
              <button className="btn stop" onClick={stop}>
                Stop
              </button>
            </div>
          </header>
          <div className="messages" ref={messagesRef}>
            {blocks.length === 0 && (
              <div className="empty-state">
                <div className="wordmark">B</div>
                <h2>Say hi to Claude Code</h2>
                <p>Type a message below to get started. Enter sends, Shift+Enter for a newline.</p>
              </div>
            )}
            {blocks.map((b) => (
              <MessageBlock key={b.id} block={b} onResolve={resolvePermission} />
            ))}
          </div>
          <div className="composer">
            <textarea
              rows={2}
              placeholder="Message Claude Code — Enter to send, Shift+Enter for newline"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={onKey}
              disabled={sending}
            />
            <button className="btn" onClick={send} disabled={sending || !text.trim()}>
              Send
            </button>
          </div>
        </section>
        {showTerminal && <TerminalPanel conversationId={current.id} />}
        </div>
        <div style={{ fontSize: 10, color: 'var(--text-dim)', textAlign: 'right' }}>
          last seq: {lastSeq}
        </div>
      </main>
    </div>
  );
}

function MessageBlock({
  block,
  onResolve,
}: {
  block: DisplayBlock;
  onResolve: (requestId: string, decision: 'allow' | 'deny') => void;
}) {
  if (block.kind === 'user') {
    return (
      <div className="msg user">
        <div className="msg-role">You</div>
        <div className="msg-bubble">{block.text}</div>
      </div>
    );
  }
  if (block.kind === 'assistant') {
    return (
      <div className={`msg assistant${block.streaming ? ' streaming' : ''}`}>
        <div className="msg-role">Claude Code</div>
        <div className="msg-bubble">{block.text || (block.streaming ? '' : '…')}</div>
      </div>
    );
  }
  if (block.kind === 'tool_use') {
    return (
      <div className="msg">
        <div className="tool-call">
          <div className="tool-header">
            <span className="tool-name">{block.name}</span>
          </div>
          <div className="tool-input">{truncate(JSON.stringify(block.input), 160)}</div>
        </div>
      </div>
    );
  }
  if (block.kind === 'tool_result') {
    return (
      <div className="msg">
        <div className={`tool-call ${block.isError ? 'result-err' : 'result-ok'}`}>
          <div className="tool-header">
            <span className="tool-name">
              {block.isError ? '✗ tool error' : '✓ tool result'}
            </span>
          </div>
          <div className="tool-input">{truncate(stringifyContent(block.content), 260)}</div>
        </div>
      </div>
    );
  }
  if (block.kind === 'permission') {
    return (
      <div className="msg">
        <div className="permission-prompt">
          <div className="title">⚠ Permission request</div>
          <div className="tool">
            <strong>{block.toolName}</strong> {truncate(JSON.stringify(block.input), 200)}
          </div>
          {block.resolved ? (
            <div className="resolved">
              {block.resolved === 'allow'
                ? '✓ Allowed'
                : block.resolved === 'expired'
                ? '⏱ Expired'
                : '✗ Denied'}
            </div>
          ) : (
            <div className="actions">
              <button className="btn" onClick={() => onResolve(block.requestId, 'allow')}>
                Approve
              </button>
              <button className="btn ghost" onClick={() => onResolve(block.requestId, 'deny')}>
                Deny
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }
  return (
    <div className="msg">
      <div className="tool-call" style={{ opacity: 0.7 }}>
        {block.text}
      </div>
    </div>
  );
}

function NewConversationForm({ cwds }: { cwds: Cwd[] }) {
  const router = useRouter();
  const [title, setTitle] = useState('');
  const [cwd, setCwd] = useState(cwds[0]?.path ?? '');
  const [model, setModel] = useState<ModelId>('claude-opus-4-6');
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('ask');
  const [busy, setBusy] = useState(false);

  if (cwds.length === 0) {
    return (
      <div className="chat">
        <div className="empty-state">
          <div className="wordmark">B</div>
          <h2>No working directories configured</h2>
          <p>
            Add one in <a href="/settings">Settings</a> before starting a conversation.
          </p>
        </div>
      </div>
    );
  }

  const submit = async () => {
    setBusy(true);
    try {
      const res = await fetch('/api/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: title || undefined,
          cwd,
          model,
          permissionMode,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      const { conversation } = (await res.json()) as { conversation: Conversation };
      router.push(`/c/${conversation.id}`);
      router.refresh();
    } catch (err) {
      console.error(err);
      setBusy(false);
    }
  };

  return (
    <div className="panel">
      <h1>New conversation</h1>
      <p className="lead">Each conversation is one Claude Code session, bound to a working directory, model, and permission mode.</p>
      <section>
        <h2>Details</h2>
        <label>
          <span>Title (optional)</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Untitled" />
        </label>
        <label>
          <span>Working directory</span>
          <select value={cwd} onChange={(e) => setCwd(e.target.value)}>
            {cwds.map((c) => (
              <option key={c.path} value={c.path}>
                {c.label} ({c.path})
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Model</span>
          <select value={model} onChange={(e) => setModel(e.target.value as ModelId)}>
            {DEFAULT_MODELS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Permission mode</span>
          <select
            value={permissionMode}
            onChange={(e) => setPermissionMode(e.target.value as PermissionMode)}
          >
            <option value="ask">ask — prompt for every risky tool</option>
            <option value="acceptEdits">acceptEdits — auto-approve file edits</option>
            <option value="bypassPermissions">bypassPermissions — full auto</option>
          </select>
        </label>
        <button className="btn" onClick={submit} disabled={busy || !cwd} style={{ marginTop: 4 }}>
          {busy ? 'Creating…' : 'Create conversation'}
        </button>
      </section>
    </div>
  );
}

// --- helpers ---

function hydrateBlocks(rows: StoredMessage[]): DisplayBlock[] {
  const blocks: DisplayBlock[] = [];
  for (const r of rows) {
    const content = r.content;
    if (r.role === 'user') {
      blocks.push({
        kind: 'user',
        id: r.id,
        seq: r.seq,
        text: extractText(content),
      });
    } else if (r.role === 'assistant') {
      blocks.push({
        kind: 'assistant',
        id: r.id,
        seq: r.seq,
        text: extractText(content),
      });
      if (Array.isArray(content)) {
        for (const block of content as Array<{ type?: string; id?: string; name?: string; input?: unknown }>) {
          if (block.type === 'tool_use') {
            blocks.push({
              kind: 'tool_use',
              id: `${r.id}:${block.id ?? ''}`,
              seq: r.seq,
              name: block.name ?? 'unknown',
              input: block.input ?? {},
            });
          }
        }
      }
    } else if (r.role === 'tool_result') {
      const c = content as { tool_use_id?: string; content?: unknown; is_error?: boolean };
      blocks.push({
        kind: 'tool_result',
        id: r.id,
        seq: r.seq,
        content: c.content ?? '',
        isError: c.is_error ?? false,
      });
    } else {
      blocks.push({
        kind: 'system',
        id: r.id,
        seq: r.seq,
        text: stringifyContent(content),
      });
    }
  }
  return blocks;
}

function applyFrames(prev: DisplayBlock[], frames: StreamFrame[]): DisplayBlock[] {
  const next = [...prev];

  // Index of existing assistant blocks keyed by their (stable) messageId so
  // we can locate and mutate them in place. The runner sends the Anthropic
  // message id for both partial deltas and the final assistant_message
  // frame, so they land in the same bucket.
  const idxByMessageId = new Map<string, number>();
  for (let i = 0; i < next.length; i++) {
    const b = next[i];
    if (b.kind === 'assistant') idxByMessageId.set(b.id, i);
  }

  for (const frame of frames) {
    if (frame.type === 'partial_assistant_text') {
      const existing = idxByMessageId.get(frame.messageId);
      if (existing === undefined) {
        next.push({
          kind: 'assistant',
          id: frame.messageId,
          seq: frame.seq,
          text: frame.delta,
          streaming: true,
        });
        idxByMessageId.set(frame.messageId, next.length - 1);
      } else {
        const b = next[existing] as Extract<DisplayBlock, { kind: 'assistant' }>;
        // Only append if the block is still streaming. If the final message
        // has already landed (streaming === undefined/false) we ignore late
        // deltas to avoid doubling the text.
        if (b.streaming) {
          next[existing] = { ...b, text: b.text + frame.delta };
        }
      }
    } else if (frame.type === 'assistant_message') {
      const finalText = extractText(frame.content);
      const existing = idxByMessageId.get(frame.messageId);
      if (existing === undefined) {
        // No streaming bubble for this id — push finalized block directly.
        next.push({
          kind: 'assistant',
          id: frame.messageId,
          seq: frame.seq,
          text: finalText,
        });
        idxByMessageId.set(frame.messageId, next.length - 1);
      } else {
        // Replace streaming bubble with the authoritative text and mark as
        // finalized (drop `streaming` flag).
        next[existing] = {
          kind: 'assistant',
          id: frame.messageId,
          seq: frame.seq,
          text: finalText,
        };
      }
    } else if (frame.type === 'user_message') {
      if (!next.find((b) => b.id === frame.messageId)) {
        next.push({
          kind: 'user',
          id: frame.messageId,
          seq: frame.seq,
          text: extractText(frame.content),
        });
      }
    } else if (frame.type === 'tool_use') {
      next.push({
        kind: 'tool_use',
        id: `tool:${frame.toolUseId}`,
        seq: frame.seq,
        name: frame.name,
        input: frame.input,
      });
    } else if (frame.type === 'tool_result') {
      next.push({
        kind: 'tool_result',
        id: `result:${frame.toolUseId}:${frame.seq}`,
        seq: frame.seq,
        content: frame.content,
        isError: frame.isError,
      });
    } else if (frame.type === 'permission_request') {
      next.push({
        kind: 'permission',
        id: `perm:${frame.requestId}`,
        seq: frame.seq,
        requestId: frame.requestId,
        toolName: frame.toolName,
        input: frame.input,
      });
    } else if (frame.type === 'permission_resolved') {
      const idx = next.findIndex(
        (b) => b.kind === 'permission' && b.requestId === frame.requestId,
      );
      if (idx >= 0) {
        const prevBlock = next[idx] as Extract<DisplayBlock, { kind: 'permission' }>;
        next[idx] = { ...prevBlock, resolved: frame.decision };
      }
    } else if (frame.type === 'error') {
      next.push({
        kind: 'system',
        id: `err:${frame.seq}`,
        seq: frame.seq,
        text: `⚠ ${frame.message}`,
      });
    }
  }
  return next;
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return (content as Array<{ type?: string; text?: string }>)
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('');
}

function stringifyContent(c: unknown): string {
  if (typeof c === 'string') return c;
  try {
    return JSON.stringify(c);
  } catch {
    return String(c);
  }
}

function maxSeq(rows: StoredMessage[]): number {
  return rows.reduce((max, r) => (r.seq > max ? r.seq : max), 0);
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}
