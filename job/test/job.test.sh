#!/usr/bin/env bash
# Backup and restore in real containers: template/compose.test.yml's db and db-v1 plus the job image, run the way
# the provisioner runs a job (backups at /backups, the project's storage volume at /data/storage, PG* env).
#   bash job/test/job.test.sh
# Uses compose project sb-job-test (override with JOB_TEST_PROJECT) and removes everything it created at the end.
# "core starts" is core's own applyMigrations (core/src/platform/migrate.ts, as core/src/server.ts calls it).
set -euo pipefail
cd "$(dirname "$0")/../.."
export MSYS_NO_PATHCONV=1 # keeps Git Bash on Windows from rewriting the container paths
P=${JOB_TEST_PROJECT:-sb-job-test}
IMAGE=selfbase-job:test
PW=test-postgres-password
export TEST_DB_PORT=${JOB_TEST_DB_PORT:-54381} TEST_DB_V1_PORT=${JOB_TEST_DB_V1_PORT:-54382}
export TEST_DB_EMPTY_PORT=${JOB_TEST_DB_EMPTY_PORT:-54383} TEST_REST_PORT=${JOB_TEST_REST_PORT:-54384}
NET=${P}_default
compose() { docker compose -p "$P" -f template/compose.test.yml "$@"; }
cleanup() {
  compose down -v --remove-orphans > /dev/null 2>&1 || true
  docker volume rm -f "$P-backups" "$P-storage" "$P-v1-storage" "$P-empty-storage" > /dev/null 2>&1 || true
}
trap cleanup EXIT
fails=0
ok() { echo "ok - $1"; }
not_ok() { echo "not ok - $1" >&2; fails=$((fails + 1)); }
check() { local name=$1; shift; if "$@"; then ok "$name"; else not_ok "$name"; fi; }

# job <db service> <storage volume or -> <command...>: a job container on the stack's network
job() {
  local host=$1 vol=$2; shift 2
  local mounts=(-v "$P-backups:/backups")
  [ "$vol" = - ] || mounts+=(-v "$vol:/data/storage")
  docker run --rm --network "$NET" -e PGHOST="$host" -e PGPASSWORD="$PW" "${mounts[@]}" "${JOB_ENV[@]}" "$IMAGE" "$@"
}
sql() { docker compose -p "$P" -f template/compose.test.yml exec -T "$1" psql -XAtq -U postgres -v ON_ERROR_STOP=1 -c "$2"; }
in_backups() { docker run --rm -v "$P-backups:/backups" "$IMAGE" bash -c "$1"; }
migrate() { # core's start: platform migrations, adopting a v1 database
  node --input-type=module -e "
    import pg from 'pg'
    import { applyMigrations } from './core/src/platform/migrate.ts'
    const pool = new pg.Pool({ host: 'localhost', port: $TEST_DB_PORT, user: 'postgres', password: '$PW', database: 'postgres' })
    console.log('migrated', (await applyMigrations(pool, { dir: 'db/platform', ledger: 'selfbase.platform_migrations', lockKey: 7213014, adoptV1: true })).join(','))
    await pool.end()"
}
ledger() { sql db "select coalesce(string_agg(version, ',' order by version), '') from selfbase.platform_migrations"; }
current=$(ls db/platform | grep -E '^[0-9]{4}-' | cut -c1-4 | paste -sd, -)

echo "# building $IMAGE and starting $P"
docker build -q -f job/Dockerfile -t "$IMAGE" . > /dev/null
cleanup
compose up -d --build --wait db db-v1 db-empty > /dev/null 2>&1
migrate > /dev/null
docker volume create "$P-storage" > /dev/null
docker volume create "$P-v1-storage" > /dev/null
docker volume create "$P-empty-storage" > /dev/null
docker run --rm -v "$P-storage:/s" "$IMAGE" bash -c 'mkdir -p /s/stub/b && echo v2-file > /s/stub/b/v2.txt'
docker run --rm -v "$P-v1-storage:/s" "$IMAGE" bash -c 'mkdir -p /s/stub/avatars && echo v1-file > /s/stub/avatars/me.png'
sql db "create table public.marker (v text); insert into public.marker values ('in-backup')" > /dev/null
sql db "insert into selfbase.mail_log (to_email, subject, html) values ('a@example.test', 'link', 'secret-link')" > /dev/null
# a session the backup carries (refresh token rows; auth.sessions as a foreign dump may have it)
sql db "insert into auth.refresh_tokens (token, session_id) values ('restored-token', gen_random_uuid());
  create table auth.sessions (id uuid primary key); insert into auth.sessions values (gen_random_uuid())" > /dev/null
