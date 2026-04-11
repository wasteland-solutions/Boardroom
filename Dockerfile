# syntax=docker/dockerfile:1.7

FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates tini git openssh-client python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

# ---------- deps ----------
FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml .npmrc ./
COPY scripts/fix-node-pty.mjs scripts/fix-node-pty.mjs
RUN pnpm install --frozen-lockfile
# Verify native bindings compiled
RUN node -e "require('better-sqlite3')" && echo "better-sqlite3 OK"
RUN node -e "require('node-pty')" && echo "node-pty OK"

# ---------- build ----------
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm build && rm -rf .next/cache

# ---------- runtime ----------
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production DATABASE_PATH=/app/data/boardroom.db \
    AGENT_WORKER_SOCKET=/tmp/boardroom-agent.sock \
    AGENT_WORKER_WS_PORT=8099 PORT=3000 HOSTNAME=0.0.0.0

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates tini git openssh-client \
    && rm -rf /var/lib/apt/lists/*
RUN groupadd --system --gid 1001 boardroom \
    && useradd --system --uid 1001 --gid boardroom --create-home boardroom

# Copy node_modules from deps (has compiled native bindings)
COPY --from=deps /app/node_modules ./node_modules
# Copy build output
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/drizzle ./drizzle
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/next.config.mjs ./
COPY --from=builder /app/package.json ./

RUN mkdir -p /app/data /workspaces \
    && chown -R boardroom:boardroom /app /workspaces

USER boardroom
VOLUME ["/app/data", "/workspaces"]
EXPOSE 3000 8099
ENTRYPOINT ["tini", "--"]
CMD ["node", "scripts/start.mjs"]
