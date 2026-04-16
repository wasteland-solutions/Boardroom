'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Conversation, Cwd } from '@/lib/schema';
import { Markdown } from './Markdown';
import {
  CLAUDE_MODELS,
  type ModelId,
  type PermissionMode,
  type StreamFrame,
} from '@/lib/types';
import { TerminalPanel } from './TerminalPanel';
import { SettingsForm } from './SettingsForm';
import type { AppSettings } from '@/lib/types';

type SlashCommand = {
  name: string;
  description: string;
  argumentHint: string;
  // 'sdk' = comes from Query.supportedCommands() (a real claude-code skill).
  // 'boardroom' = handled locally by Boardroom; not sent to claude.
  source?: 'sdk' | 'boardroom';
};

// Built-in client-side commands. These don't come from the SDK — Boardroom
// handles them itself. They're merged into the autocomplete popup so the
// user gets a unified `/` namespace.
const BOARDROOM_BUILTIN_COMMANDS: SlashCommand[] = [
  {
    name: 'clear',
    description: 'Start a fresh conversation in the same workspace (Boardroom)',
    argumentHint: '',
    source: 'boardroom',
  },
  {
    name: 'archive',
    description: 'Archive this conversation and jump to a new one (Boardroom)',
    argumentHint: '',
    source: 'boardroom',
  },
  {
    name: 'info',
    description: 'Show what Claude actually loaded for this session (Boardroom)',
    argumentHint: '',
    source: 'boardroom',
  },
];

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
  initialMode = 'chat',
  initialSettings,
}: {
  conversations: Conversation[];
  cwds: Cwd[];
  current: Conversation | null;
  initialMessages: StoredMessage[];
  initialSettings: AppSettings;
  initialMode?: 'chat' | 'terminal';
}) {
  const router = useRouter();
  const [liveCwds, setLiveCwds] = useState<Cwd[]>(cwds);
  const [blocks, setBlocks] = useState<DisplayBlock[]>(() => hydrateBlocks(initialMessages));
  const [lastSeq, setLastSeq] = useState<number>(() => maxSeq(initialMessages));
  const [sending, setSending] = useState(false);
  const [text, setText] = useState('');
  const [showNew, setShowNew] = useState(current === null);
  const [showSettings, setShowSettings] = useState(false);
  const [showSidebar, setShowSidebar] = useState(false);
  const [showChat, setShowChat] = useState(initialMode !== 'terminal');
  const [showTerminal, setShowTerminal] = useState(initialMode === 'terminal');
  const [stopped, setStopped] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [busy, setBusy] = useState(false);
  const [slashCommands, setSlashCommands] = useState<SlashCommand[]>([]);
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashSelected, setSlashSelected] = useState(0);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const slashPopupRef = useRef<HTMLDivElement>(null);

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

  // Fetch the slash command list once per conversation. The endpoint
  // lazily spawns the SDK session in the worker if it isn't already
  // running, so this also pre-warms the chat for faster first-message
  // turnaround.
  useEffect(() => {
    if (!current) {
      setSlashCommands(BOARDROOM_BUILTIN_COMMANDS);
      return;
    }
    let cancelled = false;
    // Show the Boardroom built-ins immediately so the popup isn't empty
    // while we wait for the SDK list.
    setSlashCommands(BOARDROOM_BUILTIN_COMMANDS);
    fetch(`/api/conversations/${current.id}/slash-commands`)
      .then((res) => (res.ok ? res.json() : { commands: [] }))
      .then((data: { commands?: SlashCommand[] }) => {
        if (cancelled) return;
        const sdk = (data.commands ?? []).map((c) => ({ ...c, source: 'sdk' as const }));
        // Boardroom built-ins on top, SDK skills below, deduped by name.
        const seen = new Set(BOARDROOM_BUILTIN_COMMANDS.map((c) => c.name));
        const merged = [
          ...BOARDROOM_BUILTIN_COMMANDS,
          ...sdk.filter((c) => !seen.has(c.name)),
        ];
        setSlashCommands(merged);
      })
      .catch(() => {
        if (!cancelled) setSlashCommands(BOARDROOM_BUILTIN_COMMANDS);
      });
    return () => {
      cancelled = true;
    };
  }, [current?.id]);

  // Filter commands to whatever the user has typed after the leading `/`.
  const filteredSlashCommands = useMemo(() => {
    if (!slashOpen) return [];
    const query = text.startsWith('/') ? text.slice(1).split(/\s/, 1)[0] ?? '' : '';
    if (!query) return slashCommands;
    const q = query.toLowerCase();
    return slashCommands.filter(
      (c) => c.name.toLowerCase().startsWith(q) || c.name.toLowerCase().includes(q),
    );
  }, [slashOpen, slashCommands, text]);

  // Open / close the slash popup based on whether the composer text
  // currently looks like the user is starting a slash command.
  useEffect(() => {
    if (text.startsWith('/') && !text.includes(' ') && !text.includes('\n') && slashCommands.length > 0) {
      setSlashOpen(true);
    } else {
      setSlashOpen(false);
    }
  }, [text, slashCommands.length]);

  // Reset highlight when the filtered list changes.
  useEffect(() => {
    setSlashSelected(0);
  }, [filteredSlashCommands.length]);

  // Auto-scroll the selected row into view when navigating with arrows.
  useEffect(() => {
    if (!slashOpen) return;
    const popup = slashPopupRef.current;
    if (!popup) return;
    const row = popup.querySelector<HTMLElement>('.slash-row.selected');
    if (row) row.scrollIntoView({ block: 'nearest' });
  }, [slashSelected, slashOpen]);

  const insertSlashCommand = useCallback(
    (cmd: SlashCommand) => {
      // Replace the current `/foo` token with the full command name and
      // a trailing space (so the user can immediately type args).
      setText(`/${cmd.name} `);
      setSlashOpen(false);
      // Refocus the textarea so the user can keep typing.
      requestAnimationFrame(() => composerRef.current?.focus());
    },
    [],
  );

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
        if (archived) {
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

  // Boardroom-side handler for /clear, /archive, /info. These are
  // intercepted before the message ever reaches the SDK so they don't
  // get sent to claude as user text.
  const handleBoardroomCommand = useCallback(
    async (cmd: string): Promise<boolean> => {
      if (!current) return false;
      if (cmd === 'clear') {
        // Create a fresh conversation in the same workspace with the
        // same model / mode / instructions and navigate to it.
        try {
          const res = await fetch('/api/conversations', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              cwd: current.cwd,
              model: current.model,
              permissionMode: current.permissionMode,
            }),
          });
          if (!res.ok) throw new Error(await res.text());
          const { conversation } = (await res.json()) as { conversation: Conversation };
          setText('');
          router.push(`/c/${conversation.id}`);
          router.refresh();
        } catch (err) {
          console.error('[/clear]', err);
        }
        return true;
      }
      if (cmd === 'archive') {
        setText('');
        await setArchived(true);
        return true;
      }
      if (cmd === 'info') {
        // Inject a synthetic system block into the current view describing
        // what this session is configured with. (Doesn't touch the SDK.)
        const lines = [
          `model: ${current.model}`,
          `permission_mode: ${current.permissionMode}`,
          `cwd: ${current.cwd}`,
          `sdk_session_id: ${current.sdkSessionId ?? '(not started yet)'}`,
          `archived: ${current.archived}`,
        ];
        setBlocks((prev) => [
          ...prev,
          {
            kind: 'system',
            id: `info-${Date.now()}`,
            seq: prev.length + 1,
            text: lines.join('\n'),
          },
        ]);
        setText('');
        return true;
      }
      return false;
    },
    [current, router, setArchived],
  );

  const send = useCallback(async () => {
    if (!current || !text.trim() || sending) return;

    // Block sends when the session is stopped — the user must click
    // Resume first so they have explicit control over when the agent
    // reconnects.
    if (stopped) return;

    // Intercept Boardroom-side commands.
    const trimmed = text.trim();
    if (trimmed.startsWith('/')) {
      const firstToken = trimmed.slice(1).split(/\s/, 1)[0] ?? '';
      const isBoardroom = BOARDROOM_BUILTIN_COMMANDS.some((c) => c.name === firstToken);
      if (isBoardroom) {
        await handleBoardroomCommand(firstToken);
        return;
      }
    }

    setSending(true);
    try {
      const res = await fetch(`/api/input/${current.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'send', text: trimmed }),
      });
      if (!res.ok) throw new Error(await res.text());
      setText('');
    } catch (err) {
      console.error('[send]', err);
    } finally {
      setSending(false);
    }
  }, [current, text, sending, stopped, handleBoardroomCommand]);

  const onKey = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // When the slash popup is open, intercept arrows / Enter / Escape
      // for navigation before falling through to the normal send
      // handling.
      if (slashOpen && filteredSlashCommands.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setSlashSelected((s) => (s + 1) % filteredSlashCommands.length);
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          setSlashSelected((s) => (s - 1 + filteredSlashCommands.length) % filteredSlashCommands.length);
          return;
        }
        if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
          e.preventDefault();
          insertSlashCommand(filteredSlashCommands[slashSelected]);
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          setSlashOpen(false);
          return;
        }
      }
      // Enter alone sends, Shift+Enter inserts a newline. Skip while an
      // IME composition is in progress so Asian input methods don't get
      // their Enter-to-commit swallowed.
      if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault();
        void send();
      }
    },
    [send, slashOpen, filteredSlashCommands, slashSelected, insertSlashCommand],
  );

  const stop = useCallback(async () => {
    if (!current) return;
    const res = await fetch(`/api/input/${current.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'interrupt' }),
    });
    setStopped(true);
    setBlocks((prev) => [
      ...prev,
      {
        kind: 'system' as const,
        id: `stop-${Date.now()}`,
        seq: prev.length + 1,
        text: res.ok ? 'Stopped. Click Resume to continue.' : 'Stop failed.',
      },
    ]);
  }, [current]);

  const resume = useCallback(async () => {
    if (!current) return;
    setStopped(false);
    setBlocks((prev) => [
      ...prev,
      {
        kind: 'system' as const,
        id: `resume-${Date.now()}`,
        seq: prev.length + 1,
        text: 'Resumed.',
      },
    ]);
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

  const deleteConversation = useCallback(async () => {
    if (!current) return;
    // Don't check `busy` — the delete button should always work even
    // if a previous async operation left busy stuck true. Delete is
    // a terminal action and the confirm() dialog is guard enough.
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
  }, [current, activeConvs, router]);

  const sidebar = useMemo(
    () => (
      <aside className={`sidebar${showSidebar ? ' sidebar-open' : ''}`}>
        <div className="sidebar-header">
          <div className="sidebar-brand">
            <div className="wordmark" aria-hidden="true" />
            <div className="sidebar-title">Boardroom</div>
          </div>
          <div className="sidebar-actions">
            <button
              className="icon-btn"
              title="New conversation"
              aria-label="New conversation"
              onClick={() => setShowNew(true)}
            >
              +
            </button>
            <button className="icon-btn" title="Settings" aria-label="Settings" onClick={() => setShowSettings(!showSettings)}>
              ⚙
            </button>
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
                onClick={() => setShowSidebar(false)}
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
          <button
            className="sidebar-logout"
            title="Toggle theme"
            aria-label="Toggle theme"
            onClick={() => {
              const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
              document.documentElement.setAttribute('data-theme', next);
              localStorage.setItem('theme', next);
              document.cookie = `theme=${next};path=/;max-age=31536000;SameSite=Lax`;
            }}
          >
            <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
          </button>
          <button
            className="sidebar-logout"
            title="Sign out"
            aria-label="Sign out"
            onClick={async () => {
              const res = await fetch('/api/auth/csrf');
              const { csrfToken } = await res.json();
              const form = document.createElement('form');
              form.method = 'POST';
              form.action = '/api/auth/signout';
              form.innerHTML = `<input type="hidden" name="csrfToken" value="${csrfToken}">`;
              document.body.appendChild(form);
              form.submit();
            }}
          >
            <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" /></svg>
          </button>
        </div>
      </aside>
    ),
    [activeConvs, archivedConvs, current?.id, router, showArchived, showSidebar],
  );

  const mobileNav = (
    <>
      {showSidebar && <div className="sidebar-backdrop" onClick={() => setShowSidebar(false)} />}
      <button className="mobile-menu" aria-label="Menu" onClick={() => setShowSidebar(!showSidebar)}>
        <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
      </button>
    </>
  );

  const settingsDrawer = showSettings && (
    <>
      <div className="drawer-backdrop" onClick={() => setShowSettings(false)} />
      <aside className="drawer">
        <div className="drawer-header">
          <h2>Settings</h2>
          <button className="icon-btn" onClick={() => setShowSettings(false)} title="Close" aria-label="Close">✕</button>
        </div>
        <div className="drawer-body">
          <SettingsForm initialSettings={initialSettings} initialCwds={liveCwds} onCwdsChange={setLiveCwds} />
        </div>
      </aside>
    </>
  );

  const newChatModal = showNew && (
    <>
      <div className="modal-backdrop" onClick={() => setShowNew(false)} />
      <div className="modal-backdrop" style={{ background: 'transparent', pointerEvents: 'none' }}>
        <div className="modal" style={{ pointerEvents: 'auto' }} onClick={(e) => e.stopPropagation()}>
          <div className="modal-header">
            <div className="modal-title">New conversation</div>
            <button className="icon-btn" onClick={() => setShowNew(false)} title="Close" aria-label="Close">✕</button>
          </div>
          <div style={{ padding: 16, overflowY: 'auto' }}>
            <NewConversationForm cwds={liveCwds} onOpenSettings={() => setShowSettings(true)} onClose={() => setShowNew(false)} />
          </div>
        </div>
      </div>
    </>
  );

  if (!current) {
    return (
      <div className="app">
        {sidebar}
        {mobileNav}
        <main className="main-panel">
          <div className="chat">
            <div className="empty-state">
              <div className="wordmark" aria-hidden="true" />
              <h2>Nothing here yet</h2>
              <p>Create a new conversation from the sidebar to get started.</p>
            </div>
          </div>
        </main>
        {newChatModal}
        {settingsDrawer}
      </div>
    );
  }

  return (
    <div className="app">
      {sidebar}
      {mobileNav}
      <main className="main-panel">
        <header className="chat-header">
          <div>
            <div className="chat-title">{current.title ?? 'Untitled'}</div>
            <div className="chat-subtitle">
              <span className="chip">Claude</span>
              <span className="chip">{current.model}</span>
              <span className="chip">{current.permissionMode}</span>
              <span className="chip">{current.cwd}</span>
              {current.archived && <span className="chip chip-archived">archived</span>}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              className={`btn ghost${showChat ? ' active' : ''}`}
              onClick={() => {
                setShowChat((v) => {
                  const next = !v;
                  // If hiding chat, make sure terminal is visible.
                  if (!next && !showTerminal) setShowTerminal(true);
                  return next;
                });
              }}
              title="Toggle chat panel"
            >
              Chat
            </button>
            <button
              className={`btn ghost${showTerminal ? ' active' : ''}`}
              onClick={() => {
                setShowTerminal((v) => {
                  const next = !v;
                  // If hiding terminal, make sure chat is visible.
                  if (!next && !showChat) setShowChat(true);
                  return next;
                });
              }}
              title="Toggle terminal"
            >
              Terminal
            </button>
            {current.archived ? (
              <button
                className="btn ghost"
                onClick={() => setArchived(false)}
                disabled={busy}
                title="Move back to active conversations"
              >
                Unarchive
              </button>
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
            <button
              className="btn stop"
              onClick={deleteConversation}
              disabled={busy}
              title="Permanently delete the conversation and its Claude Code session file"
            >
              Delete
            </button>
            {stopped ? (
              <button className="btn" onClick={resume}>
                Resume
              </button>
            ) : (
              <button className="btn stop" onClick={stop}>
                Stop
              </button>
            )}
          </div>
        </header>
        <div className={`workspace-split${showTerminal && showChat ? ' with-terminal' : ''}${showTerminal && !showChat ? ' terminal-only' : ''}`}>
        {showChat && <section className="chat">
          <div className="messages" ref={messagesRef}>
            {blocks.length === 0 && (
              <div className="empty-state">
                <div className="wordmark" aria-hidden="true" />
                <h2>Say hi to Claude Code</h2>
                <p>Type a message below to get started. Enter sends, Shift+Enter for a newline.</p>
              </div>
            )}
            {blocks.map((b) => (
              <MessageBlock key={b.id} block={b} onResolve={resolvePermission} />
            ))}
          </div>
          <div className="composer-wrap">
            {slashOpen && filteredSlashCommands.length > 0 && (
              <div className="slash-popup" ref={slashPopupRef}>
                <div className="slash-popup-eyebrow">
                  Slash commands · {filteredSlashCommands.length} match
                  {filteredSlashCommands.length === 1 ? '' : 'es'}
                </div>
                {filteredSlashCommands.map((cmd, idx) => (
                  <button
                    type="button"
                    key={`${cmd.source ?? 'sdk'}:${cmd.name}`}
                    className={`slash-row${idx === slashSelected ? ' selected' : ''}`}
                    onMouseEnter={() => setSlashSelected(idx)}
                    onClick={() => insertSlashCommand(cmd)}
                  >
                    <div className="slash-name">
                      /{cmd.name}
                      {cmd.argumentHint && <span className="slash-hint"> {cmd.argumentHint}</span>}
                      <span className={`slash-source slash-source-${cmd.source ?? 'sdk'}`}>
                        {cmd.source === 'boardroom' ? 'boardroom' : 'skill'}
                      </span>
                    </div>
                    {cmd.description && <div className="slash-desc">{cmd.description}</div>}
                  </button>
                ))}
              </div>
            )}
            <div className="composer">
              <textarea
                ref={composerRef}
                name="message"
                aria-label="Message"
                rows={2}
                placeholder={stopped ? 'Session stopped — click Resume to continue…' : 'Message Claude Code — Enter to send, Shift+Enter for newline, / for commands…'}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={onKey}
                disabled={sending || stopped}
              />
              <button className="btn" onClick={send} disabled={sending || stopped || !text.trim()}>
                Send
              </button>
            </div>
          </div>
        </section>}
        {showTerminal && <TerminalPanel conversationId={current.id} />}
        {/* When both are hidden (shouldn't happen, but safety net) */}
        {!showChat && !showTerminal && (
          <div className="empty-state">
            <p>Both panels are hidden. Click Terminal or Show chat to bring one back.</p>
          </div>
        )}
        </div>
        <div style={{ fontSize: 10, color: 'var(--text-dim)', textAlign: 'right' }}>
          last seq: {lastSeq}
        </div>
      </main>
      {newChatModal}
      {settingsDrawer}
    </div>
  );
}

function ExpandableCode({ children, maxLines = 4 }: { children: string; maxLines?: number }) {
  const [expanded, setExpanded] = useState(false);
  const lines = children.split('\n');
  const needsExpand = lines.length > maxLines;
  const display = expanded ? children : lines.slice(0, maxLines).join('\n');

  return (
    <div className="tool-input">
      <pre>{display}{needsExpand && !expanded ? '…' : ''}</pre>
      {needsExpand && (
        <button className="expand-toggle" onClick={() => setExpanded(!expanded)}>
          {expanded ? 'Show less' : `Show all (${lines.length} lines)`}
        </button>
      )}
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
        <div className="msg-bubble">
          {block.text ? <Markdown>{block.text}</Markdown> : (block.streaming ? '' : '…')}
        </div>
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
          <ExpandableCode>{JSON.stringify(block.input, null, 2)}</ExpandableCode>
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
          <ExpandableCode maxLines={6}>{stringifyContent(block.content)}</ExpandableCode>
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
            <strong>{block.toolName}</strong>
            <ExpandableCode>{JSON.stringify(block.input, null, 2)}</ExpandableCode>
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

function NewConversationForm({ cwds, onOpenSettings, onClose }: { cwds: Cwd[]; onOpenSettings: () => void; onClose?: () => void }) {
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
          <div className="wordmark" aria-hidden="true" />
          <h2>No working directories configured</h2>
          <p>
            Add one in <button className="link-btn" onClick={onOpenSettings}>Settings</button> before starting a conversation.
          </p>
        </div>
      </div>
    );
  }

  const submit = async (mode: 'chat' | 'terminal' = 'chat') => {
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
      const query = mode === 'terminal' ? '?mode=terminal' : '';
      router.push(`/c/${conversation.id}${query}`);
      router.refresh();
    } catch (err) {
      console.error(err);
      setBusy(false);
    }
  };

  return (
    <div className="new-conv-form">
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
          {CLAUDE_MODELS.map((m) => (
            <option key={m} value={m}>{m}</option>
          ))}
        </select>
      </label>
      <label>
        <span>Permission mode</span>
        <select
          value={permissionMode}
          onChange={(e) => setPermissionMode(e.target.value as PermissionMode)}
        >
          <option value="ask">ask</option>
          <option value="acceptEdits">acceptEdits</option>
          <option value="bypassPermissions">bypassPermissions</option>
        </select>
      </label>
      <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
        <button className="btn" style={{ flex: 1 }} onClick={() => submit('chat')} disabled={busy || !cwd}>
          {busy ? 'Creating…' : 'Start chat'}
        </button>
        <button className="btn ghost" onClick={() => submit('terminal')} disabled={busy || !cwd}>
          Terminal
        </button>
      </div>
    </div>
  );
}

// --- helpers ---

function hydrateBlocks(rows: StoredMessage[]): DisplayBlock[] {
  const blocks: DisplayBlock[] = [];
  for (const r of rows) {
    // Skip persisted SDK system frames — they're stored for debugging
    // (loaded memory paths, mcp status, slash commands) but shouldn't
    // clutter the chat view.
    if (r.role === 'system') continue;
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
  if (typeof content === 'string') return content.replace(/^\s+/, '');
  if (!Array.isArray(content)) return '';
  // Claude often prefixes responses with one or two leading newlines
  // (artifact of the trained-in formatting). With white-space: pre-wrap
  // those render as visible blank lines at the top of every bubble.
  // Strip any leading whitespace from the joined text.
  return (content as Array<{ type?: string; text?: string }>)
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('')
    .replace(/^\s+/, '');
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

