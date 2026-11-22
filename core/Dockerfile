# Build context is the repo root (compose.yml: context ., dockerfile core/Dockerfile)
# so the panel build stage can be added here later.
FROM node:24-slim

ENV NODE_ENV=production
WORKDIR /app/core

COPY core/package.json core/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY core/src ./src
# Panel stage goes here: copy its build output to /app/panel/dist (config.panelDir default ../panel/dist)

RUN mkdir -p /data/storage && chown node:node /data/storage
USER node

EXPOSE 8080
# Node 24 runs the TypeScript sources directly (type stripping); no build step
CMD ["node", "src/server.ts"]
