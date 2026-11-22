FROM denoland/deno:alpine-2.1.4
WORKDIR /app
COPY main.ts config.ts std_serve.ts import_map.json ./
USER deno
RUN deno cache --no-lock --import-map=import_map.json main.ts
EXPOSE 8000
# Functions are bind-mounted at /functions, their config.toml at /config.toml, the client at /client.
# Remote modules the functions import (esm.sh, deno.land, npm:) are downloaded on first use.
ENV FUNCTIONS_DIR=/functions
CMD ["deno", "run", "--no-lock", "--allow-net", "--allow-env", "--allow-read=/functions,/config.toml,/client,/app", "--import-map=/app/import_map.json", "/app/main.ts"]
