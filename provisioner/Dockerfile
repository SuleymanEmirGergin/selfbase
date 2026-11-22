# Build context is the repository root. No runtime dependencies yet, so no npm install.
FROM node:24.22.2-slim
ENV NODE_ENV=production PORT=8090
WORKDIR /app/provisioner
COPY provisioner/package.json ./
COPY provisioner/src ./src
USER node
EXPOSE 8090
# Node 24 runs the TypeScript sources directly (type stripping); no build step
CMD ["node", "src/server.ts"]
