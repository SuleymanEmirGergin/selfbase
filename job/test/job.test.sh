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
  docker volume rm -f "$P-backups" "$P-storage" "$P-v1-storage" "$P-empty-storage" "$P-big-storage" > /dev/null 2>&1 || true
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
# other credentials the backup carries: a pending link (one_time_tokens), and GoTrue tables a foreign dump may hold
# (PKCE flow state, MFA challenges, AMR claims, SAML relay states, OAuth authorization codes); a user and a factor stay
FOREIGN_CREDS='flow_state mfa_challenges mfa_amr_claims saml_relay_states oauth_authorizations'
sql db "insert into auth.users (id, email) values ('22222222-2222-2222-2222-222222222222', 'u@example.test');
  insert into auth.one_time_tokens (user_id, token_type, token_hash, relates_to)
    values ('22222222-2222-2222-2222-222222222222', 'recovery_token', 'restored-hash', 'u@example.test');
  create table auth.mfa_factors (id uuid primary key); insert into auth.mfa_factors values (gen_random_uuid());
  $(for t in $FOREIGN_CREDS; do echo "create table auth.$t (id uuid primary key); insert into auth.$t values (gen_random_uuid());"; done)" > /dev/null
creds() { sql db "select concat_ws(',', (select count(*) from auth.one_time_tokens)$(for t in $FOREIGN_CREDS; do echo ", (select count(*) from auth.$t)"; done))"; }
kept() { sql db "select (select count(*) from auth.users) || ',' || (select count(*) from auth.mfa_factors)"; }

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
# 64 MiB: room for the test database (I2 counts it against the floor)
small() { docker run --rm --network "$NET" -e PGHOST=db -e PGPASSWORD="$PW" -e BACKUP_SUBDIR=t -e "BACKUP_MIN_FREE_MIB=$1" \
  --mount type=tmpfs,destination=/backups,tmpfs-size=64m -v "$P-storage:/data/storage:ro" "$IMAGE" bash /scripts/backup.sh 2>&1; }
rc=0; out=$(small 1) || rc=$?
check 'R3: BACKUP_MIN_FREE_MIB=1 lets a backup run on a 64 MiB volume' [ "$rc" = 0 ]; [ "$rc" = 0 ] || echo "$out" >&2
rc=0; out=$(small 64) || rc=$?
check 'R3: BACKUP_MIN_FREE_MIB=64 refuses it, naming the setting' [ "$rc" = 4 ]
check 'R3: the refusal names BACKUP_MIN_FREE_MIB' grep -q 'at least 64 MiB (BACKUP_MIN_FREE_MIB) needed' <<< "$out"
rc=0; out=$(small 1x) || rc=$?
check 'R3: a BACKUP_MIN_FREE_MIB that is not a number is refused (exit 2)' [ "$rc" = 2 ]

# ---- I2: the job sizes the backup at its start, from the database and the storage files themselves ----
# a 256 MiB volume whose floor leaves 64 MiB of headroom for this database (and the small storage)
dbm=$(( $(sql db "select pg_database_size(current_database())") / 1048576 ))
floor=$((256 - dbm - 64))
sized() { docker run --rm --network "$NET" -e PGHOST=db -e PGPASSWORD="$PW" -e BACKUP_SUBDIR=t -e "BACKUP_MIN_FREE_MIB=$floor" \
  --mount type=tmpfs,destination=/backups,tmpfs-size=256m -v "$1:/data/storage:ro" "$IMAGE" \
  bash -c 'bash /scripts/backup.sh; rc=$?; echo "entries=$(ls -A /backups/t 2>/dev/null | wc -l)"; exit $rc' 2>&1; }
rc=0; out=$(sized "$P-storage") || rc=$?
check 'I2: with 64 MiB of headroom above the floor the backup runs' [ "$rc" = 0 ]; [ "$rc" = 0 ] || echo "$out" >&2
# 100 MiB of storage files whose rows say nothing, or a negative size: the job counts the files
sql db "insert into storage.buckets (id, name) values ('i2', 'i2');
  insert into storage.objects (bucket_id, name, metadata) values ('i2', 'big', '{\"size\": -1000000000000000}')" > /dev/null
docker volume create "$P-big-storage" > /dev/null
docker run --rm -v "$P-big-storage:/s" "$IMAGE" bash -c 'head -c 100M /dev/urandom > /s/big'
rc=0; out=$(sized "$P-big-storage") || rc=$?
check 'I2: storage files beyond the headroom are refused (exit 4) whatever the storage rows say' [ "$rc" = 4 ]
check 'I2: the refusal names the size it measured' grep -qE 'needed after this backup of up to 1[0-9]{2} MiB; free space first' <<< "$out"
check 'I2: nothing is written on that refused run' grep -qx 'entries=0' <<< "$out"
sql db "delete from storage.objects where bucket_id = 'i2'; delete from storage.buckets where id = 'i2'" > /dev/null
# a database that grew after control admitted the backup: refused when the job starts
sql db "create table public.grow (b text);
  insert into public.grow select string_agg(md5(random()::text), '') from generate_series(1, 98304) g, generate_series(1, 32) h group by g" > /dev/null
