# Supabase -> selfbase migration

Run once, in the order below, against an empty, freshly bootstrapped selfbase database. Every script
reads its values from the environment or from `.env` at the repo root and never prints them.

**`.env` format** (bash and Node scripts read it the same way): one `KEY=value` per line, the value
taken literally to the end of the line: no quotes, no inline `#` comments, no `$` expansion, no
`export`. Windows line endings are fine. A variable already set in the environment wins.
The root `.env` is also read by docker compose, which strips quotes and inline ` #` comments
while these scripts keep them: write every value unquoted and without an inline comment so it
means the same to both. A password with characters that are special in a URL (`/ # ? @ : %`) is
percent-encoded inside the URL variables.

| Variable | Used by | What |
|---|---|---|
| `SUPABASE_DB_URL` | 01 | Source, session pooler URL (`postgres.<ref>` user) |
| `SUPABASE_URL` | 04, 05 | `https://<ref>.supabase.co` |
| `SUPABASE_SERVICE_KEY` | 04 | Service key, only to download storage files |
| `TARGET_DB_URL` | 02, 03 (and 05, 06 unless `TARGET_DB_URL_HOST` is set) | selfbase superuser URL (`postgres`) reachable from a container (`db:5432`); a `*.supabase.co`/`*.supabase.com` host is refused |
| `TARGET_DB_URL_HOST` | 05, 06 | Optional. Same database as seen from the host (`localhost:<published port>`); preferred over `TARGET_DB_URL` when set (empty = unset). Same Supabase-host refusal; never printed |
| `PUBLIC_URL` | 05 | selfbase public origin |
| `SERVICE_ROLE_KEY` | 06 | Fallback value for the vault secrets (see 06) |
| `NOTIFY_DISPATCH_SECRET`, `RADAR_NEWS_CRON_SECRET` | 06 | Optional; the edge functions' values for the two vault secrets |
| `STORAGE_DIR` | 04 | Folder on this computer the files are downloaded to; give it on the command line (`STORAGE_DIR=./data/storage`), then copy it into core's `<project>_storage` volume (docs/REHBER.md section 7) |

`pg_dump`/`psql` 17 run from the `postgres:17.12` image. The container script goes in on stdin and
turns the URL into `PG*` variables (password in `PGPASSWORD`), so no password appears in a command
line, neither docker's nor psql's; 05 and 06 hand the URL to `pg` in-process. 01, 02 and the 03 pipe
(`psql_target` from `lib.sh`) run in a container, so `TARGET_DB_URL` there must be reachable from a container: set `DOCKER_NETWORK` to the
compose network and use the service name (`db:5432`), or use `host.docker.internal:<port>`. 05 and
06 run on the host (they use `pg` from `core/node_modules`, so `npm ci` in `core/` first), so they
use `TARGET_DB_URL_HOST` (`localhost:<port>`) when set, else `TARGET_DB_URL`. With both set, `.env` needs no edits between steps.

**Pause writes on the source during step 1.** 01 reads everything from one exported snapshot, but
if the pooler refuses to export one it says so and the reads are separate.

```bash
# psql_target (steps 3 and 5): reads .env like the scripts, refuses a Supabase host, password via
# PGPASSWORD inside the container; honours DOCKER_NETWORK
. scripts/migrate/lib.sh

bash scripts/migrate/01-dump.sh                                   # 1. source -> dump/ (gitignored)
bash scripts/migrate/02-restore.sh pre                            # 2. extensions, tables, functions, rows
node scripts/migrate/03-auth-storage.sql.mjs rows | psql_target   # 3. auth users, identities, storage rows
bash scripts/migrate/02-restore.sh post                           # 4. indexes, constraints (FKs to auth.users), row-count check
node scripts/migrate/03-auth-storage.sql.mjs policies | psql_target  # 5. storage policies, auth/storage triggers
STORAGE_DIR=./data/storage node scripts/migrate/04-files.mjs      # 6. storage files -> ./data/storage, then copy into the volume
node scripts/migrate/05-rewrite-urls.mjs --dry-run                # 7. see what will change
node scripts/migrate/05-rewrite-urls.mjs                          #    rewrite
node scripts/migrate/06-realtime-cron.mjs                         # 8. realtime, cron (inactive), vault
node scripts/migrate/06-realtime-cron.mjs --activate              # 9. at cutover only
```

Why this order: app tables have foreign keys to `auth.users`, and those rows come with step 3, so
constraints (post-data) can only be added after it.

What each step does:

