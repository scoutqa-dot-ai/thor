FROM node:22-slim AS base
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

# --- Build stage ---
FROM base AS build
WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/common/ packages/common/
COPY packages/proxy/ packages/proxy/

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @thor/common build
RUN pnpm --filter @thor/proxy build

# --- Production stage ---
FROM base AS production

# App code lives in /app; /workspace is the runtime cwd (bind-mounted from host).
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml /app/
COPY packages/common/package.json /app/packages/common/
COPY packages/proxy/package.json /app/packages/proxy/
RUN cd /app && pnpm install --frozen-lockfile --prod --ignore-scripts

COPY --from=build /app/packages/common/dist/ /app/packages/common/dist/
COPY --from=build /app/packages/proxy/dist/ /app/packages/proxy/dist/
COPY packages/proxy/proxy.config.json /app/packages/proxy/

WORKDIR /workspace

ENV PORT=3001
EXPOSE 3001

CMD ["node", "/app/packages/proxy/dist/index.js"]
