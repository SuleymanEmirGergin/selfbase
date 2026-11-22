# Build context is the repository root. Dependencies come from the root lockfile (npm workspaces);
# every workspace's package.json is copied so npm ci sees the lockfile's whole tree.
FROM node:24.22.2-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
COPY core/package.json core/
COPY control/package.json control/
COPY provisioner/package.json provisioner/
COPY studio/package.json studio/
COPY client/package.json client/
RUN npm ci --omit=dev --workspace selfbase-core && npm cache clean --force

WORKDIR /app/core
COPY core/src ./src

RUN mkdir -p /data/storage && chown node:node /data/storage
USER node

EXPOSE 8080
# Node 24 runs the TypeScript sources directly (type stripping); no build step
CMD ["node", "src/server.ts"]
