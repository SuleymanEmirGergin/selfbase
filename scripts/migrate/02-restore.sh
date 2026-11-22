#!/usr/bin/env bash
# Restores dump/schema-data.dump (from 01) into an empty, freshly bootstrapped selfbase database.
# Two phases, because app tables reference auth.users (56 foreign keys) and those rows come with 03:
#   02-restore.sh pre    1. installs the extensions the source had (catalog/extensions.json);
#                           Supabase-only ones are skipped and listed, an extension in a different
#                           schema is moved when it is relocatable
#                        2. loads the pre-data and data sections (tables, functions, rows)
#                        3. copies catalog/schema_migrations.json into supabase_migrations.schema_migrations
#   (03-auth-storage.sql.mjs rows: auth and storage rows)
#   02-restore.sh post   4. loads the post-data section (indexes, constraints incl. the FKs to
#                           auth.users, triggers, policies), then compares every table's row count
#                           with catalog/counts.json
# Each load runs psql -v ON_ERROR_STOP=1 and stops on the first error; event triggers are left out
# (they call Supabase platform functions). A missing Supabase object is fixed with a shim in
# db/bootstrap/, never by editing the dump.
# Env (or .env at the repo root): TARGET_DB_URL, a superuser URL reachable from a container
# (compose service name plus DOCKER_NETWORK, or host.docker.internal:<port>). Values are never printed.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
. "$here/lib.sh"
root="$(cd "$here/../.." && pwd)"
load_env "$root/.env"
phase="${1:-}"
[ "$phase" = pre ] || [ "$phase" = post ] || { echo "usage: 02-restore.sh pre|post" >&2; exit 2; }
: "${TARGET_DB_URL:?TARGET_DB_URL is not set}"
refuse_supabase_target TARGET_DB_URL
dump="${DUMP_DIR:-$root/dump}"
[ -f "$dump/schema-data.dump" ] || { echo "02: $dump/schema-data.dump not found, run 01 first" >&2; exit 1; }
[ -f "$dump/catalog/extensions.json" ] || { echo "02: catalog/extensions.json missing (01 could not read pg_extension)" >&2; exit 1; }
dump_m="$(cd "$dump" && (pwd -W 2>/dev/null || pwd))"
net=()
[ -n "${DOCKER_NETWORK:-}" ] && net=(--network "$DOCKER_NETWORK")

# $1: shell commands run in the container after pgenv; SQL for psql may come on stdin.
pg17() {
  MSYS_NO_PATHCONV=1 docker run --rm -i "${net[@]}" -e TARGET_DB_URL -v "$dump_m:/dump:ro" postgres:17 \
    bash -c "$(declare -f pgenv); set -euo pipefail; pgenv TARGET_DB_URL; $1" 2>&1 | redact
}
psql_t='psql -X -q -v ON_ERROR_STOP=1'
# pg_restore -l without event triggers, restricted to the given sections
toc='pg_restore -l "$@" /dump/schema-data.dump > /tmp/toc.all
  grep -vE "^[0-9]+; [0-9]+ [0-9]+ EVENT TRIGGER " /tmp/toc.all > /tmp/toc || true
  grep -E "^[0-9]+; [0-9]+ [0-9]+ EVENT TRIGGER " /tmp/toc.all | sed "s/^/02: left out: /" >&2 || true'
restore="pg_restore -O -L /tmp/toc -f - /dump/schema-data.dump | PGOPTIONS='-c client_min_messages=warning' $psql_t > /dev/null"

if [ "$phase" = pre ]; then
  echo "02: extensions"
  pg17 "$psql_t" <<'SQL'
\set ext `cat /dump/catalog/extensions.json`
\o /dev/null
select set_config('selfbase.restore_ext', :'ext', false);
\o
do $$
declare
  r record;
  cur text;
  supabase_only text[] := array['pg_graphql', 'supabase_vault', 'pg_net', 'pgsodium', 'pg_stat_statements'];
begin
  for r in select * from jsonb_to_recordset(current_setting('selfbase.restore_ext')::jsonb) as x(name text, schema text) loop
    if r.name = any(supabase_only) then
      raise warning 'skipped Supabase-only extension % (selfbase has its own stand-in or does not need it)', r.name;
      continue;
    end if;
    select n.nspname into cur from pg_extension e join pg_namespace n on n.oid = e.extnamespace where e.extname = r.name;
    if cur is null then
      if to_regnamespace(r.schema) is null then
        -- shortcut: an extension inside a schema the dump itself creates is not handled; install it by hand after the restore
        raise exception 'extension % lives in schema %, which does not exist before the restore', r.name, r.schema;
      end if;
      execute format('create extension %I with schema %I', r.name, r.schema);
      raise warning 'installed extension % in schema %', r.name, r.schema;
    elsif cur <> r.schema then
      if (select relocatable from pg_available_extension_versions v join pg_extension e on e.extname = v.name and e.extversion = v.version where e.extname = r.name) then
        execute format('alter extension %I set schema %I', r.name, r.schema);
        raise warning 'moved extension % from schema % to %', r.name, cur, r.schema;
      else
        raise exception 'extension % is in schema % here but % on the source and cannot be moved; fix db/bootstrap', r.name, cur, r.schema;
      end if;
    end if;
  end loop;
end
$$;
SQL

  echo "02: loading pre-data and data"
  pg17 "set -- --section=pre-data --section=data; $toc; $restore"

  if [ -f "$dump/catalog/schema_migrations.json" ]; then
    echo "02: source migration history"
    pg17 "$psql_t -At" <<'SQL'
\set sm `cat /dump/catalog/schema_migrations.json`
insert into supabase_migrations.schema_migrations (version, name)
  select version, name from jsonb_to_recordset(:'sm'::jsonb) as x(version text, name text)
  on conflict (version) do nothing;
select '02: ' || count(*) || ' rows in supabase_migrations.schema_migrations' from supabase_migrations.schema_migrations;
SQL
  else
    echo "02: catalog/schema_migrations.json missing, migration history not copied" >&2
  fi
  echo "02: pre done; next: 03-auth-storage.sql.mjs rows, then 02-restore.sh post"
  exit 0
fi

echo "02: loading post-data"
pg17 "set -- --section=post-data; $toc; $restore"

if [ -f "$dump/catalog/counts.json" ]; then
  echo "02: comparing row counts"
  pg17 "$psql_t -At" <<'SQL'
\set counts `cat /dump/catalog/counts.json`
\o /dev/null
select set_config('selfbase.restore_counts', :'counts', false);
\o
do $$
declare r record; n bigint; bad int := 0; total int := 0;
begin
  for r in select * from jsonb_to_recordset(current_setting('selfbase.restore_counts')::jsonb)
             as x(schema text, "table" text, rows bigint) loop
    total := total + 1;
    if to_regclass(format('%I.%I', r.schema, r."table")) is null then
      raise warning 'missing table %.%', r.schema, r."table"; bad := bad + 1; continue;
    end if;
    execute format('select count(*) from %I.%I', r.schema, r."table") into n;
    if n <> r.rows then
      raise warning '%.%: source % rows, here %', r.schema, r."table", r.rows, n; bad := bad + 1;
    end if;
  end loop;
  if bad > 0 then raise exception '% of % tables differ from the source', bad, total; end if;
  raise warning 'row counts match the source for % tables', total;
end
$$;
SQL
else
  echo "02: catalog/counts.json missing, row counts not compared" >&2
fi
echo "02: post done; next: 03-auth-storage.sql.mjs policies"
