# Boardroom

A single-user web app that is "a DM with Claude Code" — one chat thread that runs Claude Code headlessly via the [Claude Agent SDK](https://docs.anthropic.com/en/docs/claude-code/agent-sdk), with its full tool suite, token streaming, and permission prompts surfaced in the UI.

Self-host it, sign in through your OIDC provider, pick a working directory, and chat with Claude Code as if it were a normal messaging app — with all its agentic powers (Bash, Read, Edit, Write, MCP servers, project-level hooks) intact.

## What it does

- **Two ways to authenticate.** Use the Anthropic API key (billed to your Anthropic Console account) *or* your Claude Code login (billed to your Claude Max / Pro subscription). Toggle in Settings.
- **Multiple conversations in a sidebar.** Each conversation is one Claude Code session. Sessions resume across restarts via the SDK's `resume` option.
- **Per-conversation configuration.** Each conversation is bound to a working directory, model (Opus / Sonnet / Haiku), and permission mode (`ask` / `acceptEdits` / `bypassPermissions`).
- **Inline permission prompts.** In `ask` mode, every tool call that needs approval appears as a message bubble with Approve / Deny buttons. The agent pauses until you respond (or until the configurable timeout fires).
- **Token streaming.** Assistant responses stream token-by-token over SSE.
- **Project settings + hooks.** The agent loads `CLAUDE.md`, `.claude/settings.json`, and hooks from the target repo (`settingSources: ['project']`).
- **MCP servers.** Configure MCP servers in settings — they're passed through to the SDK.
- **Persistent history.** Every message is stored in SQLite and hydrated on page load. SSE reconnects replay missed frames via `Last-Event-ID`.
- **Single-user OIDC SSO.** Auth via any standards-compliant OIDC provider; only one subject/email is allowed.

## Architecture

Two processes, one SQLite database:

```
┌────────────────────────┐         ┌──────────────────────────────┐
│  Next.js (App Router)  │         │  Agent Worker (Node)         │
│  - UI (React)          │         │  - owns Claude Agent SDK     │
│  - Auth.js OIDC        │ ◄─────► │  - per-conv Query map        │
│  - SSE /stream         │  Unix   │  - canUseTool broker         │
│  - POST /input         │  socket │  - SDKMessage → SQLite       │
│  - better-sqlite3      │  JSONL  │  - interrupt / setModel      │
└────────────────────────┘         └──────────────────────────────┘
            │                                   │
            └──────────────┬────────────────────┘
                           ▼
                    ┌─────────────┐
                    │ SQLite (WAL)│
                    └─────────────┘
```

The agent worker is a standalone Node process that owns all `query()` calls and the `claude-code` child process. The Next.js route handlers are thin RPC clients that talk to it over a local Unix domain socket (JSONL protocol).

## Setup

### Prerequisites

- Node.js 22+
- pnpm
- Claude Code CLI: `pnpm add -g @anthropic-ai/claude-code`
- An OIDC provider (Google, Authentik, Keycloak, etc.)

### Run locally

```bash
cp .env.example .env
# Fill in ANTHROPIC_API_KEY, OIDC_*, ALLOWED_OIDC_EMAIL (or _SUBJECT), AUTH_SECRET

pnpm install
pnpm db:generate   # generate Drizzle migrations
pnpm db:migrate    # apply them
pnpm dev           # starts Next.js + agent worker together
```

Open <http://localhost:3000>, sign in, go to **Settings**, add at least one working directory, save, then click **+** in the sidebar to create your first conversation.

### Docker

```bash
docker build -t boardroom .
docker run --rm \
  -p 3000:3000 \
  --env-file .env \
  -v $PWD/data:/app/data \
  -v /path/to/your/project:/workspace \
  boardroom
```

The image preinstalls the Claude Code CLI. Mount whatever directories you want to expose as working dirs.

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | conditional | Required only when Settings → Authentication is set to "Anthropic API key". Leave unset to use your Claude Code login. |
| `AUTH_SECRET` | yes | Auth.js cookie encryption secret (`openssl rand -base64 32`) |
| `OIDC_ISSUER_URL` | yes | OIDC issuer (discovery endpoint used automatically) |
| `OIDC_CLIENT_ID` | yes | OIDC client id |
| `OIDC_CLIENT_SECRET` | yes | OIDC client secret |
| `OIDC_REDIRECT_URI` | yes | Must match what's registered with your provider |
| `ALLOWED_OIDC_SUBJECT` | one of | Only this `sub` may sign in |
| `ALLOWED_OIDC_EMAIL` | one of | Only this email may sign in |
| `DATABASE_PATH` | no | Default: `./data/boardroom.db` |
| `AGENT_WORKER_SOCKET` | no | Default: `./.agent.sock` |
| `PORT` | no | Default: `3000` |

## Authentication modes

Pick one in **Settings → Authentication**:

- **Anthropic API key** — the worker passes `ANTHROPIC_API_KEY` through to the Claude Code child process. Billed to your Anthropic Console account.
- **Claude Code login** — the worker strips `ANTHROPIC_API_KEY` from the environment before spawning the Claude Code CLI so it falls back to the OAuth token from `claude login`. Billed to your Claude Max / Pro subscription. You must have run `claude login` on the host; for Docker, mount your credentials (`-v ~/.claude:/root/.claude`).

## Security note

Because the app passes `settingSources: ['project']` to the Agent SDK, any hooks declared in the target repo's `.claude/settings.json` will run inside the worker process with the worker's environment and privileges. **Don't connect Boardroom to untrusted repositories.**

## License

See [LICENSE](./LICENSE).
