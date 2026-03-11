# Unified multi-target Dockerfile for all Thor Node.js services.
# Shared deps and build stages mean pnpm install runs once, not per-service.
#
# Usage in docker-compose.yml:
#   build:
#     context: .
#     target: gateway

FROM node:22-slim AS base
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

# --- Install deps (cached until lockfile or package.json changes) ---
FROM base AS deps
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/common/package.json packages/common/
COPY packages/gateway/package.json packages/gateway/
COPY packages/proxy/package.json packages/proxy/
COPY packages/runner/package.json packages/runner/
COPY packages/slack-mcp/package.json packages/slack-mcp/
COPY packages/git-mcp/package.json packages/git-mcp/
RUN pnpm install --frozen-lockfile

# --- Build all packages ---
FROM deps AS build
COPY packages/ packages/
RUN pnpm -r build

# === Per-service targets ===

FROM build AS gateway
WORKDIR /workspace
ENV PORT=3002
EXPOSE 3002
CMD ["node", "/app/packages/gateway/dist/index.js"]

FROM build AS proxy
COPY packages/proxy/proxy.*.json /app/packages/proxy/
COPY packages/proxy/multi-proxy.sh /app/packages/proxy/
WORKDIR /workspace
EXPOSE 3010 3011 3012 3013
CMD ["sh", "/app/packages/proxy/multi-proxy.sh"]

FROM build AS runner
WORKDIR /workspace
ENV PORT=3000
EXPOSE 3000
CMD ["node", "/app/packages/runner/dist/index.js"]

FROM build AS slack-mcp
ENV PORT=3003
EXPOSE 3003
CMD ["node", "/app/packages/slack-mcp/dist/index.js"]

FROM build AS git-mcp
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
WORKDIR /workspace/repos
ENV PORT=3004
EXPOSE 3004
CMD ["node", "/app/packages/git-mcp/dist/index.js"]
