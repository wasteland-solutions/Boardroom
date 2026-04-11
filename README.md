# Boardroom

A self-hosted web UI for Claude Code. Point it at a workspace — local path or SSH remote — and chat with an agent that can read, edit, and run commands in your project while you watch tokens stream in real time.

## Features

- **Local and remote workspaces.** Local absolute paths or `ssh://user@host/path` URIs. Remote workspaces connect through the Claude Code remote control server (`~/.claude/remote/rpc.sock`), so PATH issues and bootstrap complexity are eliminated.
- **Side-panel terminal.** Each conversation has an attached pty (xterm.js + node-pty) in the workspace directory. For SSH workspaces it's a shell on the remote host. Chat and terminal can be shown together or swapped.
- **Inline permission prompts.** In `ask` mode every tool call surfaces as an Approve / Deny bubble. The agent pauses until you respond.
- **Token streaming.** Responses stream token-by-token over SSE with markdown rendering and syntax-highlighted code blocks.
- **Slash commands.** `/` in the composer shows an autocomplete popup with agent skills and built-in commands.
- **Persistent history.** Every message stored in SQLite. SSE reconnects replay missed frames.
- **Credentials in the UI.** Anthropic API key or Claude Code OAuth token — paste in Settings, stored encrypted at rest.
- **Sign-in.** Username + password, OIDC SSO (Google, Authentik, Keycloak, etc.), or both.

## Quickstart

**Prerequisites:** Node 22+, build tools (`sudo apt-get install -y build-essential` on Ubuntu, `xcode-select --install` on macOS).

```bash
git clone https://github.com/wasteland-solutions/Boardroom.git
cd Boardroom
npm install
npm run setup    # creates data/, .env, runs migrations, checks prerequisites
# edit .env — set BOARDROOM_USERNAME and BOARDROOM_PASSWORD
npm run dev
```

Open http://localhost:3000, sign in, go to **Settings** to paste your API key and add a working directory, then click **+** to start a conversation.

### Docker

```bash
cd docker
cp ../.env.example .env
# edit .env — set AUTH_SECRET, BOARDROOM_USERNAME, BOARDROOM_PASSWORD
docker compose up -d
```

See `docker/docker-compose.yml` for volume mounts and port configuration.

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `AUTH_SECRET` | yes | — | Cookie encryption secret. Generate: `openssl rand -base64 32` |
| `BOARDROOM_USERNAME` | one of | — | Simple auth username |
| `BOARDROOM_PASSWORD` | one of | — | Simple auth password |
| `OIDC_ISSUER_URL` | one of | — | OIDC provider discovery URL |
| `OIDC_CLIENT_ID` | with OIDC | — | OIDC client ID |
| `OIDC_CLIENT_SECRET` | with OIDC | — | OIDC client secret |
| `ALLOWED_OIDC_EMAIL` | with OIDC | — | Email address allowed to sign in |
| `ANTHROPIC_API_KEY` | no | — | Optional pre-seed (can paste in Settings instead) |
| `DATABASE_PATH` | no | `./data/boardroom.db` | SQLite database file |
| `AGENT_WORKER_WS_PORT` | no | `8099` | Terminal WebSocket port |
| `AGENT_WORKER_WS_HOST` | no | `127.0.0.1` | WebSocket bind address (`0.0.0.0` in Docker) |
| `NEXTAUTH_URL` | no | — | Public URL for production (enables `Secure` cookies) |
| `PORT` | no | `3000` | Web server port |

## SSH workspaces

Add a workspace as `ssh://user@host/path` (or `user@host:/path`). Requirements on the remote:

- **Non-interactive key auth** (`BatchMode=yes`). Use `ssh-agent` or `~/.ssh/config`.
- **Claude Code remote server running.** The server binary at `~/.claude/remote/server` must be active — Boardroom tunnels to its `rpc.sock` and spawns the CLI through it.
- **Auth configured on the remote.** Boardroom does not forward local credentials. Run `claude auth login` on the remote once.

## Agent identity

Boardroom passes `settingSources: ['project']` to the Claude Agent SDK, so the agent loads `CLAUDE.md`, `.claude/settings.json`, and any custom agents, skills, or commands from the workspace itself.

The agent's identity is determined entirely by what's in the workspace — not by `~/.claude/` on the Boardroom host.

## Architecture

```
Browser ──SSE/POST──▶ Next.js API ──JSONL/Unix socket──▶ Agent Worker
                                                            │
                                                    ┌───────┴───────┐
                                                    │               │
                                              Local spawn    SSH tunnel to
                                              (Agent SDK)    rpc.sock on remote
                                                    │               │
                                                 claude          claude
                                                (local)         (remote)
```

- **Next.js** serves the UI and API routes. Auth via NextAuth (credentials or OIDC).
- **Agent Worker** is a long-running Node process that manages sessions, permissions, and terminal ptys. Communicates with Next.js over a Unix domain socket using JSONL-RPC.
- **Local workspaces** spawn Claude via the Agent SDK directly.
- **Remote workspaces** open an SSH tunnel to the remote host's `~/.claude/remote/rpc.sock` and spawn Claude through the remote control server's JSON-RPC protocol.

## Security

- Rate limiting on login (3 attempts / 60s, returns HTTP 429).
- API keys encrypted at rest (AES-256-GCM derived from `AUTH_SECRET`).
- CSP, HSTS, X-Frame-Options, X-Content-Type-Options headers on every response.
- `unsafe-eval` stripped from CSP in production.
- WebSocket binds to loopback only by default; authenticated via short-lived HMAC tokens.
- `.env` and database files `chmod 600` at startup.
- Terminal WebSocket validates Origin header to prevent cross-site hijacking.
- Cookies use `Secure` flag when `NEXTAUTH_URL` starts with `https://`.

## License

See [LICENSE](./LICENSE).