sessions() { sql db "select (select count(*) from auth.refresh_tokens) || ',' || (select count(*) from auth.sessions)"; }

# ---- backup of a v2 database ----
JOB_ENV=(-e BACKUP_SUBDIR=t)
out=$(job db "$P-storage" bash /scripts/backup.sh)
last=$(tail -n1 <<< "$out")
ts=${last#backup: wrote t/}
check "backup's last line names <subdir>/<ts>" grep -qE '^backup: wrote t/[0-9]{8}-[0-9]{6}$' <<< "$last"
check 'MANIFEST lists db.dump, globals.sql, storage.tar.gz and matches each file' in_backups "
  cd /backups/t/$ts && [ \"\$(cut -d' ' -f1 MANIFEST | sort | tr '\n' ' ')\" = 'db.dump globals.sql storage.tar.gz ' ] &&
  while read -r f size sum; do [ \"\$(stat -c %s \$f)\" = \$size ] && [ \"\$(sha256sum < \$f | cut -d' ' -f1)\" = \$sum ] || exit 1; done < MANIFEST"
check 'no temp directory is left' in_backups "! ls -a /backups/t | grep -q '^.tmp-'"

# ---- retention: an old backup goes, an old export too (EXPORT_RETENTION_DAYS) ----
in_backups 'mkdir -p /backups/t/20200101-000000 /backups/export-t/20200101-000000'
JOB_ENV=(-e BACKUP_SUBDIR=t)
job db "$P-storage" bash /scripts/backup.sh > /dev/null
check 'retention deletes an old backup' in_backups '[ ! -e /backups/t/20200101-000000 ]'

# ---- R3: at most BACKUP_MAX_COUNT backups per subdirectory, the new one always among them ----
newest=$(in_backups 'for h in 3 2 1; do d=$(date -u -d "-$h hour" +%Y%m%d-%H%M%S); mkdir -p /backups/cnt/$d; done; echo $d')
JOB_ENV=(-e BACKUP_SUBDIR=cnt -e BACKUP_MAX_COUNT=2)
out=$(job db "$P-storage" bash /scripts/backup.sh)
cnts=${out##*backup: wrote cnt/}
check 'R3: BACKUP_MAX_COUNT=2 keeps the new backup and the newest one before it' in_backups "
  [ \"\$(ls /backups/cnt | wc -l)\" = 2 ] && [ -f /backups/cnt/$cnts/MANIFEST ] && [ -d /backups/cnt/$newest ]"
check 'R3: each count-pruned backup is reported' [ "$(grep -c '(beyond the newest 2)$' <<< "$out")" = 2 ]

# ---- R3: a backup volume short of 10% / 5 GiB free is refused before anything is written ----
rc=0; out=$(docker run --rm --network "$NET" -e PGHOST=db -e PGPASSWORD="$PW" -e BACKUP_SUBDIR=t \
  --mount type=tmpfs,destination=/backups,tmpfs-size=16m -v "$P-storage:/data/storage:ro" "$IMAGE" \
  bash -c 'bash /scripts/backup.sh; rc=$?; echo "entries=$(ls -A /backups/t | wc -l)"; exit $rc' 2>&1) || rc=$?
check 'R3: a nearly full backup volume is refused (exit 4)' [ "$rc" = 4 ]
check 'R3: the refusal says how much is free and needed' grep -q 'backup: REFUSED: .* MiB free on the backup volume, at least 5120 MiB' <<< "$out"
check 'R3: nothing is written on a refused run' grep -qx 'entries=0' <<< "$out"
# the provisioner's node floor (BACKUP_MIN_FREE_MIB) replaces the default, e.g. on a small test disk
small() { docker run --rm --network "$NET" -e PGHOST=db -e PGPASSWORD="$PW" -e BACKUP_SUBDIR=t -e "BACKUP_MIN_FREE_MIB=$1" \
  --mount type=tmpfs,destination=/backups,tmpfs-size=16m -v "$P-storage:/data/storage:ro" "$IMAGE" bash /scripts/backup.sh 2>&1; }
rc=0; out=$(small 1) || rc=$?
check 'R3: BACKUP_MIN_FREE_MIB=1 lets a backup run on a 16 MiB volume' [ "$rc" = 0 ]; [ "$rc" = 0 ] || echo "$out" >&2
rc=0; out=$(small 64) || rc=$?
check 'R3: BACKUP_MIN_FREE_MIB=64 refuses it, naming the setting' [ "$rc" = 4 ]
check 'R3: the refusal names BACKUP_MIN_FREE_MIB' grep -q 'at least 64 MiB (BACKUP_MIN_FREE_MIB) needed' <<< "$out"
rc=0; out=$(small 1x) || rc=$?
check 'R3: a BACKUP_MIN_FREE_MIB that is not a number is refused (exit 2)' [ "$rc" = 2 ]

# ---- with MANIFEST_B64: project.json is written and listed ----
JOB_ENV=(-e BACKUP_SUBDIR=export-t -e CONTROL_GID=1234 -e "MANIFEST_B64=$(printf '{"v":1}' | base64 | tr -d '\n')")
last=$(job db "$P-storage" bash /scripts/backup.sh | tail -n1)
check 'R3: retention prunes an export older than EXPORT_RETENTION_DAYS' in_backups '[ ! -e /backups/export-t/20200101-000000 ]'
ets=${last#backup: wrote export-t/}
check 'an export writes project.json and lists it in MANIFEST' in_backups "
  cd /backups/export-t/$ets && [ \"\$(cat project.json)\" = '{\"v\":1}' ] && grep -q '^project.json ' MANIFEST"
# control (CONTROL_GID's group, read-only mount) reads an export's project.json for an import; nobody else does, and
# the dump stays owner-only
check 'an export is 0750/0640 with group CONTROL_GID' in_backups "
  [ \"\$(stat -c '%a %g' /backups/export-t /backups/export-t/$ets /backups/export-t/$ets/project.json | tr '\n' ' ')\" = '750 1234 750 1234 640 1234 ' ]"
check 'control can read project.json but not the dump' docker run --rm --user 1000:1234 -v "$P-backups:/backups:ro" "$IMAGE" bash -c "
  cat /backups/export-t/$ets/project.json > /dev/null && ! cat /backups/export-t/$ets/db.dump > /dev/null 2>&1"
check 'another uid cannot read project.json' docker run --rm --user 1001:1001 -v "$P-backups:/backups:ro" "$IMAGE" bash -c "
  ! cat /backups/export-t/$ets/project.json > /dev/null 2>&1"

# ---- the control database: no storage mount, no storage archive ----
JOB_ENV=(-e BACKUP_SUBDIR=control)
last=$(job db - bash /scripts/backup.sh | tail -n1)
cts=${last#backup: wrote control/}
check 'a control backup has no storage archive' in_backups "
  cd /backups/control/$cts && [ \"\$(cut -d' ' -f1 MANIFEST | sort | tr '\n' ' ')\" = 'db.dump globals.sql ' ]"

sql db "update public.marker set v = 'after-backup'" > /dev/null

# ---- a corrupted backup is refused before anything changes ----
in_backups "cp -a /backups/t/$ts /backups/t/corrupt && cd /backups/t/corrupt &&
  printf 'X' | dd of=db.dump bs=1 seek=100 count=1 conv=notrunc status=none"
JOB_ENV=(-e RESTORE_DIR=t/corrupt)
rc=0; out=$(job db "$P-storage" bash /scripts/restore.sh 2>&1) || rc=$?
check 'a corrupted backup is refused' [ "$rc" != 0 ]
check 'the refusal names the MANIFEST' grep -q 'does not match its MANIFEST' <<< "$out"
check 'the database is unchanged after the refusal' [ "$(sql db 'select v from public.marker')" = after-backup ]

# ---- R4: a storage archive with a link or a path out of the volume is refused, even with a matching MANIFEST ----
# evil-link: ./stub/link -> /etc (a later entry stub/link/x would write through it); evil-dotdot: ../outside
in_backups "set -e; for k in link dotdot; do cp -a /backups/t/$ts /backups/t/evil-\$k; done
  w=\$(mktemp -d); mkdir -p \$w/s/stub \$w/d/sub; ln -s /etc \$w/s/stub/link; echo x > \$w/d/outside
  tar -czf /backups/t/evil-link/storage.tar.gz -C \$w/s .
  (cd \$w/d/sub && tar -czPf /backups/t/evil-dotdot/storage.tar.gz ../outside)
  for k in link dotdot; do cd /backups/t/evil-\$k
    sed -i \"s|^storage.tar.gz .*|storage.tar.gz \$(stat -c %s storage.tar.gz) \$(sha256sum < storage.tar.gz | cut -d' ' -f1)|\" MANIFEST; done"
for k in link dotdot; do
  JOB_ENV=(-e RESTORE_DIR=t/evil-$k)
  rc=0; out=$(job db "$P-storage" bash /scripts/restore.sh 2>&1) || rc=$?
  check "R4: an archive with a $k entry is refused before anything changes" [ "$rc" = 1 ]
  check "R4: the $k refusal names the archive" grep -q 'storage.tar.gz holds an\? \(link\|absolute or \.\. path\)' <<< "$out"
  check "R4: the database is unchanged after the $k refusal" [ "$(sql db 'select v from public.marker')" = after-backup ]
done
check 'R4: storage is untouched by the refusals' docker run --rm -v "$P-storage:/s" "$IMAGE" bash -c \
  '[ "$(cat /s/stub/b/v2.txt)" = v2-file ] && [ ! -e /s/stub/link ] && [ ! -e /s/outside ]'

# ---- a v2 dump restores and keeps its ledger ----
# core (uid 1000 here) owns the volume: what is restored is its, not the archive's owner (root wrote the fixture)
docker run --rm -v "$P-storage:/s" "$IMAGE" bash -c 'echo later > /s/stub/b/later.txt && chown 1000:1000 /s'
JOB_ENV=(-e RESTORE_DIR=t/$ts)
rc=0; out=$(job db "$P-storage" bash /scripts/restore.sh 2>&1) || rc=$?
check 'a v2 backup restores' [ "$rc" = 0 ]
check 'the restored database is the backup' [ "$(sql db 'select v from public.marker')" = in-backup ]
check 'a v2 dump keeps its ledger' [ "$(ledger)" = "$current" ]
check 'mail_log rows (links in clear) are not in the backup' [ "$(sql db 'select count(*) from selfbase.mail_log')" = 0 ]
check 'storage is the backup' docker run --rm -v "$P-storage:/s" "$IMAGE" bash -c \
  '[ "$(cat /s/stub/b/v2.txt)" = v2-file ] && [ ! -e /s/stub/b/later.txt ] && ! ls -a /s | grep -q "^.restoring"'
check 'R4: restored storage belongs to the volume owner, not the archive owner' docker run --rm -v "$P-storage:/s" "$IMAGE" bash -c \
  '[ "$(stat -c %u:%g /s/stub /s/stub/b/v2.txt | sort -u)" = 1000:1000 ]'
check "I1: a plain restore keeps the backup's sessions" [ "$(sessions)" = 1,1 ]

# ---- I1: ROTATE_KEYS=1 (an import with rotate_keys) deletes the restored sessions, before control starts core ----
JOB_ENV=(-e RESTORE_DIR=t/$ts -e ROTATE_KEYS=yes)
rc=0; out=$(job db "$P-storage" bash /scripts/restore.sh 2>&1) || rc=$?
check 'I1: a ROTATE_KEYS other than 0 or 1 is refused (exit 2)' [ "$rc" = 2 ]
check 'I1: the sessions are unchanged after that refusal' [ "$(sessions)" = 1,1 ]
JOB_ENV=(-e RESTORE_DIR=t/$ts -e ROTATE_KEYS=1)
rc=0; out=$(job db "$P-storage" bash /scripts/restore.sh 2>&1) || rc=$?
check 'I1: a rotating restore succeeds' [ "$rc" = 0 ]; [ "$rc" = 0 ] || echo "$out" >&2
check 'I1: a rotating restore leaves no refresh token and no session' [ "$(sessions)" = 0,0 ]
check 'I1: a rotating restore says so' grep -qx 'restore: the restored sessions are deleted (ROTATE_KEYS)' <<< "$out"
check 'I1: the rest of the database is the backup' [ "$(sql db 'select v from public.marker')" = in-backup ]
# a delete that fails (a trigger the backup carries): the job fails with exit 5, never as a success
sql db "create function public.keep_tokens() returns trigger language plpgsql as \$\$ begin raise exception 'kept'; end \$\$;
  create trigger keep_tokens before delete on auth.refresh_tokens execute function public.keep_tokens()" > /dev/null
JOB_ENV=(-e BACKUP_SUBDIR=kept)
kept=$(job db "$P-storage" bash /scripts/backup.sh | tail -n1)
JOB_ENV=(-e "RESTORE_DIR=${kept#backup: wrote }" -e ROTATE_KEYS=1)
rc=0; out=$(job db "$P-storage" bash /scripts/restore.sh 2>&1) || rc=$?
check 'I1: sessions that cannot be deleted fail the restore with exit 5' [ "$rc" = 5 ]
check 'I1: that failure says the database was restored and to import again' grep -q 'DATABASE WAS RESTORED .* sessions could not be deleted .*delete this project, then import again' <<< "$out"
sql db "drop trigger keep_tokens on auth.refresh_tokens; drop function public.keep_tokens()" > /dev/null
# a foreign dump with neither table: nothing to delete, no error (into a database with pg_cron, as every project's is)
sql db-empty "create extension if not exists pg_cron" > /dev/null
JOB_ENV=(-e BACKUP_SUBDIR=empty)
last=$(job db-empty "$P-empty-storage" bash /scripts/backup.sh | tail -n1)
JOB_ENV=(-e "RESTORE_DIR=${last#backup: wrote }" -e ROTATE_KEYS=1)
rc=0; out=$(job db-empty "$P-empty-storage" bash /scripts/restore.sh 2>&1) || rc=$?
check 'I1: a rotating restore of a dump without auth tables succeeds' [ "$rc" = 0 ]; [ "$rc" = 0 ] || echo "$out" >&2
# the v1 dump below drops schema auth: a table it does not hold would block that
sql db "drop table auth.sessions" > /dev/null

# ---- a v1 database restores into a v2 database and is adopted by core ----
sql db-v1 "insert into auth.users (id, email) values ('11111111-1111-1111-1111-111111111111', 'v1@example.test')" > /dev/null
JOB_ENV=(-e BACKUP_SUBDIR=v1)
last=$(job db-v1 "$P-v1-storage" bash /scripts/backup.sh | tail -n1)
v1ts=${last#backup: wrote v1/}
# the drop area for v1 dumps: import/<org slug>/<name>
in_backups "mkdir -p /backups/import/acme && mv /backups/v1/$v1ts /backups/import/acme/corteqs-v1"
# the hold schema cannot be dropped: the restore still succeeds and the old ledger is never moved back over it
sql db "create function public.block_hold_drop() returns event_trigger language plpgsql as \$\$ begin
  if current_query() ilike '%selfbase_restore_hold%cascade%' then raise exception 'blocked by the test'; end if; end \$\$;
  create event trigger block_hold_drop on ddl_command_start execute function public.block_hold_drop()" > /dev/null
JOB_ENV=(-e RESTORE_DIR=import/acme/corteqs-v1)
rc=0; out=$(job db "$P-storage" bash /scripts/restore.sh 2>&1) || rc=$?
check 'a v1 backup restores into a migrated database' [ "$rc" = 0 ]; [ "$rc" = 0 ] || echo "$out" >&2
check 'the ledger is gone from selfbase after a v1 restore' [ "$(sql db "select to_regclass('selfbase.platform_migrations') is null")" = t ]
check 'a hold that cannot be dropped is a warning naming it' grep -q 'left in schema selfbase_restore_hold' <<< "$out"
sql db "drop event trigger block_hold_drop; drop function public.block_hold_drop(); drop schema selfbase_restore_hold cascade" > /dev/null
migrate > /dev/null
check 'after core starts the ledger holds 0001...current' [ "$(ledger)" = "$current" ]
check 'the v1 user row is there' [ "$(sql db "select email from auth.users where id = '11111111-1111-1111-1111-111111111111'")" = v1@example.test ]
check 'the v1 storage file is there' docker run --rm -v "$P-storage:/s" "$IMAGE" bash -c \
  '[ "$(cat /s/stub/avatars/me.png)" = v1-file ] && [ ! -e /s/stub/b/v2.txt ]'

if [ "$fails" = 0 ]; then echo "# all passed"; else echo "# $fails failed" >&2; exit 1; fi