rc=0; out=$(sized "$P-storage") || rc=$?
check 'I2: a database grown beyond the headroom is refused (exit 4) at the job start' [ "$rc" = 4 ]
check 'I2: nothing is written on that refused run either' grep -qx 'entries=0' <<< "$out"
sql db "drop table public.grow" > /dev/null

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

# ---- I3: prune only, for an export whose project is gone: no network, no database, no storage mount ----
in_backups 'mkdir -p /backups/export-gone/20200101-000000 /backups/export-gone/20200102-000000
  mkdir -p "/backups/export-gone/$(date -u +%Y%m%d-%H%M%S)"'
prune() { docker run --rm --network none -v "$P-backups:/backups" -e "BACKUP_SUBDIR=$1" -e BACKUP_PRUNE_ONLY=1 \
  -e EXPORT_RETENTION_DAYS=7 "$IMAGE" bash /scripts/backup.sh 2>&1; }
rc=0; out=$(prune export-gone) || rc=$?
check 'I3: a prune-only run needs neither the database nor the storage files' [ "$rc" = 0 ]; [ "$rc" = 0 ] || echo "$out" >&2
check 'I3: it deletes the exports older than EXPORT_RETENTION_DAYS and reports each' [ "$(grep -cE '^backup: deleted export-gone/2020010[12]-000000 \(older than 7 days\)$' <<< "$out")" = 2 ]
check 'I3: it keeps a recent export and writes nothing' in_backups '[ "$(ls /backups/export-gone | wc -l)" = 1 ] && ! ls -a /backups/export-gone | grep -q "^.tmp-"'
check 'I3: it prints no wrote line' bash -c '! grep -q "backup: wrote" <<< "$1"' _ "$out"
rc=0; out=$(prune t) || rc=$?
check 'I3: prune-only takes export-<ref> directories only (exit 2)' [ "$rc" = 2 ]
check 'I3: and leaves a project backup directory untouched' in_backups "[ -f /backups/t/$ts/MANIFEST ]"

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
check "I1: a plain restore keeps the backup's other credentials" [ "$(creds)" = 1,1,1,1,1,1 ]

# ---- R3: GNU du exits 1 when a file vanishes mid-walk (core deleting objects); the size it printed still counts ----
JOB_ENV=(-e BACKUP_SUBDIR=duvanish)
rc=0; out=$(job db "$P-storage" bash -c 'du() { command du "$@"; return 1; }; export -f du; bash /scripts/backup.sh' 2>&1) || rc=$?
check 'R3: a du that exits 1 after printing a size does not fail the backup' [ "$rc" = 0 ]; [ "$rc" = 0 ] || echo "$out" >&2
JOB_ENV=(-e BACKUP_SUBDIR=dunone)
rc=0; out=$(job db "$P-storage" bash -c 'du() { return 1; }; export -f du; bash /scripts/backup.sh' 2>&1) || rc=$?
check 'R3: a du that prints no size fails the backup (exit 1)' [ "$rc" = 1 ]
check 'R3: and says the storage size could not be read' grep -q 'backup: the storage size could not be read' <<< "$out"
check 'R3: and writes nothing' in_backups '[ ! -d /backups/dunone ] || [ -z "$(ls -A /backups/dunone)" ]'

# ---- I1: ROTATE_KEYS=1 (an import with rotate_keys) deletes the restored sessions, before control starts core ----
JOB_ENV=(-e RESTORE_DIR=t/$ts -e ROTATE_KEYS=yes)
rc=0; out=$(job db "$P-storage" bash /scripts/restore.sh 2>&1) || rc=$?
check 'I1: a ROTATE_KEYS other than 0 or 1 is refused (exit 2)' [ "$rc" = 2 ]
check 'I1: the sessions are unchanged after that refusal' [ "$(sessions)" = 1,1 ]
JOB_ENV=(-e RESTORE_DIR=t/$ts -e ROTATE_KEYS=1)
rc=0; out=$(job db "$P-storage" bash /scripts/restore.sh 2>&1) || rc=$?
check 'I1: a rotating restore succeeds' [ "$rc" = 0 ]; [ "$rc" = 0 ] || echo "$out" >&2
check 'I1: a rotating restore leaves no refresh token and no session' [ "$(sessions)" = 0,0 ]
check 'R1: a rotating restore leaves no one-time token, flow state, MFA challenge, AMR claim, relay state or OAuth code' [ "$(creds)" = 0,0,0,0,0,0 ]
check 'R1: a rotating restore keeps the users and their MFA factors' [ "$(kept)" = 1,1 ]
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
# a delete the dump turns into a silent no-op (a row trigger returning NULL, a DO INSTEAD rule): counted, so exit 5
silent() { # <name> <create sql> <drop sql>; the rotating restore above emptied the tables: a row each to delete
  sql db "insert into auth.refresh_tokens (token, session_id) values ('$1-token', gen_random_uuid());
    insert into auth.one_time_tokens (user_id, token_type, token_hash, relates_to)
      values ('22222222-2222-2222-2222-222222222222', 'recovery_token', '$1-hash', 'u@example.test') on conflict do nothing; $2" > /dev/null
  JOB_ENV=(-e "BACKUP_SUBDIR=$1")
  local b; b=$(job db "$P-storage" bash /scripts/backup.sh | tail -n1)
  sql db "$3" > /dev/null
  JOB_ENV=(-e "RESTORE_DIR=${b#backup: wrote }" -e ROTATE_KEYS=1)
  rc=0; out=$(job db "$P-storage" bash /scripts/restore.sh 2>&1) || rc=$?
  sql db "$3" > /dev/null
}
silent nulltrig "create function public.skip_delete() returns trigger language plpgsql as \$\$ begin return null; end \$\$;
  create trigger skip_delete before delete on auth.refresh_tokens for each row execute function public.skip_delete()" \
  "drop trigger if exists skip_delete on auth.refresh_tokens; drop function if exists public.skip_delete()"
