# syntax=docker/dockerfile:1.7
# Vigil services image: one image, one process per container (see compose.yaml).

FROM node:24-bookworm-slim AS build
WORKDIR /app
ENV CI=true
RUN corepack enable

# Install with the lockfile only, so dependency layers are cached across code changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/watchtower/package.json packages/watchtower/
COPY packages/batcher/package.json packages/batcher/
COPY packages/wallet/package.json packages/wallet/
COPY packages/memo/package.json packages/memo/
COPY packages/receipts/package.json packages/receipts/
COPY packages/monitor/package.json packages/monitor/
COPY packages/api/package.json packages/api/
COPY packages/console/package.json packages/console/
COPY packages/mcp/package.json packages/mcp/
RUN pnpm install --frozen-lockfile --filter "./packages/*..." --filter .

COPY packages packages
RUN pnpm -r --filter "./packages/*" build

# Drop development dependencies and sources that the runtime does not need.
RUN pnpm install --frozen-lockfile --prod --filter "./packages/*..." \
  && find packages -maxdepth 2 -type d \( -name src -o -name test \) -exec rm -rf {} +

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production \
    NODE_NO_WARNINGS=1 \
    VIGIL_DATA_DIR=/data
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules node_modules
COPY --from=build --chown=node:node /app/packages packages
COPY --chown=node:node package.json LICENSE NOTICE ./
COPY --chown=node:node apps/web apps/web
COPY --chown=node:node docs docs
RUN mkdir /data && chown node:node /data
USER node
VOLUME ["/data"]
ENTRYPOINT ["node"]
CMD ["packages/api/dist/main.js"]
