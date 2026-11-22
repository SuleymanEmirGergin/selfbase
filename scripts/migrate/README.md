# Supabase -> selfbase migration

Run once, in order, against an empty, freshly bootstrapped selfbase database. Every script reads
its values from the environment or from `.env` at the repo root and never prints them.

| Variable | Used by | What |
|---|---|---|
| `SUPABASE_DB_URL` | 01 | Source, session pooler URL (`postgres.<ref>` user) |
| `SUPABASE_URL` | 04, 05 | `https://<ref>.supabase.co` |
| `SUPABASE_SERVICE_KEY` | 04 | Service key, only to download storage files |
| `TARGET_DB_URL` | 02, 03, 05, 06 | selfbase superuser URL (`postgres`) |
| `PUBLIC_URL` | 05 | selfbase public origin |
| `SERVICE_ROLE_KEY` | 06 | Written to the vault secrets the DB functions send |
| `STORAGE_DIR` | 04 | Host folder that becomes core's storage volume |

`pg_dump`/`psql` 17 run from the `postgres:17` image. 01 and 02 run inside a container, so
`TARGET_DB_URL` there must be reachable from a container: set `DOCKER_NETWORK` to the compose
network and use the service name (`db:5432`), or use `host.docker.internal:<port>`. 05 and 06 run on
the host (they use `pg` from `core/node_modules`, so `npm ci` in `core/` first), so their
`TARGET_DB_URL` uses `localhost:<port>`.

```bash
bash scripts/migrate/01-dump.sh                # -> dump/ (gitignored)
bash scripts/migrate/02-restore.sh             # extensions, schema + data, row-count check
node scripts/migrate/03-auth-storage.sql.mjs \
  | docker run --rm -i --network <net> -e TARGET_DB_URL postgres:17 \
      bash -c 'psql "$TARGET_DB_URL" -X -q -v ON_ERROR_STOP=1'
node scripts/migrate/04-files.mjs              # storage files -> STORAGE_DIR
node scripts/migrate/05-rewrite-urls.mjs --dry-run
node scripts/migrate/05-rewrite-urls.mjs
node scripts/migrate/06-realtime-cron.mjs
```

What each step does:

1. **01-dump.sh**: (a) `pg_dump -Fc` of every schema except Supabase's own (`auth, storage,
   realtime, vault, net, graphql, graphql_public, pgbouncer, extensions, supabase_functions,
   supabase_migrations, pgsodium, cron, _realtime, _analytics`, `selfbase`, `pg_*`), without
   extensions, publications and security labels; (b) `auth.users`, `auth.identities`,
   `storage.buckets`, `storage.objects` as JSON lines; (c) `dump/catalog/*.json`: extensions,
   storage policies, user triggers on `auth.users`/`storage.objects`, realtime publication tables,
   `cron.job`, `supabase_migrations.schema_migrations`, row counts per table. A catalog the pooler
   role cannot read is reported as `NOT READ` and the rest still runs.
2. **02-restore.sh**: installs the source's extensions (skips `pg_graphql, supabase_vault, pg_net,
   pgsodium, pg_stat_statements` and says so; moves relocatable ones to the source's schema), loads
   (a) with `ON_ERROR_STOP=1` leaving out event triggers, then compares every table's row count with
   `catalog/counts.json`. A missing Supabase object is fixed with a shim in `db/bootstrap/`, never by
   editing the dump.
3. **03**: copies the auth/storage rows into selfbase's tables (common columns only, source
   triggers off), then recreates the storage policies and the user triggers. Re-runnable.
4. **04-files.mjs**: downloads each object to `STORAGE_DIR/<bucket>/<name>`; skips files already
   there; prints downloaded/skipped/failed and exits 1 on any failure.
5. **05-rewrite-urls.mjs**: `https://<ref>.supabase.co` -> `PUBLIC_URL` in every text, varchar,
   json and jsonb column of the user schemas (same set as 01). `--dry-run` prints rows per
   `table.column`; a second dry run after applying prints 0.
6. **06-realtime-cron.mjs**: `selfbase.enable_realtime` (and the publication) for the realtime
   tables, `cron.schedule` for each `cron.job` row, and the vault secrets
   `notification_dispatch_secret` and `radar_news_cron_secret` (value: the env var of the upper-cased
   name if set, else `SERVICE_ROLE_KEY`; the edge functions' `NOTIFY_DISPATCH_SECRET` /
   `RADAR_NEWS_CRON_SECRET` must hold the same value).

## Schema replay (dev)

`dev/replay-from-repo.sh <corteqsemir path>` loads the CorteQS baseline dump and then every
`supabase/migrations/applied/*.sql` in filename order, one psql per file, into a fresh selfbase
database (read-only mount). `REPLAY_CONTINUE=1` runs each file in its own transaction and lists all
failures instead of stopping at the first.

Tests: `node --test scripts/migrate/test/rewrite.test.mjs`.
