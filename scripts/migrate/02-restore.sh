#!/usr/bin/env bash
# Restores dump/schema-data.dump (from 01) into an empty, freshly bootstrapped selfbase database.
# Two phases, because app tables reference auth.users and those rows come with 03:
#   02-restore.sh pre    refuses unless the target is empty, then in ONE transaction:
#                        1. installs the extensions the source had (catalog/extensions.json);
#                           Supabase-only ones are skipped and listed, an extension in a different
#                           schema is moved when it is relocatable
#                        2. loads the pre-data and data sections (tables, functions, rows)
#                        3. copies catalog/schema_migrations.json into supabase_migrations.schema_migrations
#   (03-auth-storage.sql.mjs rows: auth and storage rows)
#   02-restore.sh post   refuses unless auth.users/auth.identities hold the source's row counts
#                        (i.e. 03 rows ran), then in ONE transaction: loads the post-data section
#                        (indexes, constraints incl. the FKs to auth.users, triggers, policies) and
#                        compares every table's row count with catalog/counts.json
# A failure rolls the whole phase back, so the target is as before and the phase can simply be re-run.
# Event triggers are left out (they call Supabase platform functions). A missing Supabase object is
# fixed with a shim in db/bootstrap/, never by editing the dump.
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
refuse_supabase_target TARGET_DB_URL || exit 2
dump="${DUMP_DIR:-$root/dump}"
[ -f "$dump/schema-data.dump" ] || { echo "02: $dump/schema-data.dump not found, run 01 first" >&2; exit 1; }
[ -f "$dump/catalog/extensions.json" ] || { echo "02: catalog/extensions.json missing (01 could not read pg_extension)" >&2; exit 1; }
[ -f "$dump/catalog/counts.json" ] || { echo "02: catalog/counts.json missing (01 could not count rows); needed to check the restore" >&2; exit 1; }
dump_m="$(cd "$dump" && (pwd -W 2>/dev/null || pwd))"
net=()
[ -n "${DOCKER_NETWORK:-}" ] && net=(--network "$DOCKER_NETWORK")

# The container script comes on stdin (see lib.sh container_run); it starts with this prologue.
pg17() { container_run "${net[@]}" -e TARGET_DB_URL -v "$dump_m:/dump:ro" 2>&1 | redact; }
prologue='set -euo pipefail
pgenv TARGET_DB_URL
export PGOPTIONS="-c client_min_messages=warning"
q() { psql -X -q -v ON_ERROR_STOP=1 "$@"; }
# pg_restore TOC of the given sections, without event triggers
toc() {
  pg_restore -l "$@" /dump/schema-data.dump > /tmp/toc.all
  grep -vE "^[0-9]+; [0-9]+ [0-9]+ EVENT TRIGGER " /tmp/toc.all > /tmp/toc || true
  grep -E "^[0-9]+; [0-9]+ [0-9]+ EVENT TRIGGER " /tmp/toc.all | sed "s/^/02: left out: /" >&2 || true
}'

if [ "$phase" = pre ]; then
  echo "02: pre (one transaction)"
  script="$prologue"$'\n'"$(cat <<'EOS'
# Empty target: public holds only extension members and no schema exists beyond the bootstrap's.
q -At <<'SQL'
do $$
declare n int; extra text;
begin
  select count(*) into n from (
    select oid from pg_class where relnamespace = 'public'::regnamespace and relkind in ('r', 'p', 'v', 'm', 'S', 'f')
    union all select oid from pg_proc where pronamespace = 'public'::regnamespace
    union all select oid from pg_type where typnamespace = 'public'::regnamespace and typrelid = 0 and typcategory <> 'A'
  ) o where not exists (select 1 from pg_depend d where d.objid = o.oid and d.deptype = 'e');
  select string_agg(nspname, ', ') into extra from pg_namespace
   where nspname not in ('public', 'auth', 'storage', 'extensions', 'net', 'vault', 'selfbase', 'cron',
                         'supabase_migrations', 'information_schema') and nspname not like 'pg\_%';
  if n > 0 or extra is not null then
    raise exception '02 pre: the target is not empty (% objects in public; extra schemas: %); use a freshly bootstrapped database',
      n, coalesce(extra, 'none');
  end if;
end $$;
SQL

toc --section=pre-data --section=data
{
  echo 'begin;'
  cat <<'SQL'
\set ext `cat /dump/catalog/extensions.json`
select set_config('selfbase.restore_ext', :'ext', true) \g /dev/null
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
  pg_restore -O -L /tmp/toc -f - /dump/schema-data.dump
  if [ -f /dump/catalog/schema_migrations.json ]; then
    cat <<'SQL'
\set sm `cat /dump/catalog/schema_migrations.json`
insert into supabase_migrations.schema_migrations (version, name)
  select version, name from jsonb_to_recordset(:'sm'::jsonb) as x(version text, name text)
  on conflict (version) do nothing;
do $$ begin raise warning '02: % rows in supabase_migrations.schema_migrations',
  (select count(*) from supabase_migrations.schema_migrations); end $$;
SQL
  else
    echo "02: catalog/schema_migrations.json missing, migration history not copied" >&2
  fi
  echo 'commit;'
} | q > /dev/null
EOS
)"
  pg17 <<< "$script"
  echo "02: pre done; next: 03-auth-storage.sql.mjs rows, then 02-restore.sh post"
  exit 0
fi

echo "02: post (one transaction)"
script="$prologue"$'\n'"$(cat <<'EOS'
toc --section=post-data
{
  echo 'begin;'
  cat <<'SQL'
\set counts `cat /dump/catalog/counts.json`
select set_config('selfbase.restore_counts', :'counts', true) \g /dev/null
-- 03 rows must have run: without the users the FKs to auth.users cannot be validated
do $$
declare r record; n bigint;
begin
  for r in select * from jsonb_to_recordset(current_setting('selfbase.restore_counts')::jsonb)
             as x(schema text, "table" text, rows bigint)
           where schema = 'auth' and "table" in ('users', 'identities') loop
    execute format('select count(*) from %I.%I', r.schema, r."table") into n;
    if n <> r.rows then
      raise exception '02 post: %.% has % rows, the source % — run 03-auth-storage.sql.mjs rows first',
        r.schema, r."table", n, r.rows;
    end if;
  end loop;
end $$;
SQL
  pg_restore -O -L /tmp/toc -f - /dump/schema-data.dump
  cat <<'SQL'
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
  if bad > 0 then raise exception '% of % tables differ from the source; post-data rolled back', bad, total; end if;
  raise warning 'row counts match the source for % tables', total;
end
$$;
SQL
  echo 'commit;'
} | q > /dev/null
EOS
)"
pg17 <<< "$script"
echo "02: post done; next: 03-auth-storage.sql.mjs policies"
