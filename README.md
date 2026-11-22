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
| `compose.yml` | the whole stack; values from `.env` (see `.env.example`) |
| `db/` | Postgres image and `bootstrap/*.sql` (Supabase-compatible schemas, roles and shims) |
| `core/` | auth, storage, realtime, admin API, gateway (Node 24, Hono) |
| `fn/` | edge function host (Deno) |
| `panel/` | admin panel (React), built into the core image |
| `client/` | `selfbase-js`, the supabase-js drop-in; `client/dist/` is committed |
| `scripts/` | key generation, panel password, Supabase migration, sync, backup |

## Quick start

Needs Docker with Compose 2.24+ and Node 22+.

```sh
cp .env.example .env
node scripts/gen-keys.mjs       # paste the 3 lines into .env, add POSTGRES_PASSWORD (URL-safe)
docker compose up -d --build    # then: curl -s http://localhost:8080/health  ->  {"ok":true}
```

The panel is at `http://localhost:8080/panel/`; set its login with `node scripts/set-panel-password.mjs`
in a real terminal (after `npm ci` in `core/`).

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
