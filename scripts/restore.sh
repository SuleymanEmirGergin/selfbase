#!/usr/bin/env bash
# Restores a backup made by backup.sh over the running stack. Run on the host:
#   scripts/restore.sh <YYYYMMDD-HHMMSS> --yes-overwrite
# Safe sequence:
#   1. prints what a restore does and does not do (below), then verifies the backup's MANIFEST (sizes and
#      sha256) inside the backup service; any mismatch, a missing file or an unknown timestamp is refused
#      before anything changes; says how many storage files added since the backup would be deleted
#   2. without --yes-overwrite it stops here
#   3. `docker compose stop core rest fn`, so nothing writes to the database or storage during the restore
#   4. cron: every active job is set inactive (committed) and running job sessions are terminated, so no
#      job runs during the restore; the restore brings back the backup's job states (on failure the
#      jobs set inactive here are set active again)
#   5. pg_restore --clean --if-exists --single-transaction: every object in the dump is dropped and
#      recreated in ONE transaction; a failure rolls back and the database stays as it was
#   6. the storage volume: the archive is extracted into a temp dir inside the volume, then swapped in
#   7. prints the command that starts the services again
# What it does NOT do: objects created after the backup are not removed; the migration ledger
# (selfbase.applied_migrations) goes back to the backup, so sync re-applies later migrations and fails
# on "already exists" until those objects are dropped or the files are marked with sync.mjs --mark-applied;
# a newer object that depends on a restored one makes the restore fail (and roll back). Roles are not
# restored: globals.sql in the backup holds them (without passwords) for a disaster restore onto a fresh
# volume (psql -f globals.sql before pg_restore), never needed on a running stack.
#
# More reliable alternative (nothing is overwritten): restore into a new database, check it, switch over.
#   docker compose run --rm --no-deps -T backup bash -c 'createdb restored &&
#     pg_restore -l /backups/<ts>/db.dump | grep -vE "pg_cron| cron " > /tmp/toc &&
#     pg_restore -L /tmp/toc -d restored --exit-on-error --single-transaction /backups/<ts>/db.dump'
#   (pg_cron can only live in the database named postgres, so it and its jobs are left out; recreate the
#   jobs with cron.schedule after the switch.) Check it: docker compose exec db psql -U postgres -d restored
#   Switch over: docker compose stop core rest fn backup; then docker compose exec -T db psql -U postgres -d template1 with
#     alter database postgres allow_connections false;
#     select pg_terminate_backend(pid) from pg_stat_activity where datname = 'postgres';
#     alter database postgres rename to postgres_before_restore;
#     alter database restored rename to postgres;
#     alter database postgres set search_path to "$user", public, extensions;  -- as db/bootstrap/01-extensions.sql
#   then docker compose restart db; docker compose exec db psql -U postgres -c 'create extension pg_cron';
#   recreate the jobs; restore storage (docker compose run --rm --no-deps -v <core's storage volume>:/s backup
#   tar -xzf /backups/<ts>/storage.tar.gz -C /s adds the backup's files back); docker compose up -d.
#   The old database stays as postgres_before_restore until you drop it.
#
# Uses plain `docker compose` from the repo root; for another stack set COMPOSE_PROJECT_NAME,
# COMPOSE_ENV_FILES (or COMPOSE_FILE) in the environment.
set -euo pipefail
FILES='db.dump globals.sql storage.tar.gz '

