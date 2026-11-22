# Build context is the repository root. The runtime has no dependencies; only the bake step needs yaml.
FROM node:24.22.2-slim AS bake
WORKDIR /bake
RUN npm install --no-save --no-package-lock --no-audit --no-fund yaml@2.9.1
COPY provisioner/scripts/bake-template.mjs template/compose.yml ./
# D-3: template/compose.yml -> JSON at build time; validated at provisioner start
RUN node bake-template.mjs compose.yml template.json

FROM node:24.22.2-slim
ENV NODE_ENV=production PORT=8090 TEMPLATE_PATH=/app/template.json SIZES_PATH=/app/sizes.json
WORKDIR /app/provisioner
COPY provisioner/package.json ./
COPY provisioner/src ./src
COPY --from=bake /bake/template.json /app/template.json
COPY template/sizes.json /app/sizes.json
USER node
EXPOSE 8090
# Node 24 runs the TypeScript sources directly (type stripping); no build step
CMD ["node", "src/server.ts"]
