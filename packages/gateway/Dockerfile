FROM node:22-slim AS base
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

FROM base AS build
WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/common/ packages/common/
COPY packages/gateway/ packages/gateway/

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @thor/common build
RUN pnpm --filter @thor/gateway build

FROM base AS production

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml /app/
COPY packages/common/package.json /app/packages/common/
COPY packages/gateway/package.json /app/packages/gateway/
RUN cd /app && pnpm install --frozen-lockfile --prod --ignore-scripts

COPY --from=build /app/packages/common/dist/ /app/packages/common/dist/
COPY --from=build /app/packages/gateway/dist/ /app/packages/gateway/dist/

WORKDIR /workspace

ENV PORT=3002
EXPOSE 3002

CMD ["node", "/app/packages/gateway/dist/index.js"]
