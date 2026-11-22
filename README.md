# selfbase

A small self-hosted backend that replaces Supabase for the CorteQS app. It keeps Supabase's HTTP
paths and response shapes, so the app keeps importing `@supabase/supabase-js` and a build alias
points that import at `selfbase-js`. Postgres RLS policies and migrations run unchanged.

No `@supabase/*` package and no `supabase/*` image run anywhere. Idle memory is about 166 MiB empty
and 227 MiB with the CorteQS dev data.

## Architecture

```
browser / app (selfbase-js)
        |  HTTPS + WSS
reverse proxy (Coolify, Caddy, nginx)
        |
      core :8080  Node: /auth/v1 /storage/v1 /realtime/v1 /admin /panel/, gateway
        |-- /rest/v1 ------> rest   PostgREST 14
        |-- /functions/v1 -> fn     Deno, mounts the app's supabase/functions read-only
        '------------------> db     Postgres 17 + PostGIS + pgvector + pg_cron
```

Only `core` is published. `net.http_post` calls are queued in the database and sent by core;
`*.supabase.co` targets are rewritten to the internal services.

| Path | What |
|---|---|
| `package.json` | npm workspaces: `core`, `control`, `provisioner`, `studio`, `client`, `acceptance`; one lockfile at the root |
| `template/` | `compose.yml`, the whole stack (values from `.env`, see `.env.example`); `compose.test.yml`, the test database |
| `db/` | Postgres image and `bootstrap/*.sql` (Supabase-compatible schemas, roles and shims) |
| `core/` | auth, storage, realtime, admin API, gateway (Node 24, Hono) |
| `fn/` | edge function host (Deno) |
| `studio/` | dashboard (React), today's admin panel |
| `control/`, `provisioner/` | control plane and Docker provisioner (stubs for now) |
| `rest/`, `pooler/`, `job/` | PostgREST and PgBouncer images; backup/restore job image (`job/backup.sh`, `job/restore.sh`) |
| `client/` | `selfbase-js`, the supabase-js drop-in; `client/dist/` is committed |
| `acceptance/` | acceptance suite against a deployed project, `full` and `live` modes (`acceptance/README.md`) |
| `scripts/` | key generation, panel password, Supabase migration, sync |

## Quick start

Needs Docker with Compose 2.24+ and Node 22+. Run everything from the repository root.

```sh
cp .env.example .env
node scripts/gen-keys.mjs       # paste the 3 lines into .env, add POSTGRES_PASSWORD (URL-safe)
docker compose -f template/compose.yml --env-file .env up -d --build
curl -s http://localhost:8080/health   # {"ok":true}
```

`template/compose.yml` names its project `selfbase` (or `COMPOSE_PROJECT_NAME`), as v1's checkout
directory did, so an existing install keeps its volumes (`selfbase_pgdata`, `selfbase_storage`, ...).
A second stack on the same host needs its own `COMPOSE_PROJECT_NAME`. Without `--env-file .env`,
compose reads `template/.env`. Commands that use plain `docker compose`, such as `job/restore.sh`,
need `COMPOSE_FILE=template/compose.yml COMPOSE_ENV_FILES=.env` in the environment.

Development: `npm ci` at the root installs every workspace. Tests need the test database:
`docker compose -p sb-test -f template/compose.test.yml up -d --build --wait db rest`, then
`TEST_COMPOSE_PROJECT=sb-test TEST_COMPOSE_FILE=../template/compose.test.yml npm test --workspaces --if-present`.
CI (`.github/workflows/ci.yml`) does the same and builds all eight images; a `v*` tag pushes them to
GHCR (`images.yml`).

The panel is at `http://localhost:8080/panel/`; set its login with `node scripts/set-panel-password.mjs`
in a real terminal (after `npm ci` at the root).

## Guide

The full operator guide is in Turkish: [`docs/REHBER.md`](docs/REHBER.md). It covers every `.env`
line, Coolify and plain-Docker deployment, migrating from Supabase (`scripts/migrate/`), connecting an
app, the panel, sync, backups, a second installation for another app, known limits and
troubleshooting.

Other docs: `scripts/migrate/README.md` (migration internals), `client/README.md` (client build and
tests), `docs/functions-status.md`, `docs/auth-settings.md`.

## Licences of vendored code

- `client/vendor/postgrest-js/`: postgrest-js, MIT License, Copyright (c) 2020 Supabase. Bundled into
  `client/dist/`; the licence ships as `client/dist/LICENSE-postgrest-js`.
- `client/vendor/supabase-js/`: type code from supabase-js, MIT License, Copyright (c) 2020 Supabase.
  Licence in `client/dist/LICENSE-supabase-js`.

Runtime components: PostgreSQL (PostgreSQL License), PostGIS (GPL-2.0, unmodified image), pgvector
and pg_cron (PostgreSQL License), PostgREST (MIT), Node.js and Deno (MIT).
