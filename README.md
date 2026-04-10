# Boardroom

A single-user self-hosted web app that is **a DM with Claude Code**.

One chat thread, one Claude Code agent. The backend runs Claude Code headlessly via the [Claude Agent SDK](https://docs.anthropic.com/en/docs/claude-code/agent-sdk), with its full tool suite (Bash, Read, Edit, Write, MCP, project hooks), token streaming, and permission prompts surfaced in the UI as message bubbles.

Think iMessage, but the person on the other end is Claude Code — and it can actually run commands and edit files in whatever project directory you point it at.

## Features

- **Multiple conversations in a sidebar.** Each conversation is one Claude Code session. Sessions resume across restarts via the SDK's `resume` option.
- **Two ways to authenticate with Anthropic.** Paste an Anthropic API key (billed to your Anthropic Console account) *or* a Claude Code OAuth token (billed to your Claude Max / Pro subscription). Both are configured in Settings — no host credential mounts, no env-var gymnastics.
- **Per-conversation config.** Each conversation is bound to a working directory, a model (Opus / Sonnet / Haiku), and a permission mode (`ask` / `acceptEdits` / `bypassPermissions`).
- **Inline permission prompts.** In `ask` mode, every tool call that needs approval appears as a message bubble with Approve / Deny buttons. The agent pauses until you respond (or until the configurable timeout fires).
- **Token streaming.** Assistant responses stream token-by-token over SSE.
- **Project settings + hooks.** The agent loads `CLAUDE.md`, `.claude/settings.json`, and hooks from the target repo (`settingSources: ['project']`).
- **MCP servers.** Configure MCP servers in Settings — they're passed straight through to the SDK.
- **Persistent history.** Every message is stored in SQLite; the UI hydrates from SQLite on page load and SSE reconnects replay missed frames via `Last-Event-ID`.
- **Pick your auth.** Single-user username + password (set in `.env`) *or* OIDC SSO (Google, Authentik, Keycloak, …), or both at once. Whichever you configure shows up on the sign-in page.

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
- **Sign-in method** — pick one or both:
  - **Username/password (simplest):** set `BOARDROOM_USERNAME` and `BOARDROOM_PASSWORD`. Done.
  - **OIDC SSO:** set `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_REDIRECT_URI` (typically `http://localhost:3000/api/auth/callback/oidc`) and either `ALLOWED_OIDC_EMAIL` or `ALLOWED_OIDC_SUBJECT`.
- `ANTHROPIC_API_KEY` — **only** if you plan to use the "Anthropic API key" auth mode. Leave blank to use your Claude Code login instead (see below).

### 2. Mount your project directories into the container

**This is the step most people miss.** Claude Code runs *inside* the container, so it can only see files under paths you explicitly mount in from your host.

Open `docker-compose.yml` and find the `volumes:` block. There's a default mount of `./workspaces:/workspaces` — any projects you drop (or symlink) into `./workspaces` on your host become visible to the container at `/workspaces`.

Or mount specific projects directly:

```yaml
volumes:
  - ./data:/app/data                          # keep this — SQLite lives here
  - ./workspaces:/workspaces                  # default workspaces folder
  - /Users/you/Code/my-app:/workspaces/my-app # your real project, mounted directly
  - /Users/you/Code/website:/workspaces/website
```

**After boot**, go to **Settings → Working directories** and add the **container-side** path (the part after the colon, e.g. `/workspaces/my-app`) — not the host path. Claude Code's `cwd` will be set to that directory for every conversation bound to it.

### 3. (Optional) Pre-seed your Anthropic API key

You can paste it into **Settings → Credentials** after first sign-in, but if you'd rather have it ready on boot, set `ANTHROPIC_API_KEY` in `.env`. The UI value always takes precedence if both are set.

### 4. Boot it

```bash
docker compose up -d
docker compose logs -f boardroom
```

Open <http://localhost:3000>, sign in, click ⚙ to open Settings, and configure:

1. **Credentials** — pick *Anthropic API key* and paste one from [console.anthropic.com](https://console.anthropic.com/settings/keys), *or* pick *Claude Code subscription* and paste a token you get from running `claude setup-token` on any machine where you're already logged in. See [Authentication modes](#authentication-modes) below.
2. **Working directories** — add the container-side path(s) of whatever projects you mounted.
3. Save.

Then click **+** in the sidebar to start your first conversation.

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
| `BOARDROOM_USERNAME` | one of | Username for the local password sign-in. Required only if you don't configure OIDC. |
| `BOARDROOM_PASSWORD` | one of | Password for the local sign-in. Compared in constant time. |
| `OIDC_ISSUER_URL` | one of | OIDC issuer URL (discovery endpoint used automatically). Required only if you don't use local password auth. |
| `OIDC_CLIENT_ID` | with OIDC | OIDC client id |
| `OIDC_CLIENT_SECRET` | with OIDC | OIDC client secret |
| `OIDC_REDIRECT_URI` | with OIDC | Must match what's registered with your provider |
| `ALLOWED_OIDC_SUBJECT` | with OIDC | Only this `sub` claim may sign in (either this or `ALLOWED_OIDC_EMAIL`) |
| `ALLOWED_OIDC_EMAIL` | with OIDC | Only this email may sign in |
| `ANTHROPIC_API_KEY` | no | Optional pre-seed for the API key shown in Settings → Credentials. The UI value overrides this if both are set. |
| `DATABASE_PATH` | no | Default: `/app/data/boardroom.db` in Docker, `./data/boardroom.db` locally |
| `AGENT_WORKER_SOCKET` | no | Unix socket path for Next.js ↔ worker RPC. Default: `/tmp/boardroom-agent.sock` in Docker |
| `PORT` | no | Default: `3000` |

You must configure **at least one** sign-in method: either `BOARDROOM_USERNAME` + `BOARDROOM_PASSWORD`, or the full set of `OIDC_*` vars + one `ALLOWED_OIDC_*`. Both can be enabled at the same time.

## Remote workspaces (SSH)

Workspaces can be either local absolute paths or **SSH URIs**. When you bind a conversation to a remote workspace, Boardroom runs `claude` *on the remote host* over an SSH ControlMaster connection, and the terminal panel drops you into a real interactive shell on the same box.

Add a remote workspace in **Settings → Working directories** with a path like:

```
ssh://andre@dev.example.com/home/andre/Code/my-app
ssh://devbox:2222/srv/projects/web
```

Format is `ssh://[user@]host[:port]/absolute/remote/path`.

### What Boardroom does under the hood

- **Claude:** the SDK is pointed at `scripts/boardroom-claude-ssh.mjs`, a small wrapper that exec's `ssh -o ControlMaster=auto … host -- 'cd /remote/path && exec claude …'`. Stdio is forwarded transparently. Connections are reused via a 10-minute ControlPersist socket so subsequent queries skip the auth handshake.
- **Terminal:** the pty panel spawns `ssh -tt … host -- 'cd /remote/path && exec $SHELL -l'`, so you land directly in a login shell in the workspace dir.

### Requirements on the remote host

- **`ssh` and an OpenSSH server** that supports `ControlMaster=auto`. Any modern Linux/macOS install works.
- **`claude` authenticated on the remote** via `claude auth login` (or with an `ANTHROPIC_API_KEY` set in the user's shell rc files). Boardroom does *not* forward credentials — see [Auth on the remote host](#auth-on-the-remote-host) below.
- **`claude` on the login `PATH`** of the user you SSH as. Install with `npm i -g @anthropic-ai/claude-code` (or via your package manager). The wrapper invokes `bash -lic` on the remote — login + interactive — so anything `.bashrc` puts on PATH (nvm, asdf, mise, `~/.local/bin`, etc.) will be visible. If your remote shell is exotic or your PATH lives somewhere weird, run `bash -lic "which claude"` on the remote to verify.
- **Non-interactive key auth.** Boardroom passes `BatchMode=yes` so password prompts aren't possible. Use `ssh-agent`, `~/.ssh/config IdentityFile`, or hardware keys.
- **Claude version compatibility.** The remote claude should be reasonably recent — old versions may not understand the SDK's stream-json protocol.

### Auth on the remote host

**Boardroom does not forward your local Anthropic credentials to the remote.** The remote `claude` uses whatever auth lives in its own `~/.claude/.credentials.json` (or in `ANTHROPIC_API_KEY` in the remote user's environment), exactly as if you'd run `claude` over `ssh` by hand.

To set this up: `ssh` to the remote once and run `claude auth login` (or set the API key in your remote shell rc). After that, Boardroom's SSH workspaces just work.

Why this design:
- The remote dev box is almost always where you've already configured `claude` for the right account. Forwarding our local creds would override that with whoever the local Boardroom user happens to be — usually the wrong choice.
- It avoids account-mismatch / stale-token / API-key-vs-subscription confusion when the local and remote are configured for different accounts.
- It removes a class of failures involving SSH env-var forwarding, sshd `AcceptEnv` rules, etc.

The wrapper script explicitly strips `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN` from the env it hands to `ssh`, so the local Boardroom worker's credentials can never accidentally leak across the wire even if you set them.

If you have a need to use the local account on the remote (e.g. you want billing to go to your local Max sub instead of the remote's account), set `CLAUDE_CODE_OAUTH_TOKEN` directly in the remote user's `~/.bashrc` and we'll pick it up via the same `bash -lic` that handles PATH.

### Limitations

- **No interactive prompts.** Password / passphrase / yes-no host-key prompts will fail. Pre-trust hosts and use key auth.
- **One ControlMaster per UID.** Two Boardroom processes for the same user will share SSH multiplexing sockets in `/tmp/.boardroom-ssh-*`. Usually fine.
- **Docker:** to use SSH workspaces from inside the container you need to mount your `~/.ssh` (e.g. `~/.ssh:/home/boardroom/.ssh:ro`) and make sure the `boardroom` user inside the container can read your private key. The container also needs the `ssh` client (already in the image).
- **Liveness check on add is skipped** — you'll find out the host is unreachable when you try to send a message.

## Authentication modes

All credentials are pasted into **Settings → Credentials** after sign-in and stored in Boardroom's SQLite data volume. Nothing is mounted from the host. Pick one:

### Anthropic API key (billed to your Anthropic Console account)

1. Go to <https://console.anthropic.com/settings/keys>
2. Create a key, copy it
3. In Boardroom: **Settings → Credentials** → pick *Anthropic API key* → paste → **Save**

The worker injects it as `ANTHROPIC_API_KEY` into the spawned Claude Code child process.

*(Alternative: set `ANTHROPIC_API_KEY` in `.env` before boot. The UI value overrides the env var if both are set.)*

### Claude Code subscription (billed to your Max / Pro plan)

This uses a **long-lived OAuth token** produced by the Claude Code CLI's `setup-token` command. The token is designed for headless / container use and survives across sessions.

On any machine where you've run `claude auth login`:

```bash
claude setup-token
```

Complete the browser flow, then copy the token that's printed.

In Boardroom: **Settings → Credentials** → pick *Claude Code subscription* → paste the token → **Save**.

The worker injects it as `CLAUDE_CODE_OAUTH_TOKEN` into the spawned Claude Code child process. `ANTHROPIC_API_KEY` is explicitly cleared from the child's environment so the CLI doesn't prefer the Console billing path.

#### Running inside Docker with no local `claude` CLI

The Docker image ships with the Claude Code CLI pre-installed. You can generate a token directly inside the container:

```bash
docker compose exec boardroom claude setup-token
```

Complete the flow in your browser, copy the token, paste into **Settings → Credentials**.

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
