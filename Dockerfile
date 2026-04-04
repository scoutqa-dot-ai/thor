# Unified multi-target Dockerfile for all Thor Node.js services.
# Shared deps and build stages mean pnpm install runs once, not per-service.
#
# Usage in docker-compose.yml:
#   build:
#     context: .
#     target: gateway

FROM node:22-slim AS base
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
RUN groupadd --gid 1001 thor && useradd --uid 1001 --gid thor --create-home thor
RUN mkdir -p /workspace && chown thor:thor /workspace

# --- Install deps (cached until lockfile or package.json changes) ---
FROM base AS deps
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json tsup.config.ts ./
COPY packages/common/package.json packages/common/
COPY packages/gateway/package.json packages/gateway/
COPY packages/proxy/package.json packages/proxy/
COPY packages/runner/package.json packages/runner/
COPY packages/slack-mcp/package.json packages/slack-mcp/
COPY packages/remote-cli/package.json packages/remote-cli/
RUN pnpm install --frozen-lockfile

# --- Build all packages ---
FROM deps AS build
COPY packages/ packages/
RUN pnpm -r build

# === Per-service targets ===

FROM build AS gateway
USER thor
WORKDIR /workspace
ENV PORT=3002
EXPOSE 3002
CMD ["node", "/app/packages/gateway/dist/index.js"]

FROM build AS proxy
USER thor
WORKDIR /workspace
EXPOSE 3001
CMD ["node", "/app/packages/proxy/dist/index.js"]

FROM build AS runner
USER thor
WORKDIR /workspace
ENV PORT=3000
EXPOSE 3000
CMD ["node", "/app/packages/runner/dist/index.js"]

FROM build AS slack-mcp
USER thor
ENV PORT=3003
EXPOSE 3003
CMD ["node", "/app/packages/slack-mcp/dist/index.js"]

FROM build AS remote-cli
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates curl openssh-client && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh && rm -rf /var/lib/apt/lists/*
RUN npm i -g @scoutqa/cli@latest
COPY packages/remote-cli/entrypoint.sh /entrypoint.sh
USER thor
RUN mkdir -p /workspace/repos
WORKDIR /workspace/repos
ENV PORT=3004
EXPOSE 3004
ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "/app/packages/remote-cli/dist/index.js"]
