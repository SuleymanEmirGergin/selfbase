#!/usr/bin/env bash
# Backup and restore in real containers: template/compose.test.yml's db and db-v1 plus the job image, run the way
# the provisioner runs a job (backups at /backups, the project's storage volume at /data/storage, PG* env).
#   bash job/test/job.test.sh
# Uses compose project sb-job-test (override with JOB_TEST_PROJECT) and image selfbase-job:test (JOB_TEST_IMAGE), and
# removes everything it created at the end.
# "core starts" is core's own applyMigrations (core/src/platform/migrate.ts, as core/src/server.ts calls it).
set -euo pipefail
cd "$(dirname "$0")/../.."
export MSYS_NO_PATHCONV=1 # keeps Git Bash on Windows from rewriting the container paths
P=${JOB_TEST_PROJECT:-sb-job-test}
IMAGE=${JOB_TEST_IMAGE:-selfbase-job:test} # parallel checkouts: a tag of their own
PW=test-postgres-password
export TEST_DB_PORT=${JOB_TEST_DB_PORT:-54381} TEST_DB_V1_PORT=${JOB_TEST_DB_V1_PORT:-54382}
export TEST_DB_EMPTY_PORT=${JOB_TEST_DB_EMPTY_PORT:-54383} TEST_REST_PORT=${JOB_TEST_REST_PORT:-54384}
NET=${P}_default
compose() { docker compose -p "$P" -f template/compose.test.yml "$@"; }
cleanup() {
  docker rm -f "$P-dbsmall" > /dev/null 2>&1 || true
  compose down -v --remove-orphans > /dev/null 2>&1 || true
  docker volume rm -f "$P-backups" "$P-storage" "$P-v1-storage" "$P-empty-storage" "$P-big-storage" "$P-small" > /dev/null 2>&1 || true
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

# M2: a signal runs the EXIT trap inside whatever function was running, so a local there of a name the trap reads
# hides the global (a local t in at_floor made the cleanup remove a number, not the temp dir). shadows <script>
# <globals...>: the names among them that some function of job/<script> declares local
shadows() {
  local f=$1; shift
  { sed -nE 's/^[[:space:]]*local[[:space:]]+//p' "job/$f" | tr ' ' '\n' | sed -E 's/=.*//' | grep -xF -f <(printf '%s\n' "$@") || true; } |
    sort -u | tr '\n' ' '
}
s=$(shadows restore.sh t w wstop wrc jobs db_done held swapped contained rel HOLD storage need rule PGOPTIONS \
  started deadline spent)
check 'M2: no function of restore.sh shadows a global its cleanup reads' [ -z "$s" ]; [ -z "$s" ] || echo "shadowed: $s" >&2
# 1: a writer reaped with status 0 had committed: reap records that before it clears w, or a signal between the two
# finds neither (the window is a few builtins wide, too narrow to hit from a test: the order is checked here)
first=$(sed -n '/^reap() {/,/^}/p' job/restore.sh | grep -v '^[[:space:]]*#' | grep -oE "committed|^  w=''" | head -n1)
check '1: reap records the commit before it clears the writer' [ "$first" = committed ]
s=$(shadows backup.sh rc w tmp sub ts)
check 'M2: no function of backup.sh shadows a global its trap reads' [ -z "$s" ]; [ -z "$s" ] || echo "shadowed: $s" >&2

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
# sized <storage volume> [floor MiB] [shell prefix, e.g. a function standing in for psql]
sized() { docker run --rm --network "$NET" -e PGHOST=db -e PGPASSWORD="$PW" -e BACKUP_SUBDIR=t -e "BACKUP_MIN_FREE_MIB=${2:-$floor}" \
  --mount type=tmpfs,destination=/backups,tmpfs-size=256m -v "$1:/data/storage:ro" "$IMAGE" \
  bash -c "${3:-}"' bash /scripts/backup.sh; rc=$?; echo "entries=$(ls -A /backups/t 2>/dev/null | wc -l)"
    echo "writers=$(pgrep -cx pg_dump)"; exit $rc' 2>&1; }
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
# D: the writers run under ulimit -f, set to the room above the floor: a size the job was told wrong (a superuser can
# replace any SQL it asks) still cannot push the volume through the floor. The room is the database's size plus
# 16 MiB: the dump fits, the 100 MiB of storage files do not; a stand-in du reports them as nothing
rc=0; out=$(sized "$P-big-storage" $((256 - dbm - 16)) 'du() { echo 0; }; export -f du;') || rc=$?
check 'D: a storage archive that outgrows the room above the floor stops at it (exit 4)' [ "$rc" = 4 ]
check 'D: and leaves neither a backup nor a temp directory' grep -qx 'entries=0' <<< "$out"
# globals.sql: roles and their settings live in shared catalogs no database size counts; the cap bounds them
# (64 MiB of role setting, more than that room)
sql db "create role d_big; do \$\$ begin execute format('alter role d_big set d.big = %L', repeat('x', 64 * 1048576)); end \$\$" > /dev/null
rc=0; out=$(sized "$P-storage" $((256 - dbm - 16))) || rc=$?
check 'D: a globals.sql that outgrows the room above the floor stops at it (exit 4)' [ "$rc" = 4 ]
check 'D: and leaves neither a backup nor a temp directory either' grep -qx 'entries=0' <<< "$out"
sql db "drop role d_big" > /dev/null
# D: the watchdog. Another writer fills the backup volume while the dump runs (a stand-in pg_dump waits 8 s first): the
# file cap set when the dump started still allows it, the watchdog stops it at the floor (exit 4)
slow='mkdir -p /tmp/w; printf "#!/bin/sh\nsleep 8\nexec %s \"\$@\"\n" "$(command -v pg_dump)" > /tmp/w/pg_dump; chmod +x /tmp/w/pg_dump;
  export PATH=/tmp/w:$PATH; (sleep 3; head -c 120M /dev/zero > /backups/filler) &'
rc=0; out=$(sized "$P-storage" '' "$slow") || rc=$?
check 'D: a dump running while the volume fills past the floor is stopped there (exit 4)' [ "$rc" = 4 ]; [ "$rc" = 4 ] || echo "$out" >&2
check 'D: the stop says the floor was reached' grep -q 'backup: REFUSED: the backup volume reached the floor' <<< "$out"
check 'D: and leaves neither a backup nor a temp directory (watchdog)' grep -qx 'entries=0' <<< "$out"
# a backup ended by SIGTERM (a stopped job container) stops its writer, then removes its temp dir: a stand-in
# pg_dump that never ends, the backup signalled after 3 s
stuck='mkdir -p /tmp/w; printf "#!/bin/bash\nwhile :; do sleep 0.2; done\n" > /tmp/w/pg_dump; chmod +x /tmp/w/pg_dump;
  export PATH=/tmp/w:$PATH; (sleep 3; pkill -TERM -f "^bash /scripts/backup.sh") &'
rc=0; out=$(sized "$P-storage" '' "$stuck") || rc=$?
check 'D: a backup stopped by SIGTERM exits 143' [ "$rc" = 143 ]; [ "$rc" = 143 ] || echo "$out" >&2
check 'D: its writer is stopped with it' grep -qx 'writers=0' <<< "$out"
check 'D: and it leaves no temp directory' grep -qx 'entries=0' <<< "$out"
# a database that grew after control admitted the backup: refused when the job starts
sql db "create table public.grow (b text);
  insert into public.grow select string_agg(md5(random()::text), '') from generate_series(1, 98304) g, generate_series(1, 32) h group by g" > /dev/null
rc=0; out=$(sized "$P-storage") || rc=$?
check 'I2: a database grown beyond the headroom is refused (exit 4) at the job start' [ "$rc" = 4 ]
check 'I2: nothing is written on that refused run either' grep -qx 'entries=0' <<< "$out"
# D: a superuser's public.pg_database_size (0) found first through a search_path set on the role and on the database
sql db "create function public.pg_database_size(name) returns bigint language sql as 'select 0::bigint';
  alter role postgres set search_path = public, pg_catalog; alter database postgres set search_path = public, pg_catalog" > /dev/null
rc=0; out=$(sized "$P-storage") || rc=$?
check 'D: a shadowed pg_database_size does not hide the grown database (exit 4)' [ "$rc" = 4 ]
check 'D: nothing is written on the shadowed run' grep -qx 'entries=0' <<< "$out"
sql db "alter role postgres reset search_path; alter database postgres reset search_path; drop function public.pg_database_size(name)" > /dev/null
# a size the job is told wrong (here a stand-in psql): the dump stops at the room above the floor, by signal or EFBIG
for how in SIGXFSZ EFBIG; do
  [ "$how" = SIGXFSZ ] && pre='' || pre="trap '' XFSZ;"
  rc=0; out=$(sized "$P-storage" $((256 - 16)) "$pre psql() { echo 0; }; export -f psql;") || rc=$?
  check "D: a dump that outgrows the room above the floor stops at it ($how, exit 4)" [ "$rc" = 4 ]
  check "D: and leaves neither a backup nor a temp directory ($how)" grep -qx 'entries=0' <<< "$out"
done
# an answer of more than 18 digits would overflow the shell's arithmetic: a failure, never a pass
JOB_ENV=(-e BACKUP_SUBDIR=d25)
rc=0; out=$(job db "$P-storage" bash -c 'psql() { echo 1234567890123456789012345; }; export -f psql; bash /scripts/backup.sh' 2>&1) || rc=$?
check 'D: a 25-digit size answer fails the backup (exit 1)' [ "$rc" = 1 ]
check 'D: and says the database size could not be read' grep -q 'backup: the database size could not be read' <<< "$out"
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
  '[ "$(cat /s/stub/b/v2.txt)" = v2-file ] && [ ! -e /s/stub/b/later.txt ] && ! ls -A /s | grep -q "restoring-"'
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
# M-3: once the backup is renamed into place it exists: a retention that fails (a stand-in rm refuses the old backup)
# or a size that cannot be read (a stand-in du) is a warning, and the wrote line control records it by still comes
in_backups 'mkdir -p /backups/postmv/20200101-000000'
JOB_ENV=(-e BACKUP_SUBDIR=postmv)
rc=0; out=$(job db "$P-storage" bash -c 'rm() { case "$*" in *20200101-000000*) echo "rm: refused by the test" >&2; return 1 ;; esac
  command rm "$@"; }; export -f rm; bash /scripts/backup.sh' 2>&1) || rc=$?
pts=$(tail -n1 <<< "$out"); pts=${pts#backup: wrote postmv/}
check 'M-3: a retention that fails after the rename keeps exit 0' [ "$rc" = 0 ]; [ "$rc" = 0 ] || echo "$out" >&2
check 'M-3: its last line is still the wrote line, of a whole backup' in_backups "[[ $pts =~ ^[0-9]{8}-[0-9]{6}\$ ]] && [ -f /backups/postmv/$pts/MANIFEST ]"
check 'M-3: it warns, never says no backup was written or that the old one was deleted' bash -c \
  'grep -q "backup: WARNING: .*20200101-000000" <<< "$1" && ! grep -qE "no backup written|backup: deleted postmv/20200101-000000" <<< "$1"' _ "$out"
rc=0; out=$(job db "$P-storage" bash -c 'du() { case "$1" in -sb) return 1 ;; esac; command du "$@"; }; export -f du
  bash /scripts/backup.sh' 2>&1) || rc=$?
check 'M-3: a size that cannot be read after the rename keeps exit 0 and the wrote line' \
  bash -c '[ "$2" = 0 ] && grep -qE "^backup: wrote postmv/[0-9]{8}-[0-9]{6}$" <<< "$(tail -n1 <<< "$1")"' _ "$out" "$rc"
check 'M-3: it warns instead of printing a size line without a number' \
  bash -c 'grep -q "backup: WARNING: the size of postmv/" <<< "$1" && ! grep -E "^backup: size" <<< "$1" | grep -qvE "^backup: size [0-9]+ bytes$"' _ "$out"
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
# D: a public.to_regclass that hides every table (found first through the role's search_path) cannot turn the
# ROTATE_KEYS delete and its count into no-ops: restore.sh pins search_path to pg_catalog and qualifies its calls
sql db "insert into auth.refresh_tokens (token, session_id) values ('shadow-token', gen_random_uuid())" > /dev/null
JOB_ENV=(-e BACKUP_SUBDIR=shadow)
b=$(job db "$P-storage" bash /scripts/backup.sh | tail -n1)
sql db "create function public.to_regclass(text) returns regclass language sql as 'select null::regclass';
  alter role postgres set search_path = public, pg_catalog" > /dev/null
JOB_ENV=(-e "RESTORE_DIR=${b#backup: wrote }" -e ROTATE_KEYS=1)
rc=0; out=$(job db "$P-storage" bash /scripts/restore.sh 2>&1) || rc=$?
sql db "alter role postgres reset search_path; drop function if exists public.to_regclass(text)" > /dev/null
check 'D: a rotating restore under a shadowed to_regclass succeeds' [ "$rc" = 0 ]; [ "$rc" = 0 ] || echo "$out" >&2
check 'D: and really deletes the restored sessions' [ "$(sql db 'select count(*) from auth.refresh_tokens')" = 0 ]
# D: a login event trigger (Postgres 17) runs after the startup options and can set search_path back to public first,
# where a public || hides every table from the ROTATE_KEYS delete; the job's connections run with event_triggers=off
sql db "insert into auth.refresh_tokens (token, session_id) values ('login-token', gen_random_uuid())" > /dev/null
JOB_ENV=(-e BACKUP_SUBDIR=login)
b=$(job db "$P-storage" bash /scripts/backup.sh | tail -n1)
sql db "create function public.cat_shadow(text, text) returns text language sql immutable as \$\$ select 'auth.none' \$\$;
  create operator public.|| (leftarg = text, rightarg = text, function = public.cat_shadow);
  create function public.reset_path() returns event_trigger language plpgsql as \$\$ begin
    perform pg_catalog.set_config('search_path', 'public, pg_catalog', false); end \$\$;
  create event trigger reset_path on login execute function public.reset_path()" > /dev/null
JOB_ENV=(-e "RESTORE_DIR=${b#backup: wrote }" -e ROTATE_KEYS=1)
rc=0; out=$(job db "$P-storage" bash /scripts/restore.sh 2>&1) || rc=$?
sql db "drop event trigger reset_path; drop function public.reset_path();
  drop operator public.|| (text, text); drop function public.cat_shadow(text, text)" > /dev/null
check 'D: a rotating restore under a login trigger that resets search_path succeeds' [ "$rc" = 0 ]; [ "$rc" = 0 ] || echo "$out" >&2
check 'D: and still deletes the restored sessions' [ "$(sql db 'select count(*) from auth.refresh_tokens')" = 0 ]
# a foreign dump with neither table: nothing to delete, no error (into a database with pg_cron, as every project's is)
sql db-empty "create extension if not exists pg_cron" > /dev/null
JOB_ENV=(-e BACKUP_SUBDIR=empty)
last=$(job db-empty "$P-empty-storage" bash /scripts/backup.sh | tail -n1)
JOB_ENV=(-e "RESTORE_DIR=${last#backup: wrote }" -e ROTATE_KEYS=1)
rc=0; out=$(job db-empty "$P-empty-storage" bash /scripts/restore.sh 2>&1) || rc=$?
check 'I1: a rotating restore of a dump without auth tables succeeds' [ "$rc" = 0 ]; [ "$rc" = 0 ] || echo "$out" >&2

# ---- E: a restore is sized before anything changes: the volume of the project's data keeps its floor ----
# cramped <RESTORE_DIR> [floor MiB]: a restore into db-empty with a 64 MiB storage volume; prints entries=<n> left on it
# and tars=<n>, the tar processes still running after it
# [inodes]: the volume's inode count (tmpfs nr_inodes); [shell prefix]: run first (a stand-in on PATH, a signal)
cramped() { docker run --rm --network "$NET" -e PGHOST=db-empty -e PGPASSWORD="$PW" -e "RESTORE_DIR=$1" -e "BACKUP_MIN_FREE_MIB=${2:-1}" \
  -e "PREFIX=${4:-}" -v "$P-backups:/backups:ro" --tmpfs "/data/storage:size=64m${3:+,nr_inodes=$3}" "$IMAGE" \
  bash -c 'eval "$PREFIX"; rc=0; bash /scripts/restore.sh || rc=$?; echo "entries=$(ls -A /data/storage | wc -l)"
    echo "tars=$(pgrep -cx tar)"; [ "$(ls -A /data/storage | wc -l)" -gt 20 ] || ls -A /data/storage | sed "s/^/name=/"; exit $rc' 2>&1; }
# variant <name> <script>: esmall/<name>, a copy of the small backup whose storage archive the script writes to $a,
# run in a temp dir; its MANIFEST line is made to match
variant() { in_backups "set -e; cp -a /backups/$small /backups/esmall/$1; a=/backups/esmall/$1/storage.tar.gz; w=\$(mktemp -d); cd \$w
  $2
  cd /backups/esmall/$1; rm -rf \$w
  sed -i \"s|^storage.tar.gz .*|storage.tar.gz \$(stat -c %s storage.tar.gz) \$(sha256sum < storage.tar.gz | cut -d' ' -f1)|\" MANIFEST"; }
# standin <name> <script>: /backups/standin/<name>/tar, a tar whose extraction (-x) runs the script first (tar's
# arguments in "$@"); everything else, and the extraction when the script returns, is the real tar
standin() { docker run --rm -i -v "$P-backups:/backups" "$IMAGE" bash -c \
  "mkdir -p /backups/standin/$1 && cat > /backups/standin/$1/tar && chmod +x /backups/standin/$1/tar" <<EOF
#!/bin/bash
case " \$* " in *" -xzf "*) $2 ;; esac
exec /usr/bin/tar "\$@"
EOF
}
# pgrstandin <name> <script>: /backups/standin/<name>/pg_restore, a pg_restore whose restore (--single-transaction)
# runs the script instead (its arguments in "$@"; real runs the real pg_restore); every other call is the real one
pgrstandin() { docker run --rm -i -v "$P-backups:/backups" "$IMAGE" bash -c \
  "mkdir -p /backups/standin/$1 && cat > /backups/standin/$1/pg_restore && chmod +x /backups/standin/$1/pg_restore" <<EOF
#!/bin/bash
real() { PATH=\${PATH#*:} pg_restore "\$@"; }
case " \$* " in *" --single-transaction "*) $2 ;; *) real "\$@" ;; esac
EOF
}
emarker() { sql db-empty 'select v from public.e_marker'; }
sql db-empty "create table public.e_marker (v text); insert into public.e_marker values ('in-backup')" > /dev/null
JOB_ENV=(-e BACKUP_SUBDIR=esmall)
small=$(job db-empty "$P-empty-storage" bash /scripts/backup.sh | tail -n1); small=${small#backup: wrote }
rc=0; out=$(cramped "$small") || rc=$?
check 'E: a small restore runs on a 64 MiB volume with BACKUP_MIN_FREE_MIB=1' [ "$rc" = 0 ]; [ "$rc" = 0 ] || echo "$out" >&2
check 'E: and says what it will write and the room above the floor' grep -qE '^restore: about [0-9]+ MiB to write, [0-9]+ MiB free above the floor$' <<< "$out"
rc=0; out=$(cramped "$small" x) || rc=$?
check 'E: a BACKUP_MIN_FREE_MIB that is not a number is refused (exit 2)' [ "$rc" = 2 ]
# a dump whose rows restore to 200 MiB: 2000 rows of 100 kB, compressed in the database (TOAST) and in the dump
sql db-empty "create table public.e_bomb (v text); insert into public.e_bomb select repeat('x', 100000) from generate_series(1, 2000)" > /dev/null
JOB_ENV=(-e BACKUP_SUBDIR=ebomb)
bomb=$(job db-empty "$P-empty-storage" bash /scripts/backup.sh | tail -n1); bomb=${bomb#backup: wrote }
sql db-empty 'drop table public.e_bomb' > /dev/null
# a storage archive of a few hundred kB that extracts to 100 MiB, with a matching MANIFEST
in_backups "set -e; cp -a /backups/$small /backups/esmall/storage-bomb; w=\$(mktemp -d); head -c 100M /dev/zero > \$w/zeros
  tar -czf /backups/esmall/storage-bomb/storage.tar.gz -C \$w zeros; rm -rf \$w; cd /backups/esmall/storage-bomb
  sed -i \"s|^storage.tar.gz .*|storage.tar.gz \$(stat -c %s storage.tar.gz) \$(sha256sum < storage.tar.gz | cut -d' ' -f1)|\" MANIFEST"
sql db-empty "update public.e_marker set v = 'after-backup'" > /dev/null
rc=0; out=$(cramped esmall/storage-bomb) || rc=$?
check 'E: a storage archive that extracts past the room above the floor is refused (exit 6)' [ "$rc" = 6 ]; [ "$rc" = 6 ] || echo "$out" >&2
check 'E: the refusal names the free space, the floor and the size' grep -qE "^restore: REFUSED: [0-9]+ MiB free on the volume of the project's data, at least 1 MiB \(BACKUP_MIN_FREE_MIB\) needed after this restore of about 10[0-9] MiB; free space first$" <<< "$out"
check 'E: nothing is extracted' grep -qx 'entries=0' <<< "$out"
check 'E: the database is unchanged' [ "$(emarker)" = after-backup ]
rc=0; out=$(cramped "$bomb") || rc=$?
check 'E: a dump that restores past the room above the floor is refused (exit 6)' [ "$rc" = 6 ]; [ "$rc" = 6 ] || echo "$out" >&2
check 'E: that refusal says more than the room' grep -qE "needed after this restore of more than [0-9]+ MiB; free space first$" <<< "$out"
check 'E: the database is unchanged by the refused dump' [ "$(emarker)" = after-backup ]
check 'E: and the dump was not restored' [ "$(sql db-empty "select to_regclass('public.e_bomb') is null")" = t ]
# E: every entry takes at least a block and an inode, however empty
in_backups "set -e; for k in dirs files; do cp -a /backups/$small /backups/esmall/empty-\$k; done; w=\$(mktemp -d)
  mkdir \$w/d \$w/f; (cd \$w/d && seq -f 'd%g' 20000 | xargs mkdir); (cd \$w/f && seq -f 'f%g' 1900 | xargs touch)
  tar -czf /backups/esmall/empty-dirs/storage.tar.gz -C \$w/d .; tar -czf /backups/esmall/empty-files/storage.tar.gz -C \$w/f .
  rm -rf \$w; for k in dirs files; do cd /backups/esmall/empty-\$k
    sed -i \"s|^storage.tar.gz .*|storage.tar.gz \$(stat -c %s storage.tar.gz) \$(sha256sum < storage.tar.gz | cut -d' ' -f1)|\" MANIFEST; done"
rc=0; out=$(cramped esmall/empty-dirs) || rc=$?
check 'E: 20000 empty directories count a block each and are refused (exit 6)' [ "$rc" = 6 ]; [ "$rc" = 6 ] || echo "$out" >&2
check 'E: that refusal counts them at 4 KiB each' grep -qE "needed after this restore of about 7[0-9] MiB; free space first$" <<< "$out"
rc=0; out=$(cramped esmall/empty-files 1 2000) || rc=$?
check 'E: 1900 empty files on a volume of 2000 inodes are refused (exit 6)' [ "$rc" = 6 ]; [ "$rc" = 6 ] || echo "$out" >&2
check 'E: that refusal names the inodes' grep -q "^restore: REFUSED: [0-9]* inodes free on the volume of the project's data" <<< "$out"
check 'E: the database is unchanged by both' [ "$(emarker)" = after-backup ]
# E: tar makes the parent directories an archive leaves out: each one costs a block and an inode too. 3000 files at
# k<i>/a/b/c/d/e/f, no directory entries: 12 MiB of files listed, 70 MiB of directories not
variant deep-blocks 'for i in $(seq 3000); do mkdir -p k$i/a/b/c/d/e && : > k$i/a/b/c/d/e/f; done
  find . -type f | tar --no-recursion -czf $a -T -'
rc=0; out=$(cramped esmall/deep-blocks) || rc=$?
check 'E: an archive of deep paths without directory entries is refused (exit 6)' [ "$rc" = 6 ]; [ "$rc" = 6 ] || echo "$out" >&2
check 'E: that refusal counts the implied directories' grep -qE "needed after this restore of about 8[0-9] MiB; free space first$" <<< "$out"
# 300 such files are 2100 inodes, on a volume of 2000
variant deep-inodes 'for i in $(seq 300); do mkdir -p k$i/a/b/c/d/e && : > k$i/a/b/c/d/e/f; done
  find . -type f | tar --no-recursion -czf $a -T -'
rc=0; out=$(cramped esmall/deep-inodes 1 2000) || rc=$?
check 'E: their implied directories count against the inodes as well (exit 6)' [ "$rc" = 6 ]; [ "$rc" = 6 ] || echo "$out" >&2
check 'E: that refusal names the inodes too' grep -q "^restore: REFUSED: [0-9]* inodes free on the volume of the project's data" <<< "$out"
# the watchdog reads the free inodes as well: a stand-in tar makes 1900 files on a volume of 2000 before extracting
standin many 'cd "${@: -1}"; for i in $(seq 1900); do : > i$i; done; sleep 5'
rc=0; out=$(cramped "$small" 1 2000 'export PATH=/backups/standin/many:$PATH') || rc=$?
check 'E: an extraction that uses the inodes past the floor is stopped (exit 6)' [ "$rc" = 6 ]; [ "$rc" = 6 ] || echo "$out" >&2
check 'E: the stop names the floor, and nothing is left' bash -c 'grep -q "^restore: REFUSED: the volume of the project.s data reached the floor" <<< "$1" && grep -qx entries=0 <<< "$1"' _ "$out"
# 4: the restore's temp dir in the volume is \restoring-<pid>, a name no bucket can have (core refuses a backslash in
# a key). An archive carrying a \restoring-* name at the top is refused
variant reserved 'mkdir "\\restoring-1" && echo x > "\\restoring-1/x" && tar -czf $a .'
rc=0; out=$(cramped esmall/reserved) || rc=$?
check '4: an archive holding a \restoring-* name at the top is refused (exit 1)' [ "$rc" = 1 ]; [ "$rc" = 1 ] || echo "$out" >&2
check '4: that refusal names it' grep -qF 'holds a \restoring-* name' <<< "$out"
check 'E: the database is unchanged by these' [ "$(emarker)" = after-backup ]
# .restoring-<digits> are ordinary names again: 300 of them (one is the pid the restore has in its new container)
variant restoring 'for i in $(seq 300); do mkdir .restoring-$i && echo x > .restoring-$i/x; done; tar -czf $a .'
rc=0; out=$(cramped esmall/restoring) || rc=$?
check '4: an archive of .restoring-<digits> directories restores them all' bash -c '[ "$1" = 0 ] && grep -qx entries=300 <<< "$2"' _ "$rc" "$out"
[ "$rc" = 0 ] || echo "$out" >&2
# a bucket named .restoring-4242 is kept by a backup and a restore; a leftover \restoring-4242 (a restore killed
# outright) is neither backed up nor kept: the next restore removes it first, even one it then refuses
bucket='mkdir -p /data/storage/.restoring-4242 && echo x > /data/storage/.restoring-4242/f'
leftover='mkdir -p "/data/storage/\\restoring-4242" && echo x > "/data/storage/\\restoring-4242/f"'
docker run --rm -v "$P-empty-storage:/data/storage" "$IMAGE" bash -c "$bucket && $leftover"
JOB_ENV=(-e BACKUP_SUBDIR=eleft)
eleft=$(job db-empty "$P-empty-storage" bash /scripts/backup.sh | tail -n1); eleft=${eleft#backup: wrote }
docker run --rm -v "$P-empty-storage:/data/storage" "$IMAGE" bash -c 'rm -rf /data/storage/.restoring-4242 "/data/storage/\\restoring-4242"'
names=$(in_backups "tar -tzf /backups/$eleft/storage.tar.gz")
check '4: a backup keeps a bucket named .restoring-4242' grep -qx './.restoring-4242/f' <<< "$names"
check '4: and leaves the leftover \restoring-4242 out' bash -c '! grep -vF ./.restoring-4242 <<< "$1" | grep -qF restoring-4242' _ "$names"
rc=0; out=$(cramped "$eleft" 1 '' "$leftover") || rc=$?
check '4: its restore brings the bucket back and removes the leftover' \
  bash -c '[ "$1" = 0 ] && grep -qx name=.restoring-4242 <<< "$2" && ! grep -qxF "name=\\restoring-4242" <<< "$2"' _ "$rc" "$out"
[ "$rc" = 0 ] || echo "$out" >&2
rc=0; out=$(cramped esmall/storage-bomb 1 '' "$leftover") || rc=$?
check '4: a refused restore removes the leftover all the same' bash -c '[ "$1" = 6 ] && grep -qx entries=0 <<< "$2"' _ "$rc" "$out"
[ "$rc" = 6 ] || echo "$out" >&2
sql db-empty "update public.e_marker set v = 'after-backup'" > /dev/null
# a writer that ended well as the stop reached it (pg_restore had committed) is no rollback: here a stand-in tar
# extracts, fills the volume, and exits 0 when it is stopped (taking its filler with it); the restore goes on
standin fills '/usr/bin/tar "$@" || exit; trap "rm -f /data/storage/.fill; exit 0" TERM
  head -c 100M /dev/zero > /data/storage/.fill 2> /dev/null; sleep 30 & wait; exit 0'
rc=0; out=$(cramped "$small" 1 '' 'export PATH=/backups/standin/fills:$PATH') || rc=$?
check 'E: a writer that exits 0 when stopped at the floor lets the restore finish' [ "$rc" = 0 ]; [ "$rc" = 0 ] || echo "$out" >&2
check 'E: and no rollback is reported' bash -c '! grep -q "rolled back" <<< "$1"' _ "$out"
sql db-empty "update public.e_marker set v = 'after-backup'" > /dev/null
# a restore ended by SIGTERM (a stopped job container) stops its writer before the temp dir goes: a stand-in tar
# that keeps making directories, the restore signalled after 4 s
standin hang 'cd "${@: -1}"; while :; do mkdir -p late$((i += 1)); sleep 0.2; done'
rc=0; out=$(cramped "$small" 1 '' 'export PATH=/backups/standin/hang:$PATH; (sleep 4; pkill -TERM -f "^bash /scripts/restore.sh") &') || rc=$?
check 'E: a restore stopped by SIGTERM exits 143' [ "$rc" = 143 ]; [ "$rc" = 143 ] || echo "$out" >&2
check 'E: its writer is stopped with it' grep -qx tars=0 <<< "$out"
check 'E: and its temp dir is gone' grep -qx entries=0 <<< "$out"
check 'E: and it says it was stopped, nothing changed' grep -q '^restore: STOPPED by a signal' <<< "$out"
# 7: a restore step 1b admits is not stopped when its last file lands at exactly the floor: a stand-in tar extracts,
# then fills the volume to exactly the floor (1 MiB free) and holds it there
standin brim '/usr/bin/tar "$@" || exit; a=$(df -Pk /data/storage | awk "NR == 2 { print \$4 }")
  head -c $(( (a - 1024) * 1024 )) /dev/zero > "${@: -1}/brim"; sleep 3; exit 0'
rc=0; out=$(cramped "$small" 1 '' 'export PATH=/backups/standin/brim:$PATH') || rc=$?
check '7: a restore that leaves exactly the floor free finishes' [ "$rc" = 0 ]; [ "$rc" = 0 ] || echo "$out" >&2
# 1: a signal once pg_restore has committed is no rollback. Here it comes in the v1 ledger step (db-empty has no
# ledger, so its dumps are v1 dumps): the restore ends with exit 7 (database restored, storage not replaced), leaves
# cron.job as restored and never says nothing changed
ejob() { sql db-empty "select active from cron.job where jobname = 'e_job'"; }
sql db-empty "select cron.schedule('e_job', '0 0 1 1 *', 'select 1'); update cron.job set active = false where jobname = 'e_job'" > /dev/null
JOB_ENV=(-e BACKUP_SUBDIR=ecron)
ecron=$(job db-empty "$P-empty-storage" bash /scripts/backup.sh | tail -n1); ecron=${ecron#backup: wrote }
sql db-empty "update cron.job set active = true where jobname = 'e_job'" > /dev/null
rc=0; out=$(cramped "$ecron" 1 '' 'psql() { case "$*" in *"selfbase_restore_hold cascade"*) pkill -TERM -f "^bash /scripts/restore.sh" ;; esac
  command psql "$@"; }; export -f psql') || rc=$?
check '1: a signal after pg_restore committed exits 7' [ "$rc" = 7 ]; [ "$rc" = 7 ] || echo "$out" >&2
check '1: cron.job stays as restored (its job is not set active again)' [ "$(ejob)" = f ]
check '1: it says the database was restored and the storage not, never that nothing changed' \
  bash -c 'grep -q "DATABASE WAS RESTORED .* storage files were NOT replaced" <<< "$1" && ! grep -q unchanged <<< "$1"' _ "$out"
check '1: and its temp dir is gone' grep -qx entries=0 <<< "$out"
# 2: a signal while pg_restore runs (a refresh that sleeps 60 s keeps it running): every session of the cluster but
# the restore's own is terminated, one in a second database too (contained). Once pg_restore started nothing but its
# recorded success is known: exit 8, and nothing is undone (the cron step stays)
sql db-empty "update cron.job set active = true where jobname = 'e_job';
  create table public.knob3 (s float8); insert into public.knob3 values (0);
  create function public.e_nap() returns int language plpgsql as \$\$ begin perform pg_catalog.pg_sleep((select s from public.knob3)); return 1; end \$\$;
  create materialized view public.e_slow as select public.e_nap() as n;
  update public.knob3 set s = 60" > /dev/null
JOB_ENV=(-e BACKUP_SUBDIR=eslow)
eslow=$(job db-empty "$P-empty-storage" bash /scripts/backup.sh | tail -n1); eslow=${eslow#backup: wrote }
sql db-empty 'drop materialized view public.e_slow; drop function public.e_nap(); drop table public.knob3' > /dev/null
# the brim restore above restored $small, whose e_marker eslow now holds too: live, a value eslow does not hold
sql db-empty "update public.e_marker set v = 'after-backup'" > /dev/null
sql db-empty 'create database e_other' > /dev/null
others() { sql db-empty "select count(*) from pg_stat_activity where datname = 'e_other'"; }
compose exec -T db-empty psql -XAtq -U postgres -d e_other -c 'select pg_sleep(120)' > /dev/null 2>&1 & other=$!
# 5: and a replication=database session (a walsender, which runs SQL too) writing in that database
compose exec -T db-empty psql -XAtq -U postgres -d e_other -c 'create table public.w (v int)' > /dev/null
compose exec -T db-empty psql -XAtq -U postgres -d 'dbname=e_other replication=database' \
  -c 'begin; insert into public.w values (1); select pg_sleep(120); commit' > /dev/null 2>&1 & wal=$!
walsenders() { sql db-empty "select count(*) from pg_stat_activity where backend_type = 'walsender'"; }
for i in $(seq 20); do [ "$(others)" -lt 2 ] || [ "$(walsenders)" = 0 ] || break; sleep 0.5; done
rc=0; out=$(cramped "$eslow" 1 '' '(sleep 6; pkill -TERM -f "^bash /scripts/restore.sh") &') || rc=$?
n=$(others) nw=$(walsenders)
sql db-empty "select pg_terminate_backend(pid) from pg_stat_activity where datname = 'e_other'" > /dev/null
wait "$other" || true; wait "$wal" || true
check '5: a walsender writing in a second database was terminated too' [ "$nw" = 0 ]; [ "$nw" = 0 ] || echo "walsenders: $nw" >&2
check '5: and its write rolled back' \
  [ "$(compose exec -T db-empty psql -XAtq -U postgres -d e_other -c 'select count(*) from public.w')" = 0 ]
check '2: a restore stopped by SIGTERM while pg_restore runs exits 8' [ "$rc" = 8 ]; [ "$rc" = 8 ] || echo "$out" >&2
check '2: it says the state is unknown, never that nothing changed' \
  bash -c 'grep -q "STATE UNKNOWN" <<< "$1" && ! grep -qE "rolled back|unchanged|set active again" <<< "$1"' _ "$out"
check '2: (the terminated transaction did roll back: the dump is not there)' [ "$(sql db-empty "select to_regclass('public.e_slow') is null")" = t ]
check '2: (and the database is as it was)' [ "$(emarker)" = after-backup ]
check '2: the cron step is not undone' [ "$(ejob)" = f ]
sql db-empty "update cron.job set active = true where jobname = 'e_job'" > /dev/null
check '2: a session in a second database of the cluster was terminated too' [ "$n" = 0 ]; [ "$n" = 0 ] || echo "e_other sessions: $n" >&2
# 2: a stop that cannot show the sessions ended (here every termination query fails): exit 8, state unknown, and
# nothing is undone
rc=0; out=$(cramped "$eslow" 1 '' 'psql() { case "$*" in *"pg_terminate_backend(pid, 1000)"*) return 2 ;; esac; command psql "$@"; }
  export -f psql; (sleep 6; pkill -TERM -f "^bash /scripts/restore.sh") &') || rc=$?
check '2: a stop that does not converge exits 8' [ "$rc" = 8 ]; [ "$rc" = 8 ] || echo "$out" >&2
check '2: it says the state is unknown and claims no rollback' \
  bash -c 'grep -q "STATE UNKNOWN" <<< "$1" && ! grep -qE "rolled back|unchanged|set active again" <<< "$1"' _ "$out"
sql db-empty "select pg_terminate_backend(pid) from pg_stat_activity where backend_type = 'client backend' and pid <> pg_backend_pid()" > /dev/null
sql db-empty "update cron.job set active = true where jobname = 'e_job'" > /dev/null
# 2: a pg_restore that started and did not succeed proves nothing about the database. A stand-in commits a
# transaction (2 s long), then exits nonzero: exit 8, no rollback claimed
pgrstandin sneak 'psql -XAtq -c "begin; create table public.e_sneak (v int); select pg_sleep(2); commit" > /dev/null; exit 1'
rc=0; out=$(cramped "$small" 1 '' 'export PATH=/backups/standin/sneak:$PATH') || rc=$?
check '2: a pg_restore that committed, then exited nonzero, exits 8' [ "$rc" = 8 ]; [ "$rc" = 8 ] || echo "$out" >&2
check '2: and claims no rollback' bash -c 'grep -q "STATE UNKNOWN" <<< "$1" && ! grep -qE "rolled back|unchanged" <<< "$1"' _ "$out"
check '2: (it did commit)' [ "$(sql db-empty "select to_regclass('public.e_sneak') is not null")" = t ]
# one that commits at once and exits nonzero without an SQL error: exit 8 as well
pgrstandin quick 'psql -XAtq -c "create table public.e_quick (v int)" > /dev/null; exit 1'
rc=0; out=$(cramped "$small" 1 '' 'export PATH=/backups/standin/quick:$PATH') || rc=$?
check '2: a quick commit, then a nonzero exit without an SQL error, exits 8' [ "$rc" = 8 ]; [ "$rc" = 8 ] || echo "$out" >&2
sql db-empty "drop table if exists public.e_sneak, public.e_quick; update cron.job set active = true where jobname = 'e_job'" > /dev/null
# and a dump that fails on an SQL error (its view divides by zero when refreshed): pg_restore's own output is no
# proof of a rollback either (the dump's SQL can commit before it fails), so exit 8 and nothing undone
sql db-empty "create table public.knob4 (n int); insert into public.knob4 values (1);
  create materialized view public.e_div as select 1 / (select n from public.knob4) as v;
  update public.knob4 set n = 0; update public.e_marker set v = 'in-ediv'" > /dev/null
JOB_ENV=(-e BACKUP_SUBDIR=ediv)
ediv=$(job db-empty "$P-empty-storage" bash /scripts/backup.sh | tail -n1); ediv=${ediv#backup: wrote }
sql db-empty "drop materialized view public.e_div; drop table public.knob4; update public.e_marker set v = 'after-backup'" > /dev/null
rc=0; out=$(cramped "$ediv") || rc=$?
check '2: a dump that fails on an SQL error exits 8' [ "$rc" = 8 ]; [ "$rc" = 8 ] || echo "$out" >&2
check '2: and claims no rollback' bash -c 'grep -q "STATE UNKNOWN" <<< "$1" && ! grep -qE "rolled back|unchanged|set active again" <<< "$1"' _ "$out"
check '2: (pg_restore'"'"'s error is shown)' grep -q 'division by zero' <<< "$out"
check '2: the cron step is not undone after it' [ "$(ejob)" = f ]
sql db-empty "update cron.job set active = true where jobname = 'e_job'" > /dev/null
# 6: a stop that failed is not run again: a writer that, stopped at the floor after the failed stop, signals the
# restore before it exits. Every termination fails (as above); one 30 s stop, not two
pgrstandin fill 'trap "kill -TERM $PPID; sleep 3; exit 1" TERM; head -c 100M /dev/zero > /data/storage/.fill 2> /dev/null
  sleep 120 & wait; exit 1'
start=$SECONDS
rc=0; out=$(cramped "$small" 1 '' 'export PATH=/backups/standin/fill:$PATH
  psql() { case "$*" in *"pg_terminate_backend(pid, 1000)"*) return 2 ;; esac; command psql "$@"; }; export -f psql') || rc=$?
took=$((SECONDS - start))
check '6: a signal after a failed stop exits 8' [ "$rc" = 8 ]; [ "$rc" = 8 ] || echo "$out" >&2
check '6: within one stop (under 45 s)' [ "$took" -lt 45 ]; [ "$took" -lt 45 ] || echo "took ${took}s" >&2
sql db-empty "update cron.job set active = true where jobname = 'e_job'" > /dev/null
# 2 (round 5): the cleanup ends within its deadline (40 s, under the container's 60 s stop timeout). A writer that
# ignores TERM is killed: here a stand-in tar that fills the inodes past the floor and ignores TERM (exit 6, as
# pg_restore never started) ...
standin deaf 'cd "${@: -1}"; trap "" TERM; for i in $(seq 1900); do : > i$i; done; sleep 90; exit 1'
start=$SECONDS
rc=0; out=$(cramped "$small" 1 2000 'export PATH=/backups/standin/deaf:$PATH') || rc=$?
took=$((SECONDS - start))
check '2: a tar that ignores TERM at the floor is killed: exit 6' [ "$rc" = 6 ]; [ "$rc" = 6 ] || echo "$out" >&2
check '2: within the deadline (under 45 s)' [ "$took" -lt 45 ]; [ "$took" -lt 45 ] || echo "took ${took}s" >&2
check '2: no tar is left, nor its temp dir' bash -c 'grep -qx tars=0 <<< "$1" && grep -qx entries=0 <<< "$1"' _ "$out"
# ... and a pg_restore that ignores TERM, the restore signalled after 4 s (exit 8: pg_restore had started)
pgrstandin deafpg 'trap "" TERM; sleep 90; exit 1'
start=$SECONDS
rc=0; out=$(cramped "$small" 1 '' 'export PATH=/backups/standin/deafpg:$PATH; (sleep 4; pkill -TERM -f "^bash /scripts/restore.sh") &') || rc=$?
took=$((SECONDS - start))
check '2: a pg_restore that ignores TERM is killed: exit 8' [ "$rc" = 8 ]; [ "$rc" = 8 ] || echo "$out" >&2
check '2: within the deadline (under 45 s) as well' [ "$took" -lt 45 ]; [ "$took" -lt 45 ] || echo "took ${took}s" >&2
sql db-empty "update cron.job set active = true where jobname = 'e_job'" > /dev/null
# an undo query that blocks (a test session holds a lock on cron.job, taken as the pg_cron step fails; PGOPTIONS
# emptied, or it would inherit the hooked query's statement timeout) ends at its own statement timeout: the cron jobs
# are left to be set active by hand, and the restore keeps its exit (1)
start=$SECONDS
rc=0; out=$(cramped "$small" 1 '' 'psql() { case "$*" in *"backend_type = "*)
    PGOPTIONS= command psql -XAtq -c "begin; lock table cron.job; select pg_catalog.pg_sleep(90)" > /dev/null 2>&1 & sleep 2; return 1 ;; esac
  command psql "$@"; }; export -f psql') || rc=$?
took=$((SECONDS - start))
sql db-empty "select pg_terminate_backend(pid) from pg_stat_activity where query like '%lock table cron.job%' and pid <> pg_backend_pid()" > /dev/null
check '2: a failure whose cron undo is blocked by a lock keeps its exit (1)' [ "$rc" = 1 ]; [ "$rc" = 1 ] || echo "$out" >&2
check '2: it ends within the deadline (under 45 s)' [ "$took" -lt 45 ]; [ "$took" -lt 45 ] || echo "took ${took}s" >&2
check '2: and says the cron jobs are to be set active by hand' grep -q 'could NOT set cron jobs .* active again; do it by hand' <<< "$out"
check '2: (they are still inactive)' [ "$(ejob)" = f ]
sql db-empty "update cron.job set active = true where jobname = 'e_job'" > /dev/null
# round 6, 1: a psql here is bounded by the wall clock, not only by the server's timeouts. A stand-in server accepts
# the connection, completes the startup, then never answers (it exits after 60 s): the restore's first query ends
# at its bound (16 s, timeout's exit 124), not when the server goes
docker run --rm -i -v "$P-backups:/backups" "$IMAGE" bash -c 'mkdir -p /backups/standin && cat > /backups/standin/silent.pl' <<'EOF'
alarm 60;
use IO::Socket::INET;
my $s = IO::Socket::INET->new(LocalAddr => '127.0.0.1:5499', Listen => 5, ReuseAddr => 1) or die "listen: $!";
my @keep;
while (my $c = $s->accept) {
  my ($l, $m);
  sysread $c, $l, 4;
  sysread $c, $m, unpack('N', $l) - 4;
  my $p = "server_version\0" . "17.0\0";
  syswrite $c, pack('aNN', 'R', 8, 0) . pack('aN', 'S', 4 + length $p) . $p . pack('aNa', 'Z', 5, 'I');
  push @keep, $c;
}
EOF
start=$SECONDS
rc=0; out=$(cramped "$small" 1 '' 'perl /backups/standin/silent.pl & sleep 1
  export PGHOST=127.0.0.1 PGPORT=5499 PGSSLMODE=disable PGGSSENCMODE=disable') || rc=$?
took=$((SECONDS - start))
check '1: a query to a server that never answers ends at its bound (exit 124)' [ "$rc" = 124 ]; [ "$rc" = 124 ] || echo "$out" >&2
check '1: well before the server goes (under 30 s)' [ "$took" -lt 30 ]; [ "$took" -lt 30 ] || echo "took ${took}s" >&2
# the two-statement ledger undo is one bound too (transaction_timeout): the hold step fails once it moved the ledger,
# with a session holding the ledger table for 7 s and another the hold schema for 90 s. Per statement (10 s each) the
# undo would take 17 s and end on the statement timeout; as one transaction it ends at 10 s on the transaction timeout
had=$(sql db-empty "select count(*) from pg_namespace where nspname = 'selfbase'")
sql db-empty "create schema if not exists selfbase; create table selfbase.platform_migrations (version text)" > /dev/null
start=$SECONDS
rc=0; out=$(cramped "$small" 1 '' 'psql() { case "$*" in *"set schema selfbase_restore_hold"*) command psql "$@" || return
    PGOPTIONS= command psql -XAtq -c "begin; lock table selfbase_restore_hold.platform_migrations; select pg_catalog.pg_sleep(7)" > /dev/null 2>&1 &
    PGOPTIONS= command psql -XAtq -c "begin; create table selfbase_restore_hold.blk (); select pg_catalog.pg_sleep(90)" > /dev/null 2>&1 &
    sleep 1; return 1 ;; esac
  command psql "$@"; }; export -f psql') || rc=$?
took=$((SECONDS - start))
sql db-empty "select pg_terminate_backend(pid) from pg_stat_activity where query like '%selfbase_restore_hold.blk%' and pid <> pg_backend_pid()" > /dev/null
check '1: a ledger undo under locks ends on the transaction timeout' grep -q 'transaction timeout' <<< "$out"; grep -q 'transaction timeout' <<< "$out" || echo "$out" >&2
check '1: and says the ledger is to be moved back by hand' grep -q 'could NOT move the platform ledger back; do it by hand' <<< "$out"
check '1: the restore keeps its exit (1), within the deadline (under 45 s)' [ "$rc" = 1 ] && [ "$took" -lt 45 ]
sql db-empty "drop schema if exists selfbase_restore_hold cascade; drop table if exists selfbase.platform_migrations;
  $([ "$had" = 1 ] || echo 'drop schema if exists selfbase;') update cron.job set active = true where jobname = 'e_job'" > /dev/null
# round 6, 2: the whole writer group is killed. A stand-in tar fills the inodes past the floor; on TERM its leader
# exits, while a child it started ignores TERM and keeps writing into the temp dir (making it again if it is gone)
standin orphan 'cd "${@: -1}"; d=$PWD; ( trap "" TERM; while :; do mkdir -p "$d" && : > "$d/c$((i += 1))"; sleep 0.1; done ) 2> /dev/null &
  trap "exit 1" TERM; for i in $(seq 1900); do : > i$i; done; sleep 90 & wait'
rc=0; out=$(cramped "$small" 1 2000 'export PATH=/backups/standin/orphan:$PATH') || rc=$?
check '2: a writer child that outlives its leader: still exit 6' [ "$rc" = 6 ]; [ "$rc" = 6 ] || echo "$out" >&2
check '2: the child is killed with its group before the temp dir goes (no tar, no entry left)' \
  bash -c 'grep -qx tars=0 <<< "$1" && grep -qx entries=0 <<< "$1"' _ "$out"; grep -qx entries=0 <<< "$out" || echo "$out" >&2
# 1: a pg_restore that committed and exits 0 as the floor stop reaches it, signalling the restore as it goes: the
# commit is kept (exit 7: database restored, storage not replaced), never reported as nothing changed
pgrstandin zero 'real "$@" || exit; trap "kill -TERM $PPID; exit 0" TERM; head -c 100M /dev/zero > /data/storage/.fill 2> /dev/null
  sleep 30 & wait; exit 0'
rc=0; out=$(cramped "$small" 1 '' 'export PATH=/backups/standin/zero:$PATH') || rc=$?
check '1: a commit reaped at the floor stop, then a signal, exits 7' [ "$rc" = 7 ]; [ "$rc" = 7 ] || echo "$out" >&2
check '1: and never says nothing changed' bash -c '! grep -qE "unchanged|rolled back" <<< "$1"' _ "$out"
check '1: (the database is the backup'"'"'s)' [ "$(emarker)" = in-backup ]
sql db-empty "update public.e_marker set v = 'after-backup'" > /dev/null
# E: the watchdog. What the server writes counts too: a materialized view the dump refreshes is one short line in the
# estimate, over a row count kept in a table (1 when it was refreshed, 2 million in the dump). The database and the
# storage volume share one 512 MiB tmpfs, as Docker volumes share a disk; 100 MiB of room above the floor
sql db-empty "create table public.knob (n int); insert into public.knob values (1);
  create materialized view public.e_grow as select g, repeat('x', 200) as pad from generate_series(1, (select n from public.knob)) g;
  update public.knob set n = 2000000" > /dev/null
JOB_ENV=(-e BACKUP_SUBDIR=egrow)
grow=$(job db-empty "$P-empty-storage" bash /scripts/backup.sh | tail -n1); grow=${grow#backup: wrote }
sql db-empty 'drop materialized view public.e_grow; drop table public.knob' > /dev/null
# smalldb: a new dbsmall on a new 512 MiB tmpfs (a stopped restore leaves its WAL on it)
smalldb() {
  docker rm -f "$P-dbsmall" > /dev/null 2>&1 || true; docker volume rm -f "$P-small" > /dev/null
  docker volume create --driver local --opt type=tmpfs --opt device=tmpfs --opt o=size=512m "$P-small" > /dev/null
  docker run -d --name "$P-dbsmall" --network "$NET" --network-alias dbsmall -e POSTGRES_PASSWORD="$PW" -e PGDATA=/var/lib/postgresql/data/pg \
    -v "$P-small:/var/lib/postgresql/data" "$(docker inspect -f '{{.Config.Image}}' "$(compose ps -q db-empty)")" > /dev/null
  for i in $(seq 120); do docker exec "$P-dbsmall" pg_isready -q -U postgres -h 127.0.0.1 2> /dev/null && break; sleep 1; done
  docker exec "$P-dbsmall" mkdir -p /var/lib/postgresql/data/storage
  # every project database has pg_cron (restore.sh reads cron.job)
  docker exec "$P-dbsmall" psql -XAtq -U postgres -c 'create extension if not exists pg_cron' > /dev/null
}
smalldb
gfloor=$(( $(docker exec "$P-dbsmall" df -Pk /var/lib/postgresql/data | awk 'NR == 2 { print $4 }') / 1024 - 100 ))
rc=0; out=$(docker run --rm --network "$NET" -e PGHOST=dbsmall -e PGPASSWORD="$PW" -e "RESTORE_DIR=$grow" -e "BACKUP_MIN_FREE_MIB=$gfloor" \
  -v "$P-backups:/backups:ro" --mount "type=volume,src=$P-small,dst=/data/storage,volume-subpath=storage" "$IMAGE" \
  bash /scripts/restore.sh 2>&1) || rc=$?
check 'E: a dump whose server-side growth crosses the floor is stopped (exit 8: pg_restore had started)' [ "$rc" = 8 ]; [ "$rc" = 8 ] || echo "$out" >&2
check 'E: the stop says the floor was reached and the state is unknown, never that nothing changed' bash -c \
  'grep -q "^restore: STOPPED: the volume of the project.s data reached the floor" <<< "$1" && grep -q "STATE UNKNOWN" <<< "$1" &&
   ! grep -qE "rolled back|unchanged|nothing was changed" <<< "$1"' _ "$out"
gone=$(docker exec "$P-dbsmall" psql -XAtq -U postgres -c "select to_regclass('public.e_grow') is null" 2>&1)
check 'E: (the terminated restore did roll back: the view is not there)' [ "$gone" = t ]; [ "$gone" = t ] || echo "$gone" >&2
# the dump controls its session's name: a view whose refresh first sets application_name is stopped all the same,
# and no session of it is left running once the restore has ended. The dump's SQL can also ignore the cancel
# pg_restore sends when it is killed (a plpgsql handler for query_canceled); only a termination ends it. Past 400000
# rows (160 to 280 MiB with their WAL: beyond the room, short of a full disk) each row waits 10 ms, so a session the
# stop missed is still there when the restore ends
sql db-empty "create table public.knob2 (n int); insert into public.knob2 values (1);
  create function public.renamed_n() returns int language plpgsql as \$\$ begin
    perform pg_catalog.set_config('application_name', 'renamed', false); return (select n from public.knob2); end \$\$;
  create function public.slow_pad(g int) returns text language plpgsql as \$\$ begin
    if g > 400000 then begin perform pg_catalog.pg_sleep(0.01); exception when query_canceled then null; end; end if;
    return pg_catalog.repeat('x', 200); end \$\$;
  create materialized view public.e_rename as select g, public.slow_pad(g) as pad from generate_series(1, public.renamed_n()) g;
  update public.knob2 set n = 2000000" > /dev/null
JOB_ENV=(-e BACKUP_SUBDIR=erename)
ren=$(job db-empty "$P-empty-storage" bash /scripts/backup.sh | tail -n1); ren=${ren#backup: wrote }
sql db-empty 'drop materialized view public.e_rename; drop function public.renamed_n(), public.slow_pad(int); drop table public.knob2' > /dev/null
smalldb
gfloor=$(( $(docker exec "$P-dbsmall" df -Pk /var/lib/postgresql/data | awk 'NR == 2 { print $4 }') / 1024 - 100 ))
rc=0; out=$(docker run --rm --network "$NET" -e PGHOST=dbsmall -e PGPASSWORD="$PW" -e "RESTORE_DIR=$ren" -e "BACKUP_MIN_FREE_MIB=$gfloor" \
  -v "$P-backups:/backups:ro" --mount "type=volume,src=$P-small,dst=/data/storage,volume-subpath=storage" "$IMAGE" \
  bash /scripts/restore.sh 2>&1) || rc=$?
left=$(docker exec "$P-dbsmall" psql -XAtq -U postgres -c "select count(*) from pg_stat_activity
  where backend_type = 'client backend' and pid <> pg_backend_pid()" 2>&1)
check 'E: a view whose refresh renames its session is stopped at the floor too (exit 8)' [ "$rc" = 8 ]; [ "$rc" = 8 ] || echo "$out" >&2
check 'E: no session of the stopped restore is left running' [ "$left" = 0 ]; [ "$left" = 0 ] || echo "sessions left: $left" >&2
check 'E: and that view is not there either' \
  [ "$(docker exec "$P-dbsmall" psql -XAtq -U postgres -c "select to_regclass('public.e_rename') is null" 2>&1)" = t ]
docker rm -f "$P-dbsmall" > /dev/null; docker volume rm -f "$P-small" > /dev/null
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
# (a psql stand-in: the job's own connections run with event triggers off, so an event trigger cannot block it)
JOB_ENV=(-e RESTORE_DIR=import/acme/v1-dump)
rc=0; out=$(job db "$P-storage" bash -c 'psql() { case "$*" in *"selfbase_restore_hold cascade"*) echo "blocked by the test" >&2; return 1 ;; esac
  command psql "$@"; }; export -f psql; bash /scripts/restore.sh' 2>&1) || rc=$?
check 'a v1 backup restores into a migrated database' [ "$rc" = 0 ]; [ "$rc" = 0 ] || echo "$out" >&2
check 'the ledger is gone from selfbase after a v1 restore' [ "$(sql db "select to_regclass('selfbase.platform_migrations') is null")" = t ]
check 'a hold that cannot be dropped is a warning naming it' grep -q 'left in schema selfbase_restore_hold' <<< "$out"
sql db "drop schema selfbase_restore_hold cascade" > /dev/null
migrate > /dev/null
check 'after core starts the ledger holds 0001...current' [ "$(ledger)" = "$current" ]
check 'the v1 user row is there' [ "$(sql db "select email from auth.users where id = '11111111-1111-1111-1111-111111111111'")" = v1@example.test ]
check 'the v1 storage file is there' docker run --rm -v "$P-storage:/s" "$IMAGE" bash -c \
  '[ "$(cat /s/stub/avatars/me.png)" = v1-file ] && [ ! -e /s/stub/b/v2.txt ]'

if [ "$fails" = 0 ]; then echo "# all passed"; else echo "# $fails failed" >&2; exit 1; fi
