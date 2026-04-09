FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

# --- deps stage ---
FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile || pnpm install

# --- build stage ---
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm build

# --- runtime stage ---
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV DATABASE_PATH=/app/data/boardroom.db
ENV AGENT_WORKER_SOCKET=/tmp/boardroom-agent.sock

RUN apt-get update \
    && apt-get install -y --no-install-recommends tini ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Claude Code CLI — required by the Agent SDK to spawn the child process.
RUN pnpm add -g @anthropic-ai/claude-code

COPY --from=builder /app/package.json /app/pnpm-lock.yaml* ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/drizzle ./drizzle
COPY --from=builder /app/next.config.mjs ./next.config.mjs
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/src/lib/schema.ts ./src/lib/schema.ts

RUN mkdir -p /app/data
VOLUME ["/app/data"]

EXPOSE 3000
ENTRYPOINT ["tini", "--"]
CMD ["node", "scripts/start.mjs"]
