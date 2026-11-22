# Build context is the repo root (compose.yml: context ., dockerfile core/Dockerfile)

# Admin panel: static build, served by core at /panel/*
FROM node:24-slim AS panel
WORKDIR /app/panel
COPY panel/package.json panel/package-lock.json ./
RUN npm ci
COPY panel/ ./
RUN npm run build

FROM node:24-slim

ENV NODE_ENV=production
WORKDIR /app/core

COPY core/package.json core/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY core/src ./src
# config.panelDir default ../panel/dist, relative to /app/core
COPY --from=panel /app/panel/dist /app/panel/dist

RUN mkdir -p /data/storage && chown node:node /data/storage
USER node

EXPOSE 8080
# Node 24 runs the TypeScript sources directly (type stripping); no build step
CMD ["node", "src/server.ts"]
