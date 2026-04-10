import { createServer, type Server as HttpServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { verifyTerminalToken } from '../lib/terminal-token';
import { ptyManager } from './pty-manager';

// WebSocket server used exclusively for terminal IO. Listens on its own
// port (default 8099) so it's trivial to expose via docker-compose and
// doesn't need to share port 3000 with Next.js.
//
// Protocol:
//   - Client connects to ws://host:port/terminal
//   - First message from the client must be a JSON frame:
//       {"type":"auth","token":"...","cols":80,"rows":24}
//     The token is verified via verifyTerminalToken() (HMAC against
//     AUTH_SECRET). If auth fails the socket is closed with code 4401.
//   - After a successful auth, binary frames from client → server are
//     forwarded to the pty stdin (keystrokes), and pty stdout is forwarded
//     as text frames to the client.
//   - JSON control frames from client: {"type":"resize","cols":X,"rows":Y}
//   - Server pushes a {"type":"exit","code":N} JSON frame when the pty
//     exits, then closes the socket.

export class TerminalWsServer {
  private http: HttpServer | null = null;
  private wss: WebSocketServer | null = null;

  constructor(private readonly port: number) {}

  listen() {
    this.http = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('Boardroom agent WebSocket endpoint — use /terminal\n');
    });

    this.wss = new WebSocketServer({
      server: this.http,
      path: '/terminal',
      // Validate the Origin header to prevent cross-site WebSocket
      // hijacking. Only connections from the same host are allowed.
      verifyClient: (info: { origin?: string; req: { headers: Record<string, string | string[] | undefined> } }) => {
        const origin = info.origin || (typeof info.req.headers.origin === 'string' ? info.req.headers.origin : undefined);
        if (!origin) return true; // Non-browser clients (curl, node) don't send Origin
        try {
          const url = new URL(origin);
          const hostHeader = typeof info.req.headers.host === 'string' ? info.req.headers.host : '';
          const host = hostHeader.split(':')[0];
          // Allow same-hostname connections (any port — the WS port differs
          // from the Next.js port by design).
          return url.hostname === host || url.hostname === 'localhost' || url.hostname === '127.0.0.1';
        } catch {
          return false;
        }
      },
    });

    this.wss.on('connection', (ws) => {
      this.handleConnection(ws);
    });

    return new Promise<void>((resolve, reject) => {
      this.http!.once('error', reject);
      this.http!.listen(this.port, () => {
        console.log(`[ws-server] terminal WebSocket listening on :${this.port}/terminal`);
        resolve();
      });
    });
  }

  private handleConnection(ws: WebSocket) {
    let authed = false;
    let session: ReturnType<typeof ptyManager.attach> = null;

    const sendJson = (obj: unknown) => {
      try {
        ws.send(JSON.stringify(obj));
      } catch {
        // ignore
      }
    };

    // Auth timeout: if the client doesn't send a valid auth frame within
    // 5 seconds, close the socket.
    const authTimeout = setTimeout(() => {
      if (!authed) {
        try {
          ws.close(4408, 'auth timeout');
        } catch {
          // ignore
        }
      }
    }, 5_000);

    ws.on('message', (data, isBinary) => {
      // --- Auth phase ---
      if (!authed) {
        if (isBinary) {
          try {
            ws.close(4400, 'auth required');
          } catch {
            // ignore
          }
          return;
        }
        let msg: { type?: string; token?: string; cols?: number; rows?: number };
        try {
          msg = JSON.parse(data.toString());
        } catch {
          try {
            ws.close(4400, 'invalid auth');
          } catch {
            // ignore
          }
          return;
        }
        if (msg.type !== 'auth' || typeof msg.token !== 'string') {
          try {
            ws.close(4400, 'invalid auth');
          } catch {
            // ignore
          }
          return;
        }
        const verified = verifyTerminalToken(msg.token);
        if (!verified) {
          try {
            ws.close(4401, 'invalid token');
          } catch {
            // ignore
          }
          return;
        }
        const cols = Number(msg.cols) || 80;
        const rows = Number(msg.rows) || 24;

        session = ptyManager.attach(
          verified.conversationId,
          {
            onData: (chunk) => {
              try {
                ws.send(chunk);
              } catch {
                // ignore
              }
            },
            onExit: (code) => {
              sendJson({ type: 'exit', code });
              try {
                ws.close(1000, 'pty exit');
              } catch {
                // ignore
              }
            },
          },
          cols,
          rows,
        );

        if (!session) {
          sendJson({ type: 'error', message: 'failed to attach pty — is the cwd still allowed?' });
          try {
            ws.close(4404, 'pty unavailable');
          } catch {
            // ignore
          }
          return;
        }

        authed = true;
        clearTimeout(authTimeout);
        sendJson({ type: 'ready', cwd: session.cwd });
        return;
      }

      // --- Authenticated phase ---
      if (!session) return;

      if (isBinary) {
        // Binary from client = keystrokes to the pty.
        session.write(data.toString('utf8'));
        return;
      }

      // Text messages should be JSON control frames OR plain keystrokes.
      const str = data.toString();
      // Try to parse as JSON control frame; if that fails, treat as text
      // input (some xterm clients default to text frames).
      try {
        const msg = JSON.parse(str) as { type?: string; cols?: number; rows?: number; data?: string };
        if (msg.type === 'resize' && typeof msg.cols === 'number' && typeof msg.rows === 'number') {
          session.resize(msg.cols, msg.rows);
          return;
        }
        if (msg.type === 'input' && typeof msg.data === 'string') {
          session.write(msg.data);
          return;
        }
      } catch {
        // Plain text → treat as keystrokes.
      }
      session.write(str);
    });

    ws.on('close', () => {
      clearTimeout(authTimeout);
      if (session) {
        session.detach();
        session = null;
      }
    });

    ws.on('error', (err) => {
      console.error('[ws-server] socket error:', err);
    });
  }

  close() {
    ptyManager.killAll();
    if (this.wss) this.wss.close();
    if (this.http) this.http.close();
  }
}
