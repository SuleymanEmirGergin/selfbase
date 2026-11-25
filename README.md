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
reverse proxy (Coolify, Caddy, nginx; must pass the browser's Host header)
        |
      core :8080  Node: /auth/v1 /storage/v1 /realtime/v1, gateway (/admin on :8081, never published)
        |-- /rest/v1 ------> rest   PostgREST 14
        |-- /functions/v1 -> fn     Deno, mounts the app's supabase/functions read-only
        '------------------> db     Postgres 17 + PostGIS + pgvector + pg_cron
```

Only `core` is published. `net.http_post` calls are queued in the database and sent by core;
`*.supabase.co` targets are rewritten to the internal services.

On a server, that stack is one *project*. A single control stack (`control/compose.yml`) runs Studio, the
control API, a control database, the Docker provisioner behind a socket proxy, and a log store. It creates,
pauses, backs up, upgrades and deletes project stacks (`sb-<ref>-*` containers on their own network), each
reachable at `https://<ref>.<BASE>` through Traefik: Coolify's proxy (`PROXY_MODE=coolify`) or one the control
stack brings (`PROXY_MODE=own`). Projects keep serving while the control stack is down.

| Path | What |
|---|---|
| `package.json` | npm workspaces: `core`, `control`, `provisioner`, `studio`, `client`, `acceptance`; one lockfile at the root |
| `template/` | project template: `compose.yml` (five services), `sizes.json`; `compose.build.yml` and `compose.local.yml` for a local stack (`.env.example`); `compose.test.yml`, the test databases |
| `db/` | Postgres image and `platform/*.sql` (Supabase-compatible schemas, roles and shims; core applies them) |
| `core/` | auth, storage, realtime, admin API, gateway (Node 24, Hono) |
| `fn/` | edge function host (Deno) |
| `studio/` | Studio, the dashboard (React, English and Turkish); built into the control image |
| `control/`, `provisioner/` | control plane (Studio's API, jobs, reconcile; `control/compose.yml`) and the Docker provisioner |
| `rest/`, `pooler/`, `job/` | PostgREST and PgBouncer images; backup/restore job image (`job/backup.sh`, `job/restore.sh`) |
| `client/` | `selfbase-js`, the supabase-js drop-in; `client/dist/` is committed |
| `acceptance/` | acceptance suite against a deployed project, `full` and `live` modes (`acceptance/README.md`) |
| `scripts/` | key generation, install check, project import, Supabase migration, sync |

## Quick start

Needs Docker with Compose 2.24+ and Node 22+. Run everything from the repository root.

```sh
cp template/.env.example .env
node scripts/gen-keys.mjs       # paste the 3 lines into .env; also set POSTGRES_PASSWORD and
                                # AUTHENTICATOR_PASSWORD (URL-safe), ADMIN_TOKEN (32+ chars), PUBLIC_URL, SITE_URL
docker compose -f template/compose.yml -f template/compose.build.yml --env-file .env up -d --build
# no --wait: rest restarts until core has migrated the database; give it about 30 s
curl -s http://localhost:8080/health   # {"ok":true}
```

`template/compose.yml` names its project `selfbase` (or `COMPOSE_PROJECT_NAME`), as v1's checkout
directory did, so an existing install keeps its volumes (`selfbase_pgdata`, `selfbase_storage`, ...).
A second stack on the same host needs its own `COMPOSE_PROJECT_NAME`. Without `--env-file .env`,
compose reads `template/.env`. Commands that use plain `docker compose`, such as `job/restore.sh`,
need `COMPOSE_FILE=template/compose.yml COMPOSE_ENV_FILES=.env` in the environment.

Development: `npm ci` at the root installs every workspace. Tests need the test databases:
`docker compose -p sb-test -f template/compose.test.yml up -d --build --wait db db-empty db-v1`, the same
`up -d rest` (it restarts until core's tests have migrated db), and
`docker compose -f control/compose.test.yml up -d --build --wait` (control's, on port 54340), then
`TEST_COMPOSE_PROJECT=sb-test TEST_COMPOSE_FILE=../template/compose.test.yml npm test --workspaces --if-present`.
CI (`.github/workflows/ci.yml`) does the same and builds all eight images; `images.yml` lists them and
would push a `v*` tag to GHCR. Actions is currently blocked by billing, so a release is built on the
server from a checkout of its tag (`docker build -f <name>/Dockerfile .` for each image in `images.yml`),
with no registry login; the previous tag's images stay for rollback.

The dashboard is Studio, served by control (`control/compose.yml`); a single template stack has none.

## Guide

The full operator guide is in Turkish: [`docs/REHBER.md`](docs/REHBER.md). It covers installing the
control stack next to Coolify and on a server of your own (every `.env` line), Studio accounts, roles and
access tokens, projects and the memory budget, domains and the weekly certificate cap, secrets and the
master key, backups, export and import, logs, upgrades, living with Coolify's cleanup, troubleshooting,
removal, a local single-project stack, migrating data from Supabase (`scripts/migrate/`), connecting an
app, and sync. Studio screenshots: `docs/screens/v2/`. Wave 1 evidence: `docs/proofs/`.

Other docs: `scripts/migrate/README.md` (migration internals), `client/README.md` (client build and
tests), `docs/functions-status.md`, `docs/auth-settings.md`.

## Licences of vendored code

- `client/vendor/postgrest-js/`: postgrest-js, MIT License, Copyright (c) 2020 Supabase. Bundled into
  `client/dist/`; the licence ships as `client/dist/LICENSE-postgrest-js`.
- `client/vendor/supabase-js/`: type code from supabase-js, MIT License, Copyright (c) 2020 Supabase.
  Licence in `client/dist/LICENSE-supabase-js`.

Runtime components: PostgreSQL (PostgreSQL License), PostGIS (GPL-2.0, unmodified image), pgvector
and pg_cron (PostgreSQL License), PostgREST (MIT), Node.js and Deno (MIT).
