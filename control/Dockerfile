# Build context is the repository root.

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

# No runtime dependencies yet, so no npm install.
FROM node:24.22.2-slim
ENV NODE_ENV=production PORT=8080 STUDIO_DIR=/app/studio
WORKDIR /app/control
COPY control/package.json ./
COPY control/src ./src
COPY --from=studio /src/studio/dist /app/studio
USER node
EXPOSE 8080
# Node 24 runs the TypeScript sources directly (type stripping); no build step
CMD ["node", "src/server.ts"]
