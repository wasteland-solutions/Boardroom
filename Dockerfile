# syntax=docker/dockerfile:1.7

# ---------- base with build tools (for native modules) ----------
FROM node:22-slim AS build-base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        python3 make g++ git \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

# ---------- install all deps ----------
FROM build-base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
COPY scripts/fix-node-pty.mjs scripts/fix-node-pty.mjs
RUN pnpm install --frozen-lockfile

# ---------- production deps only ----------
FROM build-base AS prod-deps
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod --ignore-scripts \
    && pnpm rebuild better-sqlite3 node-pty \
    # Fix node-pty spawn-helper permissions
    && node -e "const fs=require('fs'),p=require('path'); \
       (function w(d){try{fs.readdirSync(d,{withFileTypes:true}).forEach(e=>{const f=p.join(d,e.name); \
       if(e.isDirectory())w(f);else if(e.name==='spawn-helper')fs.chmodSync(f,0o755)})}catch{}})(p.resolve('node_modules'))" \
    # Strip prebuilt binaries for platforms we don't need in linux containers
    && find node_modules -path '*/prebuilds/darwin-*' -exec rm -rf {} + 2>/dev/null || true \
    && find node_modules -path '*/prebuilds/win32-*' -exec rm -rf {} + 2>/dev/null || true \
    && find node_modules -path '*/@next/swc-darwin-*' -exec rm -rf {} + 2>/dev/null || true \
    && find node_modules -path '*/@next/swc-win32-*' -exec rm -rf {} + 2>/dev/null || true \
    && find node_modules -path '*/@img/sharp-libvips-darwin-*' -exec rm -rf {} + 2>/dev/null || true \
    && find node_modules -path '*/@img/sharp-darwin-*' -exec rm -rf {} + 2>/dev/null || true

# ---------- build ----------
FROM build-base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm build \
    && rm -rf .next/cache

# ---------- runtime (slim, no build tools) ----------
FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV DATABASE_PATH=/app/data/boardroom.db
ENV AGENT_WORKER_SOCKET=/tmp/boardroom-agent.sock
ENV AGENT_WORKER_WS_PORT=8099
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates tini git openssh-client \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd --system --gid 1001 boardroom \
    && useradd --system --uid 1001 --gid boardroom --create-home boardroom

# Next.js standalone output — only the files Next actually imports,
# ~30MB instead of ~300MB of full node_modules.
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

# Prod node_modules for the agent worker (sdk, codex, node-pty, etc.)
# The standalone output handles Next's own deps; this covers everything
# the worker process needs that standalone doesn't trace.
COPY --from=prod-deps /app/node_modules ./node_modules

# Build artifacts for the agent worker + migrations + scripts.
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/drizzle ./drizzle
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/next.config.mjs ./

RUN mkdir -p /app/data /workspaces \
    && chown -R boardroom:boardroom /app /workspaces

USER boardroom
VOLUME ["/app/data", "/workspaces"]
EXPOSE 3000 8099

ENTRYPOINT ["tini", "--"]
CMD ["node", "scripts/start.mjs"]
