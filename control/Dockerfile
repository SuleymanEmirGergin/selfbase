# Build context is the repository root.
# /app mirrors the repository layout, so every path control derives from its source tree holds: db/platform
# (PLATFORM_DIR's default), control/migrations, template/sizes.json (sizes.ts) and core/src, which control imports as
# selfbase-core. That package resolves through a workspace symlink to /app/core, outside node_modules: Node refuses
# to strip types from files under node_modules.

# Studio: a static build, served by control from STUDIO_DIR.
FROM node:24.22.2-slim AS studio
WORKDIR /src
# npm ci resolves the whole workspace lockfile, so every workspace manifest must be present
COPY package.json package-lock.json ./
COPY core/package.json core/
COPY control/package.json control/
COPY provisioner/package.json provisioner/
COPY studio/package.json studio/
COPY client/package.json client/
RUN npm ci -w studio --include-workspace-root=false --ignore-scripts --no-audit --no-fund
COPY studio ./studio
RUN npm run build -w studio

# Runtime dependencies of control and of the core modules it loads.
FROM node:24.22.2-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY core/package.json core/
COPY control/package.json control/
COPY provisioner/package.json provisioner/
COPY studio/package.json studio/
COPY client/package.json client/
RUN npm ci -w control -w core --omit=dev --include-workspace-root=false --ignore-scripts --no-audit --no-fund

FROM node:24.22.2-slim
ENV NODE_ENV=production PORT=8080 STUDIO_DIR=/app/studio
WORKDIR /app/control
COPY --from=deps /app/node_modules /app/node_modules
COPY core/package.json /app/core/
COPY core/src /app/core/src
COPY db/platform /app/db/platform
COPY template/sizes.json /app/template/sizes.json
# operator scripts, so the server needs no Node of its own: docker run --rm <image> node /app/scripts/<name>.mjs
COPY scripts/gen-keys.mjs scripts/install-check.mjs scripts/import-project.mjs /app/scripts/
COPY control/package.json ./
COPY control/src ./src
COPY control/migrations ./migrations
COPY --from=studio /src/studio/dist /app/studio
USER node
EXPOSE 8080
# Node 24 runs the TypeScript sources directly (type stripping); no build step
CMD ["node", "src/server.ts"]
