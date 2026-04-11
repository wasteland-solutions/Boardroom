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

# ---------- install all deps + build native modules ----------
FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
COPY scripts/fix-node-pty.mjs scripts/fix-node-pty.mjs
# --frozen-lockfile for reproducibility. The postinstall script
# runs fix-node-pty.mjs to chmod the spawn-helper binary.
RUN pnpm install --frozen-lockfile

# ---------- build stage ----------
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Build Next.js + compile the agent worker to dist/agent/
RUN pnpm build

# ---------- runtime stage (no build tools needed) ----------
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
        ca-certificates \
        tini \
        git \
        openssh-client \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd --system --gid 1001 boardroom \
    && useradd --system --uid 1001 --gid boardroom --create-home boardroom

COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/package.json /app/pnpm-lock.yaml ./
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/drizzle ./drizzle
COPY --from=builder /app/next.config.mjs ./next.config.mjs
COPY --from=builder /app/scripts ./scripts

RUN mkdir -p /app/data /workspaces \
    && chown -R boardroom:boardroom /app /workspaces

USER boardroom
VOLUME ["/app/data", "/workspaces"]
EXPOSE 3000 8099

ENTRYPOINT ["tini", "--"]
CMD ["node", "scripts/start.mjs"]