check 'R2: a delete a BEFORE DELETE trigger skips fails the restore with exit 5' [ "$rc" = 5 ]
check 'R2: and does not say the sessions are deleted' bash -c '! grep -q "sessions are deleted" <<< "$1"' _ "$out"
check 'R2: the count caught it (names auth.refresh_tokens)' grep -q 'auth.refresh_tokens still has rows after the delete' <<< "$out"
silent rule "create rule keep_links as on delete to auth.one_time_tokens do instead nothing" \
  "drop rule if exists keep_links on auth.one_time_tokens"
check 'R2: a delete a DO INSTEAD rule swallows fails the restore with exit 5' [ "$rc" = 5 ]
check 'R2: the count caught it (names auth.one_time_tokens)' grep -q 'auth.one_time_tokens still has rows after the delete' <<< "$out"
silent deferred "create function public.put_back() returns trigger language plpgsql as \$\$ begin insert into auth.refresh_tokens values (OLD.*); return null; end \$\$;
  create constraint trigger put_back after delete on auth.refresh_tokens deferrable initially deferred for each row execute function public.put_back()" \
  "drop trigger if exists put_back on auth.refresh_tokens; drop function if exists public.put_back()"
check 'FR2: a deferred constraint trigger that puts the rows back at commit fails the restore with exit 5' [ "$rc" = 5 ]
check 'FR2: and does not say the sessions are deleted' bash -c '! grep -q "sessions are deleted" <<< "$1"' _ "$out"
check 'FR2: the count after the commit caught it (names auth.refresh_tokens)' grep -q 'auth.refresh_tokens still has rows after the delete' <<< "$out"
# a foreign dump with neither table: nothing to delete, no error (into a database with pg_cron, as every project's is)
sql db-empty "create extension if not exists pg_cron" > /dev/null
JOB_ENV=(-e BACKUP_SUBDIR=empty)
last=$(job db-empty "$P-empty-storage" bash /scripts/backup.sh | tail -n1)
JOB_ENV=(-e "RESTORE_DIR=${last#backup: wrote }" -e ROTATE_KEYS=1)
rc=0; out=$(job db-empty "$P-empty-storage" bash /scripts/restore.sh 2>&1) || rc=$?
check 'I1: a rotating restore of a dump without auth tables succeeds' [ "$rc" = 0 ]; [ "$rc" = 0 ] || echo "$out" >&2
# the v1 dump below drops schema auth: a table it does not hold would block that
sql db "drop table auth.sessions, auth.mfa_factors, $(sed 's/\([a-z_]*\)/auth.\1/g; s/ /, /g' <<< "$FOREIGN_CREDS")" > /dev/null

# ---- a v1 database restores into a v2 database and is adopted by core ----
sql db-v1 "insert into auth.users (id, email) values ('11111111-1111-1111-1111-111111111111', 'v1@example.test')" > /dev/null
JOB_ENV=(-e BACKUP_SUBDIR=v1)
last=$(job db-v1 "$P-v1-storage" bash /scripts/backup.sh | tail -n1)
v1ts=${last#backup: wrote v1/}
# the drop area for v1 dumps: import/<org slug>/<name>
in_backups "mkdir -p /backups/import/acme && mv /backups/v1/$v1ts /backups/import/acme/v1-dump"
# the hold schema cannot be dropped: the restore still succeeds and the old ledger is never moved back over it
sql db "create function public.block_hold_drop() returns event_trigger language plpgsql as \$\$ begin
  if current_query() ilike '%selfbase_restore_hold%cascade%' then raise exception 'blocked by the test'; end if; end \$\$;
  create event trigger block_hold_drop on ddl_command_start execute function public.block_hold_drop()" > /dev/null
JOB_ENV=(-e RESTORE_DIR=import/acme/v1-dump)
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
