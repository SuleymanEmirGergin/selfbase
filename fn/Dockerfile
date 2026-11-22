# Build context is the repository root (template/compose.yml, CI), so the client bundle is baked in: deploy tools
# such as Coolify do not put repository files behind relative bind mounts.
FROM denoland/deno:alpine-2.1.4
WORKDIR /app
COPY fn/main.ts fn/config.ts fn/std_serve.ts fn/import_map.json ./
COPY client/dist /client
USER deno
RUN deno cache --no-lock --import-map=import_map.json main.ts
EXPOSE 8000
# /supabase (functions/ + config.toml) is the project's functions volume, read-only; locally
# template/compose.build.yml mounts the app's supabase/ folder there instead.
# Remote modules the functions import (esm.sh, deno.land, npm:) are downloaded on first use.
ENV FUNCTIONS_DIR=/supabase/functions
CMD ["deno", "run", "--no-lock", "--allow-net", "--allow-env", "--allow-read=/supabase/functions,/supabase/config.toml,/client,/app", "--import-map=/app/import_map.json", "/app/main.ts"]
