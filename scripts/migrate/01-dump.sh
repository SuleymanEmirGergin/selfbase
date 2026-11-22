#!/usr/bin/env bash
# Dumps a hosted Supabase project into dump/ (gitignored):
#   dump/schema-data.dump        (a) schema + data of every non-Supabase schema, pg_dump custom format
#   dump/<schema>.<table>.jsonl  (b) data only, one JSON row per line: auth.users, auth.identities,
#                                    storage.buckets, storage.objects
#   dump/catalog/*.json          (c) extensions, storage policies, user triggers on auth.users and
#                                    storage.objects, supabase_realtime tables, cron.job,
#                                    supabase_migrations.schema_migrations, row counts per table
# Env (or .env at the repo root): SUPABASE_DB_URL (session pooler URL). Values are never printed.
# Optional: DUMP_DIR (default dump/), DOCKER_NETWORK (when the source is a local container).
# pg_dump/psql 17 run from the postgres:17 image.
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
[ -f "$root/.env" ] && { set -a; . "$root/.env"; set +a; }
: "${SUPABASE_DB_URL:?SUPABASE_DB_URL is not set}"
out="${DUMP_DIR:-$root/dump}"
mkdir -p "$out/catalog"
out_m="$(cd "$out" && (pwd -W 2>/dev/null || pwd))"
net=()
[ -n "${DOCKER_NETWORK:-}" ] && net=(--network "$DOCKER_NETWORK")

# Keeps connection strings, the pooler user (postgres.<ref>) and the project host out of error output.
redact() { sed -E 's#postgres(ql)?://[^[:space:]"]+#<db-url>#g; s#postgres\.[a-z0-9]{20}#postgres.<ref>#g; s#[a-z0-9]{20}\.supabase\.co#<ref>.supabase.co#g'; }
pg17() { MSYS_NO_PATHCONV=1 docker run --rm -i "${net[@]}" -e SUPABASE_DB_URL -v "$out_m:/dump" postgres:17 "$@"; }
# The URL is expanded inside the container, so it never shows up in a host command line; SQL comes on stdin.
src_psql() { pg17 bash -c 'psql "$SUPABASE_DB_URL" -X -q -At -v ON_ERROR_STOP=1'; }

platform="auth storage realtime vault net graphql graphql_public pgbouncer extensions supabase_functions
supabase_migrations pgsodium cron _realtime _analytics selfbase"
exclude=(-N 'pg_*')
for s in $platform; do exclude+=(-N "$s"); done
excl_sql="'$(echo $platform | sed "s/ /','/g")'"

echo "01: (a) schema + data of user schemas"
# Extensions are recreated by 02 from catalog/extensions.json (Supabase-only ones skipped),
# realtime by 06; pgsodium security labels mean nothing outside Supabase.
pg17 bash -c 'pg_dump "$SUPABASE_DB_URL" "$@"' _ -Fc --no-owner --exclude-extension='*' --no-publications \
  --no-subscriptions --no-security-labels "${exclude[@]}" -f /dump/schema-data.dump 2>&1 | redact

echo "01: (b) auth and storage rows"
for t in auth.users auth.identities storage.buckets storage.objects; do
  printf '%s\n' "\\o /dump/$t.jsonl" "select row_to_json(t) from $t t;" | src_psql 2>&1 | redact
done

echo "01: (c) catalog"
# Each catalog file is read on its own, so one unreadable catalog (the pooler role is not a true
# superuser) does not lose the others; the scripts that need a missing file say so.
catalog() {
  local name="$1" sql="$2"
  # Empty search_path: trigger and policy definitions come out schema-qualified.
  if printf '%s\n' "\\o /dump/catalog/$name.json" "set search_path = '';" "select coalesce(json_agg(q), '[]') from ($sql) q;" \
       | src_psql 2> "$out/catalog/.err"; then
    echo "  $name: ok"
  else
    echo "  $name: NOT READ ($(redact < "$out/catalog/.err" | grep -m1 -E 'ERROR|FATAL' || echo 'unknown error'))" >&2
    rm -f "$out/catalog/$name.json"
  fi
  rm -f "$out/catalog/.err"
}
catalog extensions "select e.extname as name, n.nspname as schema, e.extversion as version
  from pg_extension e join pg_namespace n on n.oid = e.extnamespace"
catalog storage_policies "select * from pg_policies where schemaname = 'storage'"
catalog triggers "select n.nspname as schema, c.relname as table, t.tgname as name, pg_get_triggerdef(t.oid) as def
  from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
  join pg_proc p on p.oid = t.tgfoid join pg_namespace pn on pn.oid = p.pronamespace
  where not t.tgisinternal and (n.nspname, c.relname) in (('auth', 'users'), ('storage', 'objects'))
    and pn.nspname not in ($excl_sql)"
catalog realtime_tables "select schemaname as schema, tablename as table from pg_publication_tables
  where pubname = 'supabase_realtime'"
catalog cron_jobs "select jobid, jobname, schedule, command, database, username, active from cron.job"
catalog schema_migrations "select version, name from supabase_migrations.schema_migrations"
catalog counts "select schemaname as schema, tablename as table,
    (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', schemaname, tablename),
      false, true, '')))[1]::text::bigint as rows
  from pg_tables where schemaname not in ($excl_sql) and schemaname not like 'pg\\_%'
    and schemaname <> 'information_schema'
  union all select 'auth', 'users', (select count(*) from auth.users)
  union all select 'storage', 'objects', (select count(*) from storage.objects)"

echo "01: done -> $out"
