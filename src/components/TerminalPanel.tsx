'use client';

import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

// Themed to the Boardroom accent palette (Apple system blue) so the
// terminal feels native to the app shell.
const theme = {
  background: '#000000',
  foreground: '#f0f4f8',
  cursor: '#0a84ff',
  cursorAccent: '#000000',
  selectionBackground: 'rgba(10, 132, 255, 0.35)',
  selectionForeground: '#ffffff',
  black: '#12151d',
  red: '#ff6b6b',
  green: '#3fb950',
  yellow: '#ffcd6b',
  blue: '#0a84ff',
  magenta: '#c77bff',
  cyan: '#7dd3fc',
  white: '#f0f4f8',
  brightBlack: '#8b949e',
  brightRed: '#ff8b8b',
  brightGreen: '#6fe38b',
  brightYellow: '#ffe08a',
  brightBlue: '#40a9ff',
  brightMagenta: '#e099ff',
  brightCyan: '#a7e8ff',
  brightWhite: '#ffffff',
};

export function TerminalPanel({ conversationId }: { conversationId: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<'connecting' | 'ready' | 'closed' | 'error'>(
    'connecting',
  );
  const [cwd, setCwd] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      fontFamily: 'ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      allowProposedApi: true,
      theme,
      scrollback: 5000,
      convertEol: true,
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(container);

    // Defer fit slightly so the container has its final size.
    const doFit = () => {
      try {
        fitAddon.fit();
      } catch {
        // ignore
      }
    };

    let ws: WebSocket | null = null;
    let disposed = false;
    let sendQueue: string[] = [];

    async function connect() {
      try {
        const res = await fetch(`/api/terminal/${conversationId}/token`, { method: 'POST' });
        if (!res.ok) {
          throw new Error(`token request failed (${res.status})`);
        }
        const { token, wsPort, path } = (await res.json()) as {
          token: string;
          wsPort: number;
          path: string;
        };
        if (disposed) return;

        const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const url = `${proto}//${window.location.hostname}:${wsPort}${path}`;
        ws = new WebSocket(url);
        ws.binaryType = 'arraybuffer';

        ws.onopen = () => {
          // Send the auth frame as the first message.
          doFit();
          ws?.send(
            JSON.stringify({
              type: 'auth',
              token,
              cols: term.cols,
              rows: term.rows,
            }),
          );
        };

        ws.onmessage = (ev) => {
          if (typeof ev.data === 'string') {
            // Could be a control frame (JSON) or plain text output.
            try {
              const msg = JSON.parse(ev.data);
              if (msg?.type === 'ready') {
                setStatus('ready');
                setCwd(typeof msg.cwd === 'string' ? msg.cwd : null);
                // Flush any queued input that arrived before ready.
                for (const s of sendQueue) ws?.send(s);
                sendQueue = [];
                return;
              }
              if (msg?.type === 'exit') {
                term.write(`\r\n\x1b[2m[pty exited, code ${msg.code}]\x1b[0m\r\n`);
                setStatus('closed');
                return;
              }
              if (msg?.type === 'error') {
                setErrorMsg(String(msg.message ?? 'unknown error'));
                setStatus('error');
                return;
              }
            } catch {
              // Not JSON — treat as terminal output.
            }
            term.write(ev.data);
          } else if (ev.data instanceof ArrayBuffer) {
            term.write(new Uint8Array(ev.data));
          }
        };

        ws.onerror = () => {
          setStatus('error');
          setErrorMsg('WebSocket error');
        };
        ws.onclose = () => {
          setStatus((s) => (s === 'error' ? s : 'closed'));
        };
      } catch (err) {
        if (disposed) return;
        console.error('[terminal] connect failed', err);
        setStatus('error');
        setErrorMsg(err instanceof Error ? err.message : String(err));
      }
    }

    const sendInput = (data: string) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        sendQueue.push(data);
        return;
      }
      ws.send(data);
    };

    const disposableInput = term.onData(sendInput);

    // Fit on window resize.
    const onResize = () => {
      doFit();
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      }
    };
    window.addEventListener('resize', onResize);

    // Use ResizeObserver for panel toggles that change the container size
    // without firing a window resize.
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => onResize());
      ro.observe(container);
    }

    connect();
    // Kick an initial fit once the layout settles.
    const fitTimer = setTimeout(doFit, 50);

    return () => {
      disposed = true;
      clearTimeout(fitTimer);
      window.removeEventListener('resize', onResize);
      ro?.disconnect();
      disposableInput.dispose();
      try {
        ws?.close();
      } catch {
        // ignore
      }
      term.dispose();
    };
  }, [conversationId]);

  return (
    <div className="terminal-panel">
      <div className="terminal-header">
        <div className="terminal-title">
          Terminal
          {cwd && <span className="terminal-cwd">{cwd}</span>}
        </div>
        <div className={`terminal-status status-${status}`}>
          <span className="dot" />
          {status === 'connecting' && 'connecting'}
          {status === 'ready' && 'connected'}
          {status === 'closed' && 'closed'}
          {status === 'error' && (errorMsg ?? 'error')}
        </div>
      </div>
      <div className="terminal-body" ref={containerRef} />
    </div>
  );
}
