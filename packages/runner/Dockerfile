FROM node:22-slim AS base
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
RUN apt-get update && apt-get install -y --no-install-recommends curl git ca-certificates && rm -rf /var/lib/apt/lists/*

# --- Install OpenCode binary ---
RUN curl -fsSL https://opencode.ai/install | bash -s -- --no-modify-path
ENV PATH="/root/.opencode/bin:$PATH"

# --- Build stage ---
FROM base AS build
WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/runner/ packages/runner/

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @thor/runner build

# --- Production stage ---
FROM base AS production
WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/runner/package.json packages/runner/
RUN pnpm install --frozen-lockfile --prod --ignore-scripts

COPY --from=build /app/packages/runner/dist/ packages/runner/dist/

# Global-level opencode config — no project-level config needed.
# Uses opencode/big-pickle (free, no auth required).
COPY packages/runner/opencode.docker.json /root/.config/opencode/opencode.json

# Initialize git repo so opencode doesn't complain
RUN git init

# Named volume for opencode data (sessions, db, logs).
# Config is baked in at /root/.config/opencode/ above.
VOLUME ["/root/.local/share/opencode"]

ENV PORT=3000
ENV OPENCODE_PORT=4096
EXPOSE 3000

CMD ["node", "packages/runner/dist/index.js"]
