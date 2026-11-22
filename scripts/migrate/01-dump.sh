#!/usr/bin/env bash
# Dumps a hosted Supabase project into dump/ (gitignored):
#   dump/schema-data.dump        (a) schema + data of every non-Supabase schema, pg_dump custom format
#   dump/<schema>.<table>.jsonl  (b) data only, one JSON row per line: auth.users, auth.identities,
#                                    storage.buckets, storage.objects
#   dump/catalog/*.json          (c) extensions, storage policies, user triggers on auth.users and
#                                    storage.objects, supabase_realtime tables, cron.job,
#                                    supabase_migrations.schema_migrations, row counts per table
# (a), (b) and (c) are read from one exported snapshot, so they agree with each other; if the source
# refuses to export one, 01 says so and goes on without (pause writes on the source during 01 anyway).
# Env (or .env at the repo root): SUPABASE_DB_URL (session pooler URL). Values are never printed.
# Optional: DUMP_DIR (default dump/), DOCKER_NETWORK (when the source is a local container).
# pg_dump/psql 17 run from the postgres:17 image.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
. "$here/lib.sh"
root="$(cd "$here/../.." && pwd)"
load_env "$root/.env"
: "${SUPABASE_DB_URL:?SUPABASE_DB_URL is not set}"
out="${DUMP_DIR:-$root/dump}"
mkdir -p "$out/catalog"
out_m="$(cd "$out" && (pwd -W 2>/dev/null || pwd))"
net=()
[ -n "${DOCKER_NETWORK:-}" ] && net=(--network "$DOCKER_NETWORK")

platform="auth storage realtime vault net graphql graphql_public pgbouncer extensions supabase_functions
supabase_migrations pgsodium cron _realtime _analytics selfbase"
excl_sql="'$(echo $platform | sed "s/ /','/g")'"

# One container: a holder session keeps the exported snapshot alive while every other step imports it.
script="$(declare -f pgenv)"$'\n'"$(cat <<'INNER'
set -euo pipefail
trap '' PIPE # a holder that already died must not kill the script on the final write
umask 077 # password hashes and data: owner-only files
pgenv SUPABASE_DB_URL
export PGOPTIONS='-c client_min_messages=warning'
q() { psql -X -q -At -v ON_ERROR_STOP=1 "$@"; }

mkfifo /tmp/holder
q < /tmp/holder > /tmp/snapshot 2> /tmp/holder.err &
holder=$!
exec 3> /tmp/holder
echo "begin isolation level repeatable read; select pg_export_snapshot();" >&3
for _ in $(seq 100); do [ -s /tmp/snapshot ] || ! kill -0 $holder 2>/dev/null && break; sleep 0.1; done
snap="$(head -n1 /tmp/snapshot 2>/dev/null || true)"
if [ -n "$snap" ]; then
  echo "01: using exported snapshot $snap"
  tx="begin isolation level repeatable read; set transaction snapshot '$snap';"
  dump_snap=(--snapshot="$snap")
else
  echo "01: WARNING: the source did not export a snapshot ($(grep -m1 -E 'ERROR|FATAL' /tmp/holder.err || echo unknown));" \
       "dump, auth rows and counts are separate reads, keep writes paused" >&2
  tx="begin isolation level repeatable read;"
  dump_snap=()
fi

exclude=(-N 'pg_*')
for s in $PLATFORM; do exclude+=(-N "$s"); done
echo "01: (a) schema + data of user schemas"
# Extensions are recreated by 02 from catalog/extensions.json (Supabase-only ones skipped),
# realtime by 06; pgsodium security labels mean nothing outside Supabase.
pg_dump -Fc --no-owner --exclude-extension='*' --no-publications --no-subscriptions --no-security-labels \
  "${dump_snap[@]}" "${exclude[@]}" -f /dump/schema-data.dump

echo "01: (b) auth and storage rows"
for t in auth.users auth.identities storage.buckets storage.objects; do
  printf '%s\n' "$tx" "\\o /dump/$t.jsonl" "select row_to_json(t) from $t t;" "\\o" "commit;" | q
done

echo "01: (c) catalog"
# Each catalog file is read on its own, so one unreadable catalog (the pooler role is not a true
# superuser) does not lose the others; the scripts that need a missing file say so.
# Empty search_path: trigger and policy definitions come out schema-qualified.
catalog() {
  if printf '%s\n' "$tx" "set local search_path = '';" "\\o /dump/catalog/$1.json" \
       "select coalesce(json_agg(q), '[]') from ($2) q;" "\\o" "commit;" | q 2> /tmp/err; then
    echo "  $1: ok"
  else
    echo "  $1: NOT READ ($(grep -m1 -E 'ERROR|FATAL' /tmp/err || echo 'unknown error'))" >&2
    rm -f "/dump/catalog/$1.json"
  fi
}
catalog extensions "select e.extname as name, n.nspname as schema, e.extversion as version
  from pg_extension e join pg_namespace n on n.oid = e.extnamespace"
catalog storage_policies "select * from pg_policies where schemaname = 'storage'"
catalog triggers "select n.nspname as schema, c.relname as table, t.tgname as name, pg_get_triggerdef(t.oid) as def
  from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
  join pg_proc p on p.oid = t.tgfoid join pg_namespace pn on pn.oid = p.pronamespace
  where not t.tgisinternal and (n.nspname, c.relname) in (('auth', 'users'), ('storage', 'objects'))
    and pn.nspname not in ($EXCL_SQL)"
catalog realtime_tables "select schemaname as schema, tablename as table from pg_publication_tables
  where pubname = 'supabase_realtime'"
catalog cron_jobs "select jobid, jobname, schedule, command, database, username, active from cron.job"
catalog schema_migrations "select version, name from supabase_migrations.schema_migrations"
catalog counts "select schemaname as schema, tablename as table,
    (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', schemaname, tablename),
      false, true, '')))[1]::text::bigint as rows
  from pg_tables where schemaname not in ($EXCL_SQL) and schemaname not like 'pg\\_%'
    and schemaname <> 'information_schema'
  union all select 'auth', 'users', (select count(*) from auth.users)
  union all select 'auth', 'identities', (select count(*) from auth.identities)
  union all select 'storage', 'buckets', (select count(*) from storage.buckets)
  union all select 'storage', 'objects', (select count(*) from storage.objects)"

echo "commit;" >&3 2>/dev/null || true
exec 3>&-
wait $holder || true
INNER
)"
MSYS_NO_PATHCONV=1 docker run --rm -i "${net[@]}" "${docker_user[@]}" -e SUPABASE_DB_URL \
  -e PLATFORM="$platform" -e EXCL_SQL="$excl_sql" -v "$out_m:/dump" postgres:17 bash -s <<< "$script" 2>&1 | redact
echo "01: done -> $out"
