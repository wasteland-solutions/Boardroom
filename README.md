# Boardroom

A single-user self-hosted web app that is **a DM with Claude Code**.

One chat thread, one Claude Code agent. The backend runs Claude Code headlessly via the [Claude Agent SDK](https://docs.anthropic.com/en/docs/claude-code/agent-sdk), with its full tool suite (Bash, Read, Edit, Write, MCP, project hooks), token streaming, and permission prompts surfaced in the UI as message bubbles.

Think iMessage, but the person on the other end is Claude Code — and it can actually run commands and edit files in whatever project directory you point it at.

## Features

- **Multiple conversations in a sidebar.** Each conversation is one Claude Code session. Sessions resume across restarts via the SDK's `resume` option.
- **Two ways to authenticate.** Anthropic API key (billed to your Anthropic Console account) *or* your Claude Code login (billed to your Claude Max / Pro subscription). Toggle in Settings.
- **Per-conversation config.** Each conversation is bound to a working directory, a model (Opus / Sonnet / Haiku), and a permission mode (`ask` / `acceptEdits` / `bypassPermissions`).
- **Inline permission prompts.** In `ask` mode, every tool call that needs approval appears as a message bubble with Approve / Deny buttons. The agent pauses until you respond (or until the configurable timeout fires).
- **Token streaming.** Assistant responses stream token-by-token over SSE.
- **Project settings + hooks.** The agent loads `CLAUDE.md`, `.claude/settings.json`, and hooks from the target repo (`settingSources: ['project']`).
- **MCP servers.** Configure MCP servers in Settings — they're passed straight through to the SDK.
- **Persistent history.** Every message is stored in SQLite; the UI hydrates from SQLite on page load and SSE reconnects replay missed frames via `Last-Event-ID`.
- **Single-user OIDC SSO.** Auth via any standards-compliant OIDC provider (Google, Authentik, Keycloak, etc.). Only one `sub` / email is allowed.

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

Both processes run inside the same Docker container. The Next.js route handlers are thin RPC clients that talk to the agent worker over a local Unix socket.

## Quickstart with Docker Compose

### 1. Clone and configure

```bash
git clone https://github.com/wasteland-solutions/Boardroom.git
cd Boardroom
cp .env.example .env
```

Edit `.env` and fill in:

- `AUTH_SECRET` — generate with `openssl rand -base64 32`
- `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_REDIRECT_URI` — from your OIDC provider. Redirect URI should be `http://localhost:3000/api/auth/callback/oidc` (or your public URL).
- `ALLOWED_OIDC_EMAIL` *or* `ALLOWED_OIDC_SUBJECT` — only this identity will be allowed to sign in.
- `ANTHROPIC_API_KEY` — **only** if you plan to use the "Anthropic API key" auth mode. Leave blank to use your Claude Code login instead (see below).

### 2. Decide how to mount your project directories

The agent needs to see your code to be useful. In `docker-compose.yml` there's a `volumes:` section with `./workspaces:/workspaces` by default — drop or symlink your projects into `./workspaces`, or add extra mounts:

```yaml
volumes:
  - ./data:/app/data
  - ./workspaces:/workspaces
  - /Users/you/Code/my-app:/workspaces/my-app    # add as many as you like
```

Once the app is running, go to **Settings** → **Working directories** and add the container-side paths (e.g. `/workspaces/my-app`).

### 3. (Optional) Use your Claude Code login instead of an API key

If you want Boardroom to bill against your Claude Max / Pro subscription, run `claude login` on your host machine first, then uncomment this line in `docker-compose.yml`:

```yaml
- ${HOME}/.claude:/home/boardroom/.claude
```

Leave `ANTHROPIC_API_KEY` empty in `.env`, and after first boot go to **Settings** → **Authentication** and pick **Claude Code login**.

### 4. Boot it

```bash
docker compose up -d
docker compose logs -f boardroom
```

Open <http://localhost:3000>, sign in through your OIDC provider, click ⚙ to open Settings, pick your auth mode, add at least one working directory, save, then click **+** in the sidebar to start your first conversation.

### Updating

```bash
docker compose pull
docker compose up -d
```

Migrations run automatically on every container start — no manual step.

## Docker image

A prebuilt image is published to GHCR by the GitHub Actions workflow in [.github/workflows/docker.yml](.github/workflows/docker.yml):

- `ghcr.io/wasteland-solutions/boardroom:latest` — latest `main`
- `ghcr.io/wasteland-solutions/boardroom:sha-<sha>` — pinned to a specific commit

Or build it locally:

```bash
docker build -t boardroom .
```

## Running without Docker (for development)

```bash
pnpm install
cp .env.example .env    # fill in values as above
pnpm db:generate        # generate Drizzle migrations (only needed after schema changes)
pnpm db:migrate         # apply them
pnpm dev                # starts Next.js + agent worker together
```

The `dev` script runs `next dev` and `tsx watch src/agent/worker.ts` concurrently via the `concurrently` package.

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `AUTH_SECRET` | yes | Auth.js cookie encryption secret (`openssl rand -base64 32`) |
| `OIDC_ISSUER_URL` | yes | OIDC issuer URL (discovery endpoint used automatically) |
| `OIDC_CLIENT_ID` | yes | OIDC client id |
| `OIDC_CLIENT_SECRET` | yes | OIDC client secret |
| `OIDC_REDIRECT_URI` | yes | Must match what's registered with your provider |
| `ALLOWED_OIDC_SUBJECT` | one of | Only this `sub` claim may sign in |
| `ALLOWED_OIDC_EMAIL` | one of | Only this email may sign in |
| `ANTHROPIC_API_KEY` | conditional | Required only when Settings → Authentication is set to "Anthropic API key". Leave unset to use your Claude Code login. |
| `DATABASE_PATH` | no | Default: `/app/data/boardroom.db` in Docker, `./data/boardroom.db` locally |
| `AGENT_WORKER_SOCKET` | no | Unix socket path for Next.js ↔ worker RPC. Default: `/tmp/boardroom-agent.sock` in Docker |
| `PORT` | no | Default: `3000` |

## Authentication modes

Pick one in **Settings → Authentication**:

- **Anthropic API key** — the worker passes `ANTHROPIC_API_KEY` through to the Claude Code child process. Billed to your Anthropic Console account.
- **Claude Code login** — the worker strips `ANTHROPIC_API_KEY` from the environment before spawning the Claude Code CLI so it falls back to the OAuth token from `claude login`. Billed to your Claude Max / Pro subscription. On Docker, mount `${HOME}/.claude:/home/boardroom/.claude` so the CLI inside the container can read the token.

## Permission modes

Set the default in Settings and override per-conversation on creation:

- **ask** — every risky tool call surfaces as an Approve / Deny bubble; the agent pauses until you click. This is the safest default.
- **acceptEdits** — file edits auto-approve; other risky tools still prompt.
- **bypassPermissions** — full auto. Reserve this for disposable sandboxes.

## Security notes

- **Hooks execute inside the container.** Because the app passes `settingSources: ['project']` to the SDK, any hooks declared in a mounted repo's `.claude/settings.json` will run inside the worker process with the container's privileges. **Don't mount untrusted repos.**
- **Bind the port to localhost in production.** The OIDC flow is single-user, but the SSE endpoint assumes a trusted network. If you expose Boardroom publicly, put it behind a reverse proxy with TLS.
- **The `workspaces` volume is read-write.** Claude Code can create, edit, and delete files in whatever you mount. Keep backups.

## Repo layout

```
src/
  agent/          Standalone Node worker that owns the Claude Agent SDK
    worker.ts        Entry: Unix socket server, session manager, graceful shutdown
    sdk-runner.ts    query() wrapper, streaming input, token pumping, tool events
    permission-broker.ts  canUseTool → Promise + timeout + abort
    session-manager.ts    Per-conversation Query map with idle sweep
    persistence.ts   Monotonic seq + SQLite writes
    rpc.ts           JSONL Unix-socket RPC server + fanout
  app/            Next.js App Router (frontend + route handlers)
    api/
      stream/[conversationId]/    SSE stream (Last-Event-ID replay)
      input/[conversationId]/     POST: send | permission_reply | interrupt
      conversations/              CRUD
      settings/                   GET/PUT app settings
      cwds/                       Working directory allowlist
      auth/[...nextauth]/         Auth.js OIDC handlers
    c/[conversationId]/page.tsx   Chat view
    settings/page.tsx             Settings view
  components/     ChatShell, SettingsForm, etc.
  lib/            db, schema, types, auth, agent-client (RPC), bus, settings-store
  middleware.ts   Auth.js route protection
drizzle/          Generated migrations
scripts/          migrate.ts + start.mjs (prod entrypoint)
Dockerfile
docker-compose.yml
```

## License

See [LICENSE](./LICENSE).
