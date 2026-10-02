# Unified multi-target Dockerfile for all Thor Node.js services.
# Shared deps and build stages mean pnpm install runs once, not per-service.
#
# Usage in docker-compose.yml:
#   build:
#     context: .
#     target: gateway

FROM node:24-slim AS base
RUN corepack enable && corepack prepare pnpm@10.33.4 --activate
RUN groupadd --gid 1001 thor && useradd --uid 1001 --gid thor --create-home thor
RUN mkdir -p /workspace && chown thor:thor /workspace

# --- Install deps (cached until lockfile or package.json changes) ---
FROM base AS deps
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm fetch --frozen-lockfile --store-dir /pnpm/store
COPY packages/common/package.json packages/common/
COPY packages/gateway/package.json packages/gateway/
COPY packages/runner/package.json packages/runner/
COPY packages/remote-cli/package.json packages/remote-cli/
COPY packages/opencode-cli/package.json packages/opencode-cli/
COPY packages/admin/package.json packages/admin/
COPY packages/onepassword-browser-mcp/package.json packages/onepassword-browser-mcp/
COPY packages/pi-executor/package.json packages/pi-executor/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --offline --store-dir /pnpm/store

# --- Package-scoped build stages ---
FROM deps AS common-source
COPY tsconfig.base.json tsup.config.ts ./
COPY packages/common/ packages/common/

FROM common-source AS gateway-build
COPY packages/gateway/ packages/gateway/
RUN pnpm --filter @thor/gateway build

FROM common-source AS admin-build
COPY packages/admin/ packages/admin/
RUN pnpm --filter @thor/admin build

FROM common-source AS runner-build
COPY packages/pi-executor/src/execution-protocol.ts packages/pi-executor/src/
COPY packages/runner/ packages/runner/
RUN pnpm --filter @thor/runner build

FROM common-source AS pi-executor-build
COPY packages/pi-executor/ packages/pi-executor/
RUN pnpm --filter @thor/pi-executor build

FROM common-source AS remote-cli-build
COPY packages/remote-cli/ packages/remote-cli/
RUN pnpm --filter @thor/remote-cli build

FROM deps AS onepassword-browser-mcp-build
COPY tsconfig.base.json ./
COPY packages/onepassword-browser-mcp/ packages/onepassword-browser-mcp/
RUN pnpm --filter @thor/onepassword-browser-mcp build

FROM common-source AS opencode-cli-build
COPY packages/opencode-cli/ packages/opencode-cli/
RUN pnpm --filter @thor/opencode-cli build

# Backward-compatible full build target for manual verification/debugging.
FROM deps AS build
COPY tsconfig.base.json tsup.config.ts ./
COPY packages/ packages/
RUN pnpm -r build

# === Per-service targets ===

FROM gateway-build AS gateway
USER thor
WORKDIR /workspace
ENV PORT=3002
EXPOSE 3002
CMD ["node", "/app/packages/gateway/dist/index.js"]

FROM admin-build AS admin
USER thor
WORKDIR /workspace
ENV PORT=3005
EXPOSE 3005
CMD ["node", "/app/packages/admin/dist/index.js"]

FROM runner-build AS runner
# Durable storage ownership uses a kernel lock; tools never run in this container.
RUN apt-get update && apt-get install -y --no-install-recommends util-linux ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /var/lib/runner && chown thor:thor /var/lib/runner
USER thor
WORKDIR /workspace
ENV PORT=3000
EXPOSE 3000
CMD ["node", "/app/packages/runner/dist/index.js"]

