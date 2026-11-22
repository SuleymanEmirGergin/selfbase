FROM denoland/deno:alpine-2.1.4
WORKDIR /app
COPY main.ts config.ts std_serve.ts import_map.json ./
USER deno
RUN deno cache --no-lock --import-map=import_map.json main.ts
EXPOSE 8000
# The app's supabase/ folder is bind-mounted at /supabase (functions/ + config.toml), the client at /client.
# Remote modules the functions import (esm.sh, deno.land, npm:) are downloaded on first use.
ENV FUNCTIONS_DIR=/supabase/functions
CMD ["deno", "run", "--no-lock", "--allow-net", "--allow-env", "--allow-read=/supabase/functions,/supabase/config.toml,/client,/app", "--import-map=/app/import_map.json", "/app/main.ts"]
