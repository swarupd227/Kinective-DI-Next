# DI Next demo image: the Experience server, which also serves the built shell from the same origin.
# Build context is this folder (app/). Locally:  docker build -t dinext .
# On Azure:  az acr build --registry <acr> --image dinext:<tag> --file app/Dockerfile app
FROM node:22-bookworm-slim AS build
WORKDIR /app
# Dependencies first, so code changes reuse the cached install layer.
COPY package.json package-lock.json ./
COPY apps/shell/package.json apps/shell/
COPY apps/gallery/package.json apps/gallery/
COPY packages/agents/package.json packages/agents/
COPY packages/block-schemas/package.json packages/block-schemas/
COPY packages/blocks/package.json packages/blocks/
COPY packages/di-core/package.json packages/di-core/
COPY packages/mock-stream-server/package.json packages/mock-stream-server/
COPY packages/semantic/package.json packages/semantic/
COPY packages/stream-client/package.json packages/stream-client/
COPY packages/tenant-db/package.json packages/tenant-db/
COPY packages/tokens/package.json packages/tokens/
COPY packages/ui/package.json packages/ui/
COPY packages/voice/package.json packages/voice/
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run tokens && npm -w @dinext/shell run build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    MOCK_PORT=8787 \
    DI_STATIC_DIR=/app/apps/shell/dist \
    DI_DATA_DIR=/tmp/dinext-data
COPY --from=build /app /app
RUN chown -R node:node /app
USER node
EXPOSE 8787
# The server runs from TypeScript source with tsx, as in development. The seeding job runs:
#   npm run db:seed
CMD ["npx", "tsx", "packages/mock-stream-server/src/main.ts"]
