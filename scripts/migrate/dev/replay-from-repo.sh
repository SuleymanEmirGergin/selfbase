#!/usr/bin/env bash
# Replays a CorteQS checkout's schema (baseline dump + migrations/applied/*.sql in filename order)
# into a freshly bootstrapped selfbase database. Each file is its own psql invocation with
# ON_ERROR_STOP=1, so a failure names the file. The checkout is mounted read-only.
#
# Usage: TARGET_DB_URL=postgres://postgres:...@db:5432/postgres [DOCKER_NETWORK=sb-t10_default] \
#          scripts/migrate/dev/replay-from-repo.sh <corteqsemir path>
# REPLAY_CONTINUE=1 runs each migration in its own transaction and lists every failure instead of
# stopping at the first one (exit code stays non-zero if any failed).
# TARGET_DB_URL must be reachable from inside a container (compose service name with
# DOCKER_NETWORK, or host.docker.internal:<port>). It must connect as a superuser.
set -euo pipefail

repo="${1:?usage: replay-from-repo.sh <corteqsemir path>}"
: "${TARGET_DB_URL:?TARGET_DB_URL is not set}"
src="$(cd "$repo/supabase" && (pwd -W 2>/dev/null || pwd))"
net=()
[ -n "${DOCKER_NETWORK:-}" ] && net=(--network "$DOCKER_NETWORK")

# MSYS_NO_PATHCONV keeps Git Bash on Windows from rewriting the container paths.
MSYS_NO_PATHCONV=1 docker run --rm -i "${net[@]}" -e TARGET_DB_URL -e REPLAY_CONTINUE -e PGOPTIONS="-c client_min_messages=warning" -v "$src:/src:ro" postgres:17 bash -s <<'EOF'
set -euo pipefail
run() { psql "$TARGET_DB_URL" -X -q -v ON_ERROR_STOP=1 "$@"; }

# The baseline is a `pg_dump -n public` and starts with CREATE SCHEMA public, so the public schema
# initdb made has to go first. It may only hold extension members (vector, pg_trgm, postgis live
# in public, as on the source); anything else means the database is not fresh.
n=$(run -At -c "select count(*) from (
  select oid from pg_class where relnamespace = 'public'::regnamespace and relkind in ('r', 'p', 'v', 'm', 'S', 'f')
  union all select oid from pg_proc where pronamespace = 'public'::regnamespace
  union all select oid from pg_type where typnamespace = 'public'::regnamespace and typrelid = 0 and typcategory <> 'A'
) o where not exists (select 1 from pg_depend d where d.objid = o.oid and d.deptype = 'e')")
if [ "$n" != 0 ]; then
  echo "replay: public schema holds $n non-extension objects; use a fresh database" >&2
  exit 1
fi
# The dump does not create the extensions it uses (a schema-only dump never does), so they are
# put back into public as soon as the dump's CREATE SCHEMA public runs, then the trigger goes.
run <<'SQL'
create table selfbase.replay_public_ext as
  select extname from pg_extension where extnamespace = 'public'::regnamespace;
drop schema public cascade;
create function selfbase.replay_restore_ext() returns event_trigger language plpgsql as $f$
declare e text;
begin
  if exists (select 1 from pg_event_trigger_ddl_commands() where object_identity = 'public') then
    for e in select extname from selfbase.replay_public_ext loop
      execute format('create extension if not exists %I with schema public', e);
    end loop;
  end if;
end $f$;
create event trigger replay_restore_ext on ddl_command_end when tag in ('CREATE SCHEMA')
  execute function selfbase.replay_restore_ext();
SQL

start=$(date +%s)
baseline=$(ls /src/baseline/*.sql | sort | tail -n 1)
echo "replay: baseline $(basename "$baseline")"
run -f "$baseline" > /dev/null || { echo "replay: FAILED in baseline $(basename "$baseline")" >&2; exit 1; }
run -c 'drop event trigger replay_restore_ext' -c 'drop function selfbase.replay_restore_ext()' \
    -c 'drop table selfbase.replay_public_ext'

count=0
failed=0
for f in $(ls /src/migrations/applied/*.sql | sort); do
  if [ "${REPLAY_CONTINUE:-}" = 1 ]; then
    # Diagnostic mode: each file in one transaction (a failure leaves nothing behind), keep going.
    if ! run -1 -f "$f" > /dev/null 2> /tmp/err; then
      echo "replay: FAILED $(basename "$f"): $(grep -m1 ERROR /tmp/err | sed 's/^psql:[^ ]* //')" >&2
      failed=$((failed + 1))
      continue
    fi
  elif ! run -f "$f" > /dev/null; then
    echo "replay: FAILED in $(basename "$f") (after $count migrations)" >&2
    exit 1
  fi
  count=$((count + 1))
done
echo "replay: baseline + $count migrations applied, $failed failed, in $(( $(date +%s) - start ))s"
[ "$failed" = 0 ]
EOF