# --- Credential-free workspace tools, shared by OpenCode and the Pi executor ---
FROM base AS workspace-tools
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl jq python3-pip ripgrep \
    && npm install -g prettier@3.8.3 \
    && pip3 install --break-system-packages ruff \
    && curl -fsSL "https://github.com/mvdan/sh/releases/download/v3.13.1/shfmt_v3.13.1_linux_$(dpkg --print-architecture)" -o /usr/local/bin/shfmt \
    && chmod +x /usr/local/bin/shfmt \
    && rm -rf /var/lib/apt/lists/*
# git/gh/scoutqa wrapper scripts — forward to remote-cli service over HTTP
COPY --from=opencode-cli-build /app/packages/opencode-cli/dist/remote-cli.mjs /usr/local/bin/remote-cli.mjs
COPY docker/opencode/bin/git /usr/local/bin/git
COPY docker/opencode/bin/gh /usr/local/bin/gh
COPY docker/opencode/bin/scoutqa /usr/local/bin/scoutqa
COPY docker/opencode/bin/langfuse /usr/local/bin/langfuse
COPY docker/opencode/bin/metabase /usr/local/bin/metabase
COPY docker/opencode/bin/ldcli /usr/local/bin/ldcli
COPY --chmod=755 docker/opencode/bin/gws /usr/local/bin/gws
COPY docker/opencode/bin/drata /usr/local/bin/drata
COPY docker/opencode/bin/sandbox /usr/local/bin/sandbox
COPY docker/opencode/bin/rg /usr/local/bin/rg
# Remove upstream symlinks before COPY; otherwise Docker writes through them and overwrites npm/corepack source.
RUN rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/pnpm /usr/local/bin/pnpx /usr/local/bin/corepack
# npm/npx/pnpm wrappers — redirect to sandbox so code runs in the cloud
COPY docker/opencode/bin/npm /usr/local/bin/npm
COPY docker/opencode/bin/npx /usr/local/bin/npx
COPY docker/opencode/bin/pnpm /usr/local/bin/pnpm
COPY docker/opencode/bin/pnpx /usr/local/bin/pnpx
COPY docker/opencode/bin/corepack /usr/local/bin/corepack
# mcp/approval wrapper scripts — forward to remote-cli service over HTTP
COPY docker/opencode/bin/mcp /usr/local/bin/mcp
COPY docker/opencode/bin/approval /usr/local/bin/approval
COPY docker/opencode/bin/slack-post-message /usr/local/bin/slack-post-message
COPY docker/opencode/bin/slack-upload /usr/local/bin/slack-upload
USER thor
RUN mkdir -p /home/thor/.local/share/opencode /home/thor/.local/state
ENV THOR_REMOTE_CLI_URL=http://remote-cli:3004
# Disable the question tool — it requires an interactive client to answer.
# OpenCode only registers QuestionTool when OPENCODE_CLIENT is "app", "cli", or "desktop".
# https://github.com/sst/opencode/blob/main/packages/opencode/src/tool/registry.ts
ENV OPENCODE_CLIENT=thor

FROM workspace-tools AS pi-executor
COPY --from=pi-executor-build /app /app
COPY --chown=thor:thor docker/opencode/config/skills/ /etc/thor/skills/
ENV PORT=3002 NODE_USE_ENV_PROXY=1
EXPOSE 3002
ENTRYPOINT ["node", "/app/packages/pi-executor/dist/index.js"]

# --- Legacy harness retained for default deployment and rollback ---
FROM workspace-tools AS opencode
USER root
# The workspace npm shim redirects to sandbox; invoke the untouched npm entrypoint for image installation.
# Aikido's keytar native addon requires libsecret only in the legacy harness.
RUN apt-get update && apt-get install -y --no-install-recommends libsecret-1-0 \
    && rm -rf /var/lib/apt/lists/* \
    && node /usr/local/lib/node_modules/npm/bin/npm-cli.js install -g opencode-ai@1.18.29 @aikidosec/mcp@1.0.22
USER thor
COPY --chown=thor:thor docker/opencode/config/ /home/thor/.config/opencode/
ENTRYPOINT ["opencode"]

FROM base AS remote-cli-tools
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates chromium curl openssh-client bubblewrap && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh && rm -rf /var/lib/apt/lists/*
ARG GWS_VERSION=0.22.5
RUN npm i -g @scoutqa/cli@latest langfuse-cli@0.0.8 @launchdarkly/ldcli@2.2.0
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64) target="x86_64-unknown-linux-musl" ;; \
      arm64) target="aarch64-unknown-linux-musl" ;; \
      *) echo "Unsupported gws architecture: $arch" >&2; exit 1 ;; \
    esac; \
    artifact="google-workspace-cli-${target}.tar.gz"; \
    base_url="https://github.com/googleworkspace/cli/releases/download/v${GWS_VERSION}"; \
    tmp_dir="$(mktemp -d)"; \
    curl -fsSL "$base_url/$artifact" -o "$tmp_dir/$artifact"; \
    curl -fsSL "$base_url/$artifact.sha256" -o "$tmp_dir/$artifact.sha256"; \
    (cd "$tmp_dir" && sha256sum -c "$artifact.sha256"); \
    tar -xzf "$tmp_dir/$artifact" -C /usr/local/bin ./gws; \
    chmod +x /usr/local/bin/gws; \
    rm -rf "$tmp_dir"; \
    gws --version

FROM remote-cli-tools AS remote-cli
COPY --from=remote-cli-build /app /app
COPY --from=onepassword-browser-mcp-build /app/packages/onepassword-browser-mcp/dist /app/packages/onepassword-browser-mcp/dist
COPY packages/remote-cli/entrypoint.sh /entrypoint.sh
# Thor git/gh wrappers for GitHub App auth
COPY packages/remote-cli/bin/git /usr/local/lib/thor/bin/git
COPY packages/remote-cli/bin/gh /usr/local/lib/thor/bin/gh
COPY packages/remote-cli/bin/git-askpass /usr/local/lib/thor/bin/git-askpass
RUN chmod +x /usr/local/lib/thor/bin/git /usr/local/lib/thor/bin/gh /usr/local/lib/thor/bin/git-askpass
RUN mkdir -p /var/lib/remote-cli/github-app/cache /var/lib/remote-cli/gws /var/lib/remote-cli/google-workspace-oauth \
    && chown -R thor:thor /var/lib/remote-cli \
    && chmod 700 /var/lib/remote-cli/gws /var/lib/remote-cli/google-workspace-oauth
USER thor
RUN mkdir -p /workspace/repos
WORKDIR /workspace/repos
# Prepend Thor wrappers to PATH so they shadow /usr/bin/git and /usr/bin/gh
ENV PATH="/usr/local/lib/thor/bin:$PATH"
ENV GOOGLE_WORKSPACE_CLI_CONFIG_DIR=/var/lib/remote-cli/gws
ENV PORT=3004
EXPOSE 3004
ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "/app/packages/remote-cli/dist/index.js"]

FROM python:3.12-slim AS mitmproxy
RUN pip install --no-cache-dir mitmproxy==11.0.2
COPY docker/mitmproxy/ /opt/thor/mitmproxy/
RUN chmod +x /opt/thor/mitmproxy/entrypoint.sh
WORKDIR /opt/thor/mitmproxy
ENV PYTHONUNBUFFERED=1
ENTRYPOINT ["/opt/thor/mitmproxy/entrypoint.sh"]