if [ "${1:-}" = --inside ]; then # runs in the backup container: --inside verify|apply <ts>
  step=$2 ts=$3 dir=/backups/$3
  [ -f "$dir/MANIFEST" ] || { echo "restore: there is no backup $ts" >&2; exit 1; }
  [ "$(cut -d' ' -f1 "$dir/MANIFEST" | sort | tr '\n' ' ')" = "$FILES" ] ||
    { echo "restore: the MANIFEST of $ts does not list exactly $FILES; refusing" >&2; exit 1; }
  while read -r f size sum; do
    if [ "$(stat -c %s "$dir/$f" 2>/dev/null)" != "$size" ] || [ "$(sha256sum < "$dir/$f" | cut -d' ' -f1)" != "$sum" ]; then
      echo "restore: $ts/$f does not match its MANIFEST (size or sha256); refusing" >&2
      exit 1
    fi
  done < "$dir/MANIFEST"
  echo "restore: $ts verified (globals.sql with the roles is there too; not applied, see the script header)"
  if [ "$step" = verify ]; then
    added=$(comm -13 <(tar -tzf "$dir/storage.tar.gz" | sed 's#^\./##; s#/$##' | sort) \
      <(cd /data/storage && find . -mindepth 1 -type f | sed 's#^\./##' | sort) | wc -l)
    echo "restore: $added storage files added since the backup would be deleted"
    exit 0
  fi

  q() { psql -XAtq -v ON_ERROR_STOP=1 "$@"; }
  jobs=$(q -c "select case when to_regclass('cron.job') is null then '' else (select coalesce(string_agg(jobid::text, ','), '')
    from (select jobid from cron.job where active) j) end")
  if [ -n "$jobs" ]; then
    q -c "update cron.job set active = false where jobid in ($jobs)"
    echo "restore: cron jobs $jobs set inactive for the restore"
  fi
  q -c "select pg_terminate_backend(pid) from pg_stat_activity
        where (application_name = 'pg_cron' or backend_type = 'pg_cron') and pid <> pg_backend_pid()" > /dev/null
  if ! pg_restore --clean --if-exists --single-transaction --exit-on-error -d "${PGDATABASE:-postgres}" "$dir/db.dump"; then
    [ -z "$jobs" ] || q -c "update cron.job set active = true where jobid in ($jobs)"
    echo "restore: FAILED: the database restore rolled back; the database and storage are unchanged" >&2
    exit 1
  fi
  echo "restore: database restored (cron jobs as in the backup)"
  t="/restore-storage/.restoring-$ts"
  trap 'rc=$?; rm -rf "$t"; [ $rc = 0 ] || { echo "restore: FAILED in the storage step: the DATABASE WAS RESTORED from $ts, storage may be partly replaced; run the restore again" >&2; exit 3; }' EXIT
  rm -rf "$t"
  mkdir "$t"
  tar -xzf "$dir/storage.tar.gz" -C "$t"
  find /restore-storage -mindepth 1 -maxdepth 1 ! -name ".restoring-$ts" -exec rm -rf {} +
  find "$t" -mindepth 1 -maxdepth 1 -exec mv -t /restore-storage {} +
  echo "restore: storage restored"
  exit 0
fi

ts=${1:-}
[[ $ts =~ ^[0-9]{8}-[0-9]{6}$ ]] || { echo "usage: restore.sh <YYYYMMDD-HHMMSS> --yes-overwrite" >&2; exit 2; }
cd "$(dirname "$0")/.."
export MSYS_NO_PATHCONV=1 # keeps Git Bash on Windows from rewriting the container paths
caveats="restore: a restore does NOT remove objects created after the backup; the migration ledger goes back to
  the backup, so sync will re-apply later migrations and fail on \"already exists\" until those objects are
  dropped or the files are marked with: node scripts/sync.mjs --repo <app repo> --mark-applied <file>;
  a newer object that depends on a restored one makes the restore fail and roll back; storage files added
  after the backup are deleted; cron jobs are paused during the restore and come back as in the backup.
  Nothing is overwritten with the new-database path described in the header of scripts/restore.sh."
echo "$caveats"
docker compose run --rm --no-deps -T backup bash /scripts/restore.sh --inside verify "$ts"
[ "${2:-}" = --yes-overwrite ] ||
  { echo "restore: this overwrites the database and the storage files; run again with --yes-overwrite" >&2; exit 2; }

core=$(docker compose ps -aq core)
[ -n "$core" ] || { echo "restore: no core container; start the stack once (docker compose up -d)" >&2; exit 1; }
vol=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/data/storage"}}{{.Name}}{{end}}{{end}}' "$core")
[ -n "$vol" ] || { echo "restore: cannot find core's storage volume" >&2; exit 1; }

echo "restore: stopping core rest fn"
docker compose stop core rest fn
rc=0
docker compose run --rm --no-deps -T -v "$vol:/restore-storage" backup bash /scripts/restore.sh --inside apply "$ts" || rc=$?
if [ "$rc" != 0 ]; then
  if [ "$rc" = 3 ]; then echo "restore: FAILED after the database was restored (storage step)" >&2
  else echo "restore: FAILED; the database was NOT restored (rolled back)" >&2; fi
  echo "restore: core rest fn are stopped: docker compose start rest core fn" >&2
  exit 1
fi
echo "$caveats"
echo "restore: done; start the services again: docker compose start rest core fn"
