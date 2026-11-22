# Project template

One selfbase project is five containers: `db`, `rest`, `core`, `fn`, `pooler` (spec 7.2).

| File | Read by | Purpose |
|---|---|---|
| `compose.yml` | provisioner (baked into its image), local compose | The template. A strict subset of compose (see `provisioner/src/template.ts`): `services` and `volumes`; per service only `image`, `command`, `environment`, `volumes` (named), `depends_on` (list), `healthcheck`, `init`, `user`, `stop_grace_period`. Images are `${REGISTRY}/selfbase-<service>:${TEMPLATE_VERSION}`. |
| `sizes.json` | provisioner | Memory (MiB), CPUs and process limit per size and service, plus `db.shm_mb`, `db.shared_buffers`, `db.max_connections`, `pooler.pool_size`. micro 1184, small 2336, medium 3872 MiB in total. |
| `compose.build.yml` | local compose only | Builds the images, adds the project name, restart policy and start conditions, publishes core on `127.0.0.1:${CORE_PORT:-8080}` (never the admin port 8081) and mounts `${SUPABASE_DIR}` over the functions volume. |
| `.env.example` | you | Values for the local stack; copy to `.env` at the repository root. |
| `compose.test.yml` | core/client tests, CI | Throwaway test databases and PostgREST. |
| `compose.local.yml` | migration scripts | Publishes `db` on `127.0.0.1:${LOCAL_DB_PORT:-55432}`. Local only. |

The provisioner adds what the template leaves out: limits from `sizes.json`, restart `unless-stopped`,
`no-new-privileges`, logging, the project network `sb-<ref>`, and for `core` alone the proxy network with
Traefik labels on port 8080.

Check the template (also renders it for every size):

    node provisioner/src/template.ts --check template/compose.yml

Local stack, from the repository root:

    docker compose -f template/compose.yml -f template/compose.build.yml --env-file .env up -d --build

`rest` exits and is restarted until `core` has applied the platform migrations and set the authenticator
password; the stack is up when all five services are healthy. Tests: `node --test scripts/test/template.test.mjs`
(builds the images and brings up a throwaway `sb-template-test` stack).

Test stack, in two steps (rest restarts until core's test setup has migrated `db`):

    docker compose -p <name> -f template/compose.test.yml up -d --build --wait db db-empty db-v1
    docker compose -p <name> -f template/compose.test.yml up -d rest
