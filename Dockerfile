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
COPY packages/runner/package.json packages/runner/
COPY packages/slack-mcp/package.json packages/slack-mcp/
COPY packages/remote-cli/package.json packages/remote-cli/
COPY packages/opencode-cli/package.json packages/opencode-cli/
COPY packages/admin/package.json packages/admin/
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

FROM build AS admin
USER thor
WORKDIR /workspace
ENV PORT=3005
EXPOSE 3005
CMD ["node", "/app/packages/admin/dist/index.js"]

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
# ca-certificates: provides system CA bundle for combined trust in entrypoint-wrap.sh
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
RUN npm install -g opencode-ai@1.4.3
# git/gh/scoutqa wrapper scripts — forward to remote-cli service over HTTP
COPY --from=build /app/packages/opencode-cli/dist/remote-cli.mjs /usr/local/bin/remote-cli.mjs
COPY docker/opencode/bin/git /usr/local/bin/git
COPY docker/opencode/bin/gh /usr/local/bin/gh
COPY docker/opencode/bin/scoutqa /usr/local/bin/scoutqa
COPY docker/opencode/bin/langfuse /usr/local/bin/langfuse
COPY docker/opencode/bin/metabase /usr/local/bin/metabase
COPY docker/opencode/bin/ldcli /usr/local/bin/ldcli
COPY docker/opencode/bin/sandbox /usr/local/bin/sandbox
# npm/npx/pnpm wrappers — redirect to sandbox so code runs in the cloud
COPY docker/opencode/bin/npm /usr/local/bin/npm
COPY docker/opencode/bin/npx /usr/local/bin/npx
COPY docker/opencode/bin/pnpm /usr/local/bin/pnpm
COPY docker/opencode/bin/pnpx /usr/local/bin/pnpx
COPY docker/opencode/bin/corepack /usr/local/bin/corepack
# mcp/approval wrapper scripts — forward to remote-cli service over HTTP
COPY docker/opencode/bin/mcp /usr/local/bin/mcp
COPY docker/opencode/bin/approval /usr/local/bin/approval
# mitmproxy proxy wiring: entrypoint validates CA + builds combined cert bundle
COPY docker/opencode/entrypoint-wrap.sh /entrypoint-wrap.sh
COPY docker/opencode/mitmproxy-init.js /etc/thor/mitmproxy-init.js
RUN chmod +x /entrypoint-wrap.sh
# Verify the preload's only dependency actually resolves from the install.
# This fails the build loudly if undici is missing from the opencode-ai package tree,
# rather than silently at first fetch() call inside the container.
RUN node --require /etc/thor/mitmproxy-init.js -e "console.log('[thor] mitmproxy-init preload OK')"
USER thor
RUN mkdir -p /home/thor/.local/share/opencode /home/thor/.local/state
ENV THOR_REMOTE_CLI_URL=http://remote-cli:3004
# Disable the question tool — it requires an interactive client to answer.
# OpenCode only registers QuestionTool when OPENCODE_CLIENT is "app", "cli", or "desktop".
# https://github.com/sst/opencode/blob/main/packages/opencode/src/tool/registry.ts
ENV OPENCODE_CLIENT=thor
COPY --chown=thor:thor docker/opencode/config/ /home/thor/.config/opencode/
# Entrypoint validates mitmproxy CA and wires combined cert bundle before exec'ing opencode
ENTRYPOINT ["/entrypoint-wrap.sh", "opencode"]

# mitmproxy target — CA mounted from host at runtime (never baked into the image).
# Pin the minor version to avoid surprise API changes; update deliberately.
FROM mitmproxy/mitmproxy:10.4.2 AS mitmproxy
USER root
# gosu: privilege-drop helper used by entrypoint.sh (root reads key, gosu execs as mitmproxy-svc)
RUN apt-get update && apt-get install -y --no-install-recommends curl gosu && rm -rf /var/lib/apt/lists/*
COPY docker/mitmproxy/rules.py   /etc/mitmproxy/rules.py
COPY docker/mitmproxy/addon.py   /etc/mitmproxy/addon.py
COPY docker/mitmproxy/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
# The base image's "mitmproxy" username maps to uid 0 (root), so create a real service account.
# Entrypoint starts as root to read key.pem, then gosu drops to mitmproxy-svc before exec.
RUN groupadd -g 1002 mitmproxy-svc && useradd -r -u 1002 -g 1002 -M mitmproxy-svc
ENTRYPOINT ["/entrypoint.sh"]

FROM build AS remote-cli
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates curl openssh-client && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh && rm -rf /var/lib/apt/lists/*
RUN npm i -g @scoutqa/cli@latest langfuse-cli@0.0.8 @launchdarkly/ldcli@2.2.0
COPY packages/remote-cli/entrypoint.sh /entrypoint.sh
# Thor git/gh wrappers for GitHub App auth
COPY packages/remote-cli/bin/git /usr/local/lib/thor/bin/git
COPY packages/remote-cli/bin/gh /usr/local/lib/thor/bin/gh
COPY packages/remote-cli/bin/git-askpass /usr/local/lib/thor/bin/git-askpass
RUN chmod +x /usr/local/lib/thor/bin/git /usr/local/lib/thor/bin/gh /usr/local/lib/thor/bin/git-askpass
RUN mkdir -p /var/lib/remote-cli/github-app/cache && chown -R thor:thor /var/lib/remote-cli
USER thor
RUN mkdir -p /workspace/repos
WORKDIR /workspace/repos
# Prepend Thor wrappers to PATH so they shadow /usr/bin/git and /usr/bin/gh
ENV PATH="/usr/local/lib/thor/bin:$PATH"
ENV PORT=3004
EXPOSE 3004
ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "/app/packages/remote-cli/dist/index.js"]
