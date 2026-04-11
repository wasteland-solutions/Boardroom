# Boardroom

A self-hosted web UI for [Claude Code](https://docs.anthropic.com/en/docs/claude-code). Point it at a workspace — local path or SSH remote — and chat with an agent that can read, edit, and run commands in your project while you watch tokens stream in real time.

Built with Next.js, the [Claude Agent SDK](https://github.com/anthropic-ai/claude-code-sdk-python), SQLite, and xterm.js.

## Features

- **Local and remote workspaces.** Local absolute paths or `ssh://user@host/path` URIs. Remote workspaces connect through the Claude Code remote control server (`~/.claude/remote/rpc.sock`), eliminating PATH issues and bootstrap complexity.
- **Side-panel terminal.** Each conversation gets an attached terminal (xterm.js + node-pty) in the workspace directory. For SSH workspaces it opens a shell on the remote host. Chat and terminal can be shown together or individually.
- **Inline permission prompts.** In `ask` mode, every tool call surfaces as an Approve / Deny card in the chat. The agent pauses until you respond.
- **Markdown and syntax highlighting.** Assistant responses render full markdown — headers, lists, tables, code blocks with syntax highlighting (highlight.js).
- **Token streaming.** Responses stream token-by-token over Server-Sent Events.
- **Slash commands.** Type `/` in the composer for an autocomplete popup with agent skills and built-in commands.
- **Persistent history.** Every message stored in SQLite. Reconnecting replays missed frames automatically.
- **Credentials in the UI.** Paste your Anthropic API key or Claude Code OAuth token in Settings — stored encrypted at rest (AES-256-GCM). No env-var editing required after first boot.
- **Sign-in.** Username + password, OIDC SSO (Google, Authentik, Keycloak, etc.), or both.

## Quickstart

**Prerequisites:** Node 22+, build tools (`sudo apt-get install -y build-essential` on Ubuntu, `xcode-select --install` on macOS).

```bash
git clone https://github.com/wasteland-solutions/Boardroom.git
cd Boardroom
npm install
npm run setup       # creates data/, .env, runs migrations, checks prerequisites
                    # edit .env — set BOARDROOM_USERNAME and BOARDROOM_PASSWORD
npm run build       # compile Next.js + agent worker
npm start           # production server on http://localhost:3000
```

Open http://localhost:3000, sign in, go to **Settings** to paste your API key and add a working directory, then click **+** to start a conversation.

### Development

For local development with hot reload:

```bash
npm run dev         # runs Next.js + agent worker with file watching
```

### Docker

```bash
cd docker
cp ../.env.example .env
# edit .env — set AUTH_SECRET, BOARDROOM_USERNAME, BOARDROOM_PASSWORD
docker compose up -d
```

The container exposes port 3000 (web) and 8099 (terminal WebSocket). Mount your project directories as volumes so Claude Code can access them inside the container — see `docker/docker-compose.yml` for examples.

For SSH workspaces from Docker, mount your SSH keys:

```yaml
volumes:
  - ~/.ssh:/home/boardroom/.ssh:ro
```

## Environment variables

All variables are documented in [`.env.example`](./.env.example).

| Variable | Required | Default | Description |
|---|---|---|---|
| `AUTH_SECRET` | yes | — | Cookie encryption + credential encryption key. Generate with `openssl rand -base64 32` |
| `BOARDROOM_USERNAME` | one of | — | Simple auth username |
| `BOARDROOM_PASSWORD` | one of | — | Simple auth password |
| `OIDC_ISSUER_URL` | one of | — | OIDC provider discovery URL |
| `OIDC_CLIENT_ID` | with OIDC | — | OIDC client ID |
| `OIDC_CLIENT_SECRET` | with OIDC | — | OIDC client secret |
| `OIDC_REDIRECT_URI` | with OIDC | `http://localhost:3000/api/auth/callback/oidc` | OIDC callback URL |
| `ALLOWED_OIDC_SUBJECT` | with OIDC | — | OIDC subject (`sub`) allowed to sign in |
| `ALLOWED_OIDC_EMAIL` | with OIDC | — | Email address allowed to sign in |
| `ANTHROPIC_API_KEY` | no | — | Optional pre-seed (can paste in Settings instead) |
| `DATABASE_PATH` | no | `./data/boardroom.db` | SQLite database file path |
| `AGENT_WORKER_WS_PORT` | no | `8099` | Terminal WebSocket port |
| `AGENT_WORKER_WS_HOST` | no | `127.0.0.1` | WebSocket bind address (`0.0.0.0` for Docker) |
| `NEXTAUTH_URL` | production | — | Public URL (e.g. `https://boardroom.example.com`). Enables `Secure` cookie flag |
| `PORT` | no | `3000` | Web server port |

You need at least one sign-in method: either `BOARDROOM_USERNAME` + `BOARDROOM_PASSWORD`, or the `OIDC_*` variables. Both can be enabled simultaneously.

## SSH workspaces

Add a workspace as `ssh://user@host/path` (or `user@host:/path`) in Settings. Requirements on the remote host:

1. **Non-interactive SSH key auth.** Boardroom connects with `BatchMode=yes`. Configure your key in `~/.ssh/config` or use `ssh-agent`.
2. **Claude Code remote server running.** The server at `~/.claude/remote/server` must be active with its `rpc.sock` socket. Boardroom tunnels to it and spawns the CLI through its RPC protocol.
3. **Auth configured on the remote.** Boardroom does not forward local credentials. Run `claude auth login` on the remote host once.

## Agent identity

Boardroom passes `settingSources: ['project']` to the Claude Agent SDK. The agent loads `CLAUDE.md`, `.claude/settings.json`, and any custom skills or commands from the workspace itself.

The agent's personality is determined entirely by the workspace — not by `~/.claude/` on the Boardroom host. This makes each workspace self-contained and reproducible across machines.

## Architecture

```
Browser ──SSE/POST──> Next.js API ──JSONL/Unix socket──> Agent Worker
                                                            |
                                                    +-------+-------+
                                                    |               |
                                              Local spawn    SSH tunnel to
                                              (Agent SDK)    rpc.sock on remote
                                                    |               |
                                                 claude          claude
                                                (local)         (remote)
```

**Tech stack:**

- **Frontend:** Next.js 16, React 19, xterm.js
- **Backend:** Next.js API routes + standalone agent worker process
- **Database:** SQLite via better-sqlite3 + Drizzle ORM
- **Auth:** NextAuth v5 (credentials + OIDC)
- **Agent:** Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`)
- **IPC:** JSONL over Unix domain socket (Next.js <-> agent worker)
- **Streaming:** Server-Sent Events (agent worker -> browser)
- **Terminal:** WebSocket + node-pty (agent worker -> browser via xterm.js)

The agent worker is a long-running Node process spawned alongside Next.js. It manages Claude sessions, permission prompts, and terminal ptys. For remote workspaces, it opens an SSH tunnel to the remote host's `~/.claude/remote/rpc.sock` and spawns Claude through the remote control server's JSON-RPC protocol.

## Security

- Login rate-limited at 3 attempts per 60 seconds (HTTP 429 with `Retry-After` header).
- API keys encrypted at rest (AES-256-GCM derived from `AUTH_SECRET`).
- Security headers on every response: CSP, HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy.
- `unsafe-eval` removed from CSP in production builds.
- Terminal WebSocket binds to `127.0.0.1` by default; authenticated via short-lived HMAC tokens with Origin header validation.
- `.env` and database files set to `chmod 600` at startup.
- Cookies use `Secure` flag when `NEXTAUTH_URL` is HTTPS.
- `robots.txt` disallows all crawlers.

## License

Apache 2.0 — see [LICENSE](./LICENSE).
