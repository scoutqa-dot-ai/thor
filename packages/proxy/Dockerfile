FROM node:22-slim AS base
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

# --- Build stage ---
FROM base AS build
WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/proxy/ packages/proxy/

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @thor/proxy build

# --- Production stage ---
FROM base AS production
WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/proxy/package.json packages/proxy/
RUN pnpm install --frozen-lockfile --prod --ignore-scripts

COPY --from=build /app/packages/proxy/dist/ packages/proxy/dist/
COPY packages/proxy/proxy.config.json packages/proxy/

ENV PORT=3001
EXPOSE 3001

CMD ["node", "packages/proxy/dist/index.js"]