1. **01-dump.sh**: inside one container, a holder session exports a snapshot that every read uses:
   (a) `pg_dump -Fc` of every schema except Supabase's own (`auth, storage, realtime, vault, net,
   graphql, graphql_public, pgbouncer, extensions, supabase_functions, supabase_migrations, pgsodium,
   cron, _realtime, _analytics`, `selfbase`, `pg_*`), without extensions, publications and security
   labels; (b) `auth.users`, `auth.identities`, `storage.buckets`, `storage.objects` as JSON lines;
   (c) `dump/catalog/*.json`: extensions, storage policies, user triggers on
   `auth.users`/`storage.objects`, realtime publication tables, `cron.job`,
   `supabase_migrations.schema_migrations`, row counts per table. A catalog the pooler role cannot
   read is reported as `NOT READ` and the rest still runs. Files are owner-only (on Linux/macOS the
   container runs as you).
2. **02-restore.sh pre**: refuses a target that is not empty, then in one transaction installs the
   source's extensions (skips `pg_graphql, supabase_vault, pg_net, pgsodium, pg_stat_statements` and
   says so; moves relocatable ones to the source's schema), loads the pre-data and data sections
   with `ON_ERROR_STOP=1`, leaving out event triggers, and copies the source's migration history
   into `supabase_migrations.schema_migrations`. A failure rolls everything back, so fix the cause
   and run it again. A missing Supabase object is fixed with a shim in `db/bootstrap/`, never by
   editing the dump.
3. **03 rows**: copies the auth/storage rows into selfbase's tables (common columns only; source-only
   column names are listed; source triggers off). Every source id must be present afterwards, or it
   aborts. Re-runnable.
4. **02-restore.sh post**: refuses unless `auth.users`/`auth.identities` hold the source's counts
   (step 3 ran), then in one transaction loads the post-data section and compares every table's row
   count (auth and storage included) with `catalog/counts.json`; a mismatch rolls it back. After the commit it sends `NOTIFY pgrst, 'reload schema'` so PostgREST sees the restored tables without a restart.
5. **03 policies**: recreates the storage policies and the user triggers on `auth.users` and
   `storage.objects`, then sends the same `NOTIFY pgrst, 'reload schema'`.
6. **04-files.mjs**: downloads each object to `STORAGE_DIR/<bucket>/<name>`; skips files already
   there; never follows redirects (the service key stays with Supabase); prints
   downloaded/skipped/failed and exits 1 on any failure.
7. **05-rewrite-urls.mjs**: `https://<ref>.supabase.co` -> `PUBLIC_URL` in every text, varchar,
   text[], varchar[], json and jsonb column (and domains over them) of the user schemas plus `auth`
   and `storage`, with triggers off. `cron` is not touched. `--dry-run` prints rows per
   `table.column` and the schemas scanned; a second dry run after applying prints 0.
8. **06-realtime-cron.mjs**: `selfbase.enable_realtime` (and the publication) for the realtime
   tables, `cron.schedule` for each `cron.job` row, **registered inactive** so the source and
   selfbase do not both run the pipelines, and the vault secrets `notification_dispatch_secret` /
   `radar_news_cron_secret`. Each comes from `NOTIFY_DISPATCH_SECRET` / `RADAR_NEWS_CRON_SECRET` if
   set, else from `SERVICE_ROLE_KEY` (printed as a warning; the function env must then hold the
   same value). The script prints which variable it used, never the value.
9. **06 --activate**: at cutover, after the source's jobs are stopped. Jobs inactive on the source
   stay inactive; a later run without the flag deactivates them again.

## Schema replay (dev)

`dev/replay-from-repo.sh <corteqsemir path>` loads the CorteQS baseline dump and then every
`supabase/migrations/applied/*.sql` in filename order, one psql per file, into a fresh selfbase
database (read-only mount). `REPLAY_CONTINUE=1` runs each file in its own transaction and lists all
failures instead of stopping at the first.

Tests: `node --test scripts/migrate/test/rewrite.test.mjs` and `bash scripts/migrate/test/lib.test.sh`.

## After the migration: sync and backup

- `node scripts/sync.mjs --repo <corteqsemir> --baseline` once right after the migration, then
  `node scripts/sync.mjs --repo <corteqsemir>` whenever the team adds migrations (`--dry-run` lists
  first; `--mark-applied <file>` records a file applied by hand). Same `TARGET_DB_URL` rules as 02.
  Details in the header of `scripts/sync.mjs`.
  Limits: sync runs migrations as a superuser and trusts them. Applying a file and recording it happen
  atomically for files whose transaction control the scanner can see. A file that hides transaction
  control from the scanner (setting names built at run time, quote-mode tricks) can break that, and
  then "(rolled back)" or "applied" may not describe the database exactly. Effects that are not
  transactional at all (NOTIFY, dblink or pg_background, COPY ... TO PROGRAM, lo_export, session
  settings) are never undone by a rollback.
- The compose `backup` service writes `/backups/<UTC timestamp>/` (database, roles, storage) every
  day at 03:15 UTC; `docker compose run --rm backup /scripts/backup.sh` makes one now.
- `scripts/restore.sh <timestamp> --yes-overwrite` restores over the running stack. It does not
  remove objects created after the backup and puts the migration ledger back to the backup's state
  (sync then fails on "already exists" until those objects are dropped or marked with
  `--mark-applied`). The safer path, restoring into a new database and switching over, is spelled
  out command by command in the header of `scripts/restore.sh`.
