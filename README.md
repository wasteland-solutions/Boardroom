# Boardroom

A single-user self-hosted web app that is **a DM with Claude Code**.

One chat thread, one Claude Code agent. The backend runs Claude Code headlessly via the [Claude Agent SDK](https://docs.anthropic.com/en/docs/claude-code/agent-sdk), with its full tool suite (Bash, Read, Edit, Write, MCP, project hooks), token streaming, and permission prompts surfaced in the UI as message bubbles.

Think iMessage, but the person on the other end is Claude Code — and it can actually run commands and edit files in whatever project directory you point it at.

## Features

- **Multiple conversations.** Each one is its own Claude Code session, bound to a working directory, model (Opus / Sonnet / Haiku), and permission mode. Sessions resume across restarts via the SDK's `resume` option.
- **Local *and* remote workspaces.** A workspace can be a local absolute path or an `ssh://` URI. For SSH workspaces Boardroom runs `claude` on the remote box itself over a `ControlMaster`-multiplexed connection — same agent personality you'd get if you ran `claude` over `ssh` by hand.
- **Two ways to authenticate with Anthropic.** Paste an Anthropic API key (billed to your Anthropic Console account) *or* a Claude Code OAuth token (billed to your Claude Max / Pro subscription). Stored in SQLite, no host credential mounts.
- **Inline permission prompts.** In `ask` mode every risky tool call appears as a message bubble with Approve / Deny buttons. The agent pauses until you respond (or until the configurable timeout fires).
- **Token streaming.** Assistant responses stream token-by-token over SSE, batched with `requestAnimationFrame` so long answers don't wedge the renderer.
- **Project memory loading on two layers.** Claude Code's built-in `CLAUDE.md` / `.claude/` auto-discovery (driven by `settingSources: ['project']`) *plus* a Boardroom layer that reads any configured workspace memory files (default: `CLAUDE.md`, `SOUL.md`, `IDENTITY.md`, `TOOLS.md`, `MEMORY.md`, `AGENTS.md`) and prepends them to the system prompt. Both layers read from the *remote* box for SSH workspaces.
- **Per-conversation custom instructions.** Optional textarea on the new-conversation form. Gets appended to the system prompt for that conversation only — useful for one-off agents without committing files.
- **Side-panel terminal.** Each conversation has an attached pty in the workspace cwd via xterm.js. For SSH workspaces it's a real shell on the remote box, sharing the same `ControlMaster` socket the agent uses.
- **Slash command autocomplete.** `/` in the composer opens a popup of available commands — claude-code skills (`/simplify`, `/batch`, `/loop`, …) + Boardroom built-ins (`/clear`, `/archive`, `/info`).
- **MCP servers.** Configurable JSON in Settings, passed straight through to the SDK.
- **Archive + permanent delete.** Archive moves a conversation into a collapsible "Archived" group in the sidebar and tears down its SDK session and pty. Delete permanently removes the conversation, its messages, and its on-disk claude-code session transcript (locally with `fs.unlink`, remotely via `ssh + rm`).
- **Persistent history.** Every message + system frame stored in SQLite. SSE reconnects replay missed frames via `Last-Event-ID`.
- **Pick your sign-in.** Username + password (set in `.env`) *or* OIDC SSO (Google, Authentik, Keycloak, …), or both at once. Whichever you configure shows up on the sign-in page.

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

## Workspaces

A workspace is the directory the agent operates in. It can be local or remote.

### Local workspaces

Add an absolute path in **Settings → Working directories** (or click **Browse** to navigate the local filesystem). Boardroom will validate that the path exists and is a directory before saving. The agent's `cwd` for any conversation bound to this workspace is exactly that path.

### Remote workspaces (SSH)

When you bind a conversation to an SSH workspace, Boardroom runs `claude` *on the remote host* over an SSH `ControlMaster`-multiplexed connection. The terminal panel drops you into a real interactive shell on the same box.

Add a remote workspace by either:

- **Filling the Host + Path fields separately** in Settings — Host is `[user@]host[:port]` (or an alias from your `~/.ssh/config`), Path is the absolute remote path. Click **Browse** to navigate the remote filesystem via SSH.
- **Pasting a URI** into the Path field directly. Two shapes are supported:
  ```
  ssh://[user@]host[:port]/absolute/remote/path
  [user@]host:/absolute/remote/path
  ```
  The second form is the rsync/scp short form. Local absolute paths take priority, so a local path with a colon in the name still parses as local.

### What Boardroom does under the hood

- **Claude:** the SDK is pointed at `scripts/boardroom-claude-ssh.mjs`, a small wrapper that exec's `ssh -o ControlMaster=auto … host -- bash --noprofile --norc -c 'eval "$(printf %s … | base64 -d)"'`. The decoded remote script captures the user's interactive-login `PATH` from a separate `bash -lic` subshell (whose stdout is captured into a variable, so shell init noise like p10k instant prompt or `.bashrc` echos can't corrupt the SDK protocol stream), then `cd`s into the workspace and exec's `claude` with the SDK's args. Stdio flows through ssh transparently. Connections are reused via a 10-minute `ControlPersist` socket so subsequent queries skip the handshake.
- **Terminal:** the pty panel spawns `ssh -tt … host -- 'cd <cwd> && exec $SHELL -l'`, sharing the same `ControlMaster` socket as the SDK wrapper.
- **Browse:** the directory picker uses `ssh + ls -1Ap` over the same socket, so navigating the remote filesystem is sub-second on a warm connection.

### SSH workspace requirements

- **`ssh` + `OpenSSH` server** that supports `ControlMaster=auto`. Any modern Linux/macOS install works.
- **`claude` authenticated on the remote** via `claude auth login` (or with an `ANTHROPIC_API_KEY` set in the user's shell rc files). Boardroom does *not* forward credentials — see [Auth on the remote host](#auth-on-the-remote-host) below.
- **`claude` on the login `PATH`** of the user you SSH as. Install with `npm i -g @anthropic-ai/claude-code` (or via your package manager). The wrapper invokes the remote shell as `bash --noprofile --norc -c '…'` for the spawn but captures the user's interactive-login PATH from a separate `bash -lic` subshell at session start — so anything `.bashrc` puts on PATH (nvm, asdf, mise, `~/.local/bin`, …) will be visible even when the user's `.bashrc` writes to stdout. If your remote shell is exotic or your PATH lives somewhere weird, run `bash -lic "which claude"` on the remote to verify.
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

If you want to use a *local* account on the remote (e.g. your local Max sub instead of the remote's account), set `CLAUDE_CODE_OAUTH_TOKEN` directly in the remote user's `~/.bashrc` and the agent will pick it up via the same login-shell PATH capture.

### SSH limitations

- **No interactive prompts.** Password / passphrase / yes-no host-key prompts will fail. Pre-trust hosts and use key auth.
- **One ControlMaster per UID.** Two Boardroom processes for the same user share SSH multiplexing sockets in `/tmp/.boardroom-ssh-*`. Usually fine.
- **Docker:** to use SSH workspaces from inside the container you need to mount your `~/.ssh` (e.g. `~/.ssh:/home/boardroom/.ssh:ro`) and make sure the `boardroom` user inside the container can read your private key. The container also needs the `ssh` client (already in the image).
- **Liveness check on add is skipped** — you'll find out the host is unreachable when you try to send a message.

## Giving the agent a custom identity / project context

Boardroom passes `settingSources: ['project']` to the SDK — **only the workspace's own files**, not the user's `~/.claude/`. This is a deliberate scope choice: each Boardroom workspace is self-contained, so the same workspace mounted on a different host gives you the same agent regardless of whose `~/.claude/CLAUDE.md` lives there. Personal global rules should live in the workspace, not in your home dir.

There are **three** ways to feed identity / project context to the agent. You can mix and match — they stack on top of each other.

### 1. Claude Code's built-in auto-discovery

Driven by `settingSources: ['project']`. claude-code walks up from the cwd looking for:

- `CLAUDE.md` — claude-code's standard memory file
- `.claude/settings.json` — project settings + hooks
- `.claude/agents/*` — custom subagents
- `.claude/commands/*` — custom slash commands
- `.claude/skills/*` — custom skills

This is the only layer that knows about hooks, subagents, and the standard `.claude/` tree.

### 2. Boardroom's "workspace memory files"

Configured in **Settings → Workspace memory files**. Default list:

```
CLAUDE.md
SOUL.md
IDENTITY.md
TOOLS.md
MEMORY.md
AGENTS.md
```

Boardroom reads any of these that exist at the workspace root and prepends their contents to the system prompt via the SDK's `systemPrompt: { append: … }` option. This is how you use *custom memory file conventions* (`SOUL.md`, `IDENTITY.md`, …) that claude-code's auto-discovery doesn't know about. The list is editable in Settings (one filename per line, lines starting with `#` are ignored).

Combined memory file content is hard-capped at **256KB** so a runaway file can't blow out the prompt.

For local workspaces files are read from disk via `fs.readFileSync`. For SSH workspaces a single `ssh + bash` invocation walks the filename list and `cat`s any that exist, reusing the existing `ControlMaster` socket — sub-second on a warm connection.

### 3. Per-conversation custom instructions

The new-conversation form has a **Custom instructions (optional)** textarea. Whatever you type gets stored on the conversation row and appended to the system prompt for that conversation only. Doesn't touch any files. Useful for one-off agents like *"review this PR as a security pedant"* without committing anything to the workspace.

### How they stack

The final system prompt that the SDK assembles is:

```
<claude_code preset system prompt>

<workspace memory files, joined with `===== <filename> =====` headers>

<per-conversation custom instructions>
```

Plus whatever claude-code's own auto-discovery layer adds at runtime (`.claude/agents/*` etc).

### Confirming what was actually loaded

Boardroom persists every SDK `system` frame to SQLite (including the init payload that lists tools, MCP server status, and slash commands). To inspect:

```bash
sqlite3 data/boardroom.db \
  "SELECT content FROM messages WHERE role='system' AND sdk_message_type='system:init' ORDER BY seq DESC LIMIT 1" \
  | python3 -m json.tool
```

The init frame only fires for *fresh* SDK sessions, not resumed ones. If you want to see it, **Stop** the conversation in the UI first to force the next message to spin up a new query.

## Per-conversation features

### Side-panel terminal

Click **Terminal** in the chat header to open a real terminal in the conversation's workspace, side-by-side with the chat. Backed by `xterm.js` on the client and `node-pty` in the worker. Reuses the same SSH `ControlMaster` socket as the agent for remote workspaces, so opening the panel is sub-second on a warm connection.

The pty is per-conversation and survives a 30s grace period after the last client disconnects (so a page reload doesn't kill your shell). 1h idle timeout after that.

### Slash commands

Type `/` as the first character of the composer to open an autocomplete popup. Two sources are merged into one list with badges:

- **Skills (from `Query.supportedCommands()`)** — anything claude-code's skill discovery exposes for the current session, including bundled skills (`/simplify`, `/batch`, `/loop`, `/schedule`, …) and any project-level skills under `.claude/skills/`.
- **Boardroom built-ins** — local-only commands handled client-side, never sent to claude:
  - `/clear` — fork a fresh conversation in the same workspace (same model / mode / instructions)
  - `/archive` — archive the current conversation
  - `/info` — inject a synthetic info row showing the current session's config

Up/Down navigates, Tab/Enter inserts, Escape dismisses. The popup auto-scrolls when you walk past the visible area.

### Archive + delete

The chat header has **Archive** / **Unarchive** and **Delete** buttons.

- **Archive** moves the conversation into a collapsible "Archived" group at the bottom of the sidebar and tears down its SDK session and pty (so it stops holding worker resources). Unarchive lazily resumes via the persisted `sdk_session_id`.
- **Delete** is permanent: removes the row + all its messages + all its pending permission rows (cascading via foreign keys), AND best-effort deletes the on-disk claude-code session transcript (`fs.unlink` for local, `ssh + rm -f` for remote). After confirming, you're routed to the next active conversation.

The archived group's expand/collapse state is persisted to `localStorage` so it survives navigation.

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
  agent/                          Standalone Node worker that owns the Claude Agent SDK
    worker.ts                     Entry: Unix socket server, session manager, graceful shutdown
    sdk-runner.ts                 query() wrapper, streaming input, token pumping, tool events,
                                  workspace memory file loader (local fs / ssh + cat)
    permission-broker.ts          canUseTool → Promise + timeout + abort
    session-manager.ts            Per-conversation Query map with idle sweep + dead-session evict
    persistence.ts                Monotonic seq + SQLite writes
    pty-manager.ts                node-pty per conversation, local shell or ssh -tt to remote
    ws-server.ts                  Terminal WebSocket server on AGENT_WORKER_WS_PORT (default 8099)
    rpc.ts                        JSONL Unix-socket RPC server + fanout
  app/                            Next.js App Router (frontend + route handlers)
    api/
      stream/[conversationId]/     SSE stream (Last-Event-ID replay)
      input/[conversationId]/      POST: send | permission_reply | interrupt
      terminal/[conversationId]/   POST: mint a short-lived HMAC token for the WebSocket
      conversations/               CRUD + slash-commands subroute
      browse/                      POST: directory picker (local fs / ssh + ls)
      cwds/                        Working directory allowlist
      settings/                    GET/PUT app settings
      auth/[...nextauth]/          Auth.js handlers
    c/[conversationId]/page.tsx    Chat view
    settings/page.tsx              Settings view
    signin/page.tsx                Sign-in page (OIDC + credentials)
  components/
    ChatShell.tsx                  Main app shell: sidebar, chat pane, slash autocomplete
    TerminalPanel.tsx              xterm.js side panel
    DirectoryBrowser.tsx           Filesystem picker modal
    SettingsForm.tsx               Settings page UI
  lib/
    schema.ts                     Drizzle tables
    db.ts                         better-sqlite3 + Drizzle singleton
    auth.ts / auth.config.ts      Auth.js v5 — full + edge-safe variants
    agent-client.ts               JSONL Unix-socket RPC client used by route handlers
    bus.ts                        In-process EventEmitter for SSE fanout
    types.ts                      Shared wire types
    settings-store.ts             AppSettings persistence
    terminal-token.ts             HMAC token mint/verify for the terminal WebSocket
    workspace.ts                  Workspace path parser (local / ssh:// / short form)
  middleware.ts                   Auth.js route protection
drizzle/                          Generated migrations
scripts/
  start.mjs                       Production entrypoint (runs migrations, spawns worker + Next)
  migrate.ts                      Manual migration runner
  boardroom-claude-ssh.mjs        SSH bridge wrapper used as pathToClaudeCodeExecutable
  fix-node-pty.mjs                Postinstall: chmod +x node-pty's spawn-helper after pnpm extract
Dockerfile
docker-compose.yml
```

## License

See [LICENSE](./LICENSE).
