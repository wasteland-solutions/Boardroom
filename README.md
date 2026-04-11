# Boardroom

A self-hosted web UI for [Claude Code](https://docs.anthropic.com/en/docs/claude-code). Point it at a local or remote workspace and chat with an agent that can read, edit, and run commands in your project.

## Quickstart

Requires Node 22+ and build tools (`build-essential` on Ubuntu, `xcode-select --install` on macOS).

```bash
git clone https://github.com/wasteland-solutions/Boardroom.git
cd Boardroom
npm install
npm run setup
npm run build
npm start
```

Open http://localhost:3000 — create your account on the setup screen, paste your API key, add a working directory, and start a conversation.

For development with hot reload: `npm run dev`

### Docker

```bash
cd docker
cp ../.env.example .env
# edit .env — set AUTH_SECRET
docker compose up -d
```

Mount your project directories as volumes so Claude can access them — see `docker/docker-compose.yml`.

## SSH Workspaces

Add a workspace as `ssh://user@host/path` in Settings. The remote host needs:

1. SSH key auth configured (no password prompts)
2. Claude Code remote server running (`~/.claude/remote/server`)
3. `claude auth login` run once on the remote

## Environment Variables

See [`.env.example`](./.env.example). The only required variable is `AUTH_SECRET` — everything else is configured in the UI.

## License

Apache 2.0
