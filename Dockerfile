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
COPY packages/opencode-cli/package.json packages/opencode-cli/
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

# --- Install upstream opencode from npm ---
FROM base AS opencode
RUN npm install -g opencode-ai@1.4.3
# git/gh/scoutqa wrapper scripts — forward to remote-cli service over HTTP
COPY --from=build /app/packages/opencode-cli/dist/remote-cli.mjs /usr/local/bin/remote-cli.mjs
COPY docker/opencode/bin/git /usr/local/bin/git
COPY docker/opencode/bin/gh /usr/local/bin/gh
COPY docker/opencode/bin/scoutqa /usr/local/bin/scoutqa
COPY docker/opencode/bin/langfuse /usr/local/bin/langfuse
# mcp/approval wrapper scripts — forward to proxy service over HTTP
COPY --from=build /app/packages/opencode-cli/dist/proxy-cli.mjs /usr/local/bin/proxy-cli.mjs
COPY docker/opencode/bin/mcp /usr/local/bin/mcp
COPY docker/opencode/bin/approval /usr/local/bin/approval
USER thor
RUN mkdir -p /home/thor/.local/share/opencode /home/thor/.local/state
ENV THOR_REMOTE_CLI_URL=http://remote-cli:3004
ENV THOR_PROXY_URL=http://proxy:3001
# Disable the question tool — it requires an interactive client to answer.
# OpenCode only registers QuestionTool when OPENCODE_CLIENT is "app", "cli", or "desktop".
# https://github.com/sst/opencode/blob/main/packages/opencode/src/tool/registry.ts
ENV OPENCODE_CLIENT=thor
COPY --chown=thor:thor docker/opencode/config/ /home/thor/.config/opencode/
ENTRYPOINT ["opencode"]

FROM build AS remote-cli
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates curl openssh-client && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh && rm -rf /var/lib/apt/lists/*
RUN npm i -g @scoutqa/cli@latest langfuse-cli@0.0.8
COPY packages/remote-cli/entrypoint.sh /entrypoint.sh
USER thor
RUN mkdir -p /workspace/repos
WORKDIR /workspace/repos
ENV PORT=3004
EXPOSE 3004
ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "/app/packages/remote-cli/dist/index.js"]
