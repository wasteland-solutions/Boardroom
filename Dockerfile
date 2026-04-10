# syntax=docker/dockerfile:1.7

# ---------- base image ----------
FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        tini \
        git \
        openssh-client \
        python3 \
        make \
        g++ \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

# ---------- full dependency install (used by the build stage) ----------
FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
# Allow better-sqlite3 to build its native binding.
ENV CI=1
RUN pnpm install --frozen-lockfile \
    && pnpm rebuild better-sqlite3

# ---------- production-only deps (used by the runtime stage) ----------
FROM base AS prod-deps
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
ENV CI=1
RUN pnpm install --frozen-lockfile --prod \
    && pnpm rebuild better-sqlite3

# ---------- build stage ----------
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Build Next.js + compile the agent worker to dist/agent/
RUN pnpm build

# ---------- runtime stage ----------
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV DATABASE_PATH=/app/data/boardroom.db
ENV AGENT_WORKER_SOCKET=/tmp/boardroom-agent.sock
ENV AGENT_WORKER_WS_PORT=8099
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Non-root runtime user.
RUN groupadd --system --gid 1001 boardroom \
    && useradd --system --uid 1001 --gid boardroom --create-home boardroom

# Production deps only (includes native better-sqlite3 binding).
COPY --from=prod-deps /app/node_modules ./node_modules

# Build outputs and runtime files.
COPY --from=builder /app/package.json /app/pnpm-lock.yaml ./
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/drizzle ./drizzle
COPY --from=builder /app/next.config.mjs ./next.config.mjs
COPY --from=builder /app/scripts ./scripts

# Data dir + workspaces mount point.
RUN mkdir -p /app/data /workspaces \
    && chown -R boardroom:boardroom /app /workspaces

USER boardroom
VOLUME ["/app/data", "/workspaces"]
EXPOSE 3000 8099

ENTRYPOINT ["tini", "--"]
CMD ["node", "scripts/start.mjs"]
