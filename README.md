# Boardroom

A self-hosted web app for chatting with coding agents. Pick a provider — **Claude Code** or **Codex (OpenAI)** — point it at a workspace (local or SSH), and start a conversation. The agent can read, edit, and run commands in your project while you watch tokens stream in real time.

## Features

- **Two providers.** Claude Code (via the Agent SDK) and Codex (via `codex exec --json`). Each conversation picks one at creation time.
- **Local and remote workspaces.** Local absolute paths or `ssh://` URIs. For SSH workspaces the agent runs on the remote host over a `ControlMaster`-multiplexed connection. A built-in directory browser lets you navigate the filesystem (local or remote) before picking a workspace.
- **Side-panel terminal.** Each conversation has an attached pty (xterm.js + node-pty) in the workspace cwd. For SSH workspaces it's a real shell on the remote box. Chat and terminal can be shown together, individually, or swapped.
- **Inline permission prompts.** In `ask` mode every risky tool call surfaces as an Approve / Deny bubble. The agent pauses until you respond.
- **Token streaming.** Responses stream token-by-token over SSE.
- **Slash commands.** `/` in the composer shows an autocomplete popup — agent skills plus Boardroom built-ins (`/clear`, `/archive`, `/info`).
- **Archive + delete.** Archive tears down the agent session and hides the conversation. Delete permanently removes it and its on-disk session file.
- **Persistent history.** Every message stored in SQLite. SSE reconnects replay missed frames.
- **Credentials in the UI.** Anthropic API key, Claude Code OAuth token, and OpenAI API key are all pasted in Settings and stored encrypted at rest. No env-var editing required after first boot.
- **Sign-in.** Username + password, OIDC SSO, or both.

## Quickstart

```bash
git clone https://github.com/wasteland-solutions/Boardroom.git
cd Boardroom
npm install
cp .env.example .env    # set AUTH_SECRET + sign-in credentials
npm run db:migrate
npm run dev
```

Open <http://localhost:3000>, sign in, go to **Settings** to paste your API key(s) and add a working directory, then click **+** to start a conversation.

### Docker (optional)

Docker files are in the `docker/` folder. See `docker/docker-compose.yml` for usage.

## Environment variables

| Variable | Required | Default |
|---|---|---|
| `AUTH_SECRET` | yes | — |
| `BOARDROOM_USERNAME` | one of | — |
| `BOARDROOM_PASSWORD` | one of | — |
| `OIDC_ISSUER_URL` | one of | — |
| `OIDC_CLIENT_ID` | with OIDC | — |
| `OIDC_CLIENT_SECRET` | with OIDC | — |
| `OIDC_REDIRECT_URI` | with OIDC | `http://localhost:3000/api/auth/callback/oidc` |
| `ALLOWED_OIDC_EMAIL` | with OIDC | — |
| `ANTHROPIC_API_KEY` | no | — |
| `DATABASE_PATH` | no | `./data/boardroom.db` |
| `AGENT_WORKER_WS_PORT` | no | `8099` |
| `PORT` | no | `3000` |

API keys are optional in `.env` — the primary path is pasting them in Settings after sign-in.

## SSH workspaces

Add a workspace as `ssh://user@host/path` (or `user@host:/path`). Requirements on the remote:

- **Non-interactive key auth** (`BatchMode=yes`). Use `ssh-agent` or `~/.ssh/config`.
- **`claude` or `codex` on PATH** (whichever provider you're using). Boardroom captures PATH from a `bash -lic` subshell so nvm/asdf/mise-managed installs are visible.
- **Auth configured on the remote.** Boardroom does not forward local credentials. Run `claude auth login` or `codex login` on the remote once.

## Agent identity

Boardroom passes `settingSources: ['project']` to the Claude SDK, so the agent loads `CLAUDE.md`, `.claude/settings.json`, and any custom agents/skills/commands from the workspace itself. For Codex, any `AGENTS.md` or similar convention files in the workspace are available to the agent via its tools.

The agent's identity is determined entirely by what's in the workspace — not by `~/.claude/` on the host.

## Security

- All security headers set (CSP, HSTS, X-Frame-Options, etc.).
- Auth rate-limited (5 attempts / 60s).
- API keys encrypted at rest (AES-256-GCM derived from AUTH_SECRET).
- Terminal WebSocket authenticated via short-lived HMAC tokens with origin validation.
- SSH command injection surface hardened (disallowed characters in browse paths).
- Cookies use `Secure` flag in production.

## License

See [LICENSE](./LICENSE).
