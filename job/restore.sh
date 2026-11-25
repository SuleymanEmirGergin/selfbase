#!/usr/bin/env bash
# Restores a backup made by backup.sh (v2) or by v1's backup service, run as a provisioner job (selfbase-job image):
# control stops the project's core, rest, fn and pooler, then asks the provisioner for a `restore` job, which runs
# this in a one-off container on the project's network with
#   /backups/$RESTORE_DIR  that one backup, read-only (the provisioner mounts nothing else of BACKUP_HOST_DIR)
#   /data/storage   the project's storage volume, read-write
#   PGHOST, PGPASSWORD (PGUSER, PGDATABASE default to postgres), RESTORE_DIR (under /backups: <ref>/<ts>,
#                   export-<ref>/<ts>, or import/<org slug>/<name> for a v1 or foreign dump an operator placed there),
#                   ROTATE_KEYS (1: an import with new keys, step 4b)
# Sequence:
#   1. verifies the backup's MANIFEST (sizes and sha256); a missing or unlisted file or any mismatch is refused
#      before anything changes (exit 1); so is a storage archive holding anything but plain files and directories
#      (a link, device or fifo), a name that is absolute or has a .. part, or a top-level \restoring-* (the form of
#      the restore's temp dir): an imported archive is foreign data. The \restoring-<pid> dirs a restore killed
#      outright (SIGKILL) left in the volume are removed first; backup.sh leaves them out. No bucket can be named so:
#      core refuses a backslash in a key
#   1b. adds up what the restore will write (the archive's files and the parent directories it implies, at least a
#      block and an inode each, an estimate of the dump once restored) and refuses before anything changes (exit 6)
#      when that would leave less than the floor free on the volume of the project's data (the floor:
#      BACKUP_MIN_FREE_MIB, the provisioner's node setting, else 10% or 5 GiB, whichever is larger), or less than 10%
#      of its inodes: a dump that expands without bound must not fill the disk other projects share. The estimate is
#      an early refusal only: the watchdog below is the bound
#   1c. the storage archive is extracted into a temp dir inside the volume (owner: the volume's, modes from the umask,
#      never the archive's) and checked again for anything but files and directories; a failure here changed nothing
#      (exit 1; the temp dir is removed)
#   watchdog: while tar (1c) and pg_restore (3) run, the free space and inodes are read every second; below the floor
#      (step 1b admits a restore that leaves exactly the floor free) the writer is stopped (for pg_restore every session
#      of the cluster but this job's own is terminated first) and its process group killed: what the server writes for
#      the dump (a materialized view it refreshes, an index it builds) is no line of the dump, so no estimate can bound
#      it. A floor stop of the extraction ends with exit 6, nothing changed; one of pg_restore is exit 8 (below). A
#      writer that exits 0 as it is stopped had already finished (pg_restore committed): the restore goes on.
#      A signal (a job container stopped) ends the restore as a failure (exit 128 + its number): the writer is
#      stopped and reaped first, then (before pg_restore started) the cron and ledger steps are undone and the temp
#      dir removed
#   exit 8, state unknown: once pg_restore has started, every outcome but its recorded success (it exited 0) leaves
#      the database holding the whole backup, part of it, or none of it (the dump's own SQL can commit before it
#      fails), and nothing here can tell which (no sample of its sessions shows a rollback), so no repair SQL runs on
#      it (the cron and ledger steps stay as they are) and control stops the project's database as well. Its sessions
#      are still terminated (containment); a stop that cannot show they ended (a termination that fails, sessions that
#      keep coming, a database it cannot reach) says so
#   the cleanup's deadline: 40 s for all of it from the first floor stop or the cleanup's start, under the
#      container's 60 s stop timeout (a signal waits for the command in the foreground first: a psql here is killed
#      after 16 s, 17 s at most with its KILL): the stop of pg_restore's sessions runs until 20 s are left, the
#      writer's whole process group gets TERM, then KILL 5 s later while any of it is left; every psql has 5 s to
#      connect, 10 s for its transaction (one bound for a call of two statements) and a wall-clock bound of 16 s, or
#      the time left before the deadline (a server that stops answering does not hold it). A step that finds no time
#      left is skipped: an undo skipped is exit 8 (said, with the SQL to run by hand); a temp dir left is removed by
#      the next restore
#   2. cron: every active job is set inactive (committed) and running job sessions are terminated, so no job runs
#      during the restore; the restore brings back the backup's job states (on a failure before pg_restore starts the
#      jobs set inactive here are set active again)
#   3. pg_restore --clean --if-exists --single-transaction --exit-on-error: every object in the dump is dropped and
#      recreated in ONE transaction; any failure from its start is exit 8 (above). A dump whose table of contents
#      cannot be read fails before it, nothing restored (exit 10)
#   4. a dump whose table of contents has no selfbase.platform_migrations (a v1 database): the ledger the new
#      project's core created is moved aside before step 3 (it would keep --clean from dropping schema selfbase) and
#      dropped after it (moved back on a failure before step 3 starts), so core adopts the restored database at its
#      next start and applies 0002+
#   4b. ROTATE_KEYS=1: every row of auth.refresh_tokens, auth.sessions, auth.one_time_tokens and the GoTrue tables a
#      foreign dump may hold (mfa_amr_claims, flow_state, mfa_challenges, saml_relay_states, oauth_authorizations;
#      where the dump has them) is deleted right
#      after step 3 commits, while core, rest, fn and pooler are still stopped, so no session the backup carried ever
#      meets a core signing with the new keys. pg_restore owns step 3's transaction, so this is the next one; when it
#      fails the job fails (exit 5) and control does not start the project
#   the commit: once pg_restore exits 0 the database is restored, and nothing after undoes the cron or ledger steps
#      or says it is unchanged; a failure or signal from there until the storage swap starts ends with exit 7 (the
#      database restored, the storage not replaced: the import is partial)
#   5. the storage volume: the files extracted in 1c are given to the volume's owner and swapped in (a failure here,
#      after the database was restored: exit 3)
# What it does NOT do: objects created after the backup are not removed; roles are not restored (globals.sql is for
# a disaster restore onto a fresh cluster); the services are started again by control. Never prints a value from
# the environment.
set -euo pipefail

rel=${RESTORE_DIR:?RESTORE_DIR is required}
[[ $rel =~ ^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)?$ || $rel =~ ^import/[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]] && [[ ! /$rel/ =~ /\.\.?/ ]] ||
  { echo "restore: RESTORE_DIR must be one or two plain path segments, or import/<a>/<b>" >&2; exit 2; }
dir=/backups/$rel
rotate=${ROTATE_KEYS:-0}
[[ $rotate =~ ^[01]$ ]] || { echo "restore: ROTATE_KEYS must be 0 or 1" >&2; exit 2; }
storage=/data/storage

[ -f "$dir/MANIFEST" ] || { echo "restore: there is no backup $rel (no MANIFEST)" >&2; exit 1; }
listed=$(cut -d' ' -f1 "$dir/MANIFEST" | sort | tr '\n' ' ')
for f in db.dump storage.tar.gz; do
  [[ " $listed" == *" $f "* ]] || { echo "restore: the MANIFEST of $rel does not list $f; refusing" >&2; exit 1; }
done
for f in $listed; do
  case $f in db.dump | globals.sql | storage.tar.gz | project.json) ;; *)
    echo "restore: the MANIFEST of $rel lists an unknown file; refusing" >&2; exit 1 ;;
  esac
done
# || [ -n "$f" ]: a last line without a newline is checked too (read returns 1 on it)
while read -r f size sum || [ -n "$f" ]; do
  if [ "$(stat -c %s "$dir/$f" 2>/dev/null)" != "$size" ] || [ "$(sha256sum < "$dir/$f" | cut -d' ' -f1)" != "$sum" ]; then
    echo "restore: $rel/$f does not match its MANIFEST (size or sha256); refusing" >&2
    exit 1
  fi
done < "$dir/MANIFEST"
[ -d "$storage" ] || { echo "restore: storage directory $storage not mounted" >&2; exit 1; }
# the temp dirs of restores killed outright (SIGKILL runs no trap). Safe to remove: control's heavy lane has one
# worker, so no other restore (or backup) of this project runs now, and no bucket has a backslash in its name
find "$storage" -mindepth 1 -maxdepth 1 -name '\\restoring-*' -exec rm -rf {} +
# the MANIFEST only proves the archive is the one listed, not that it is safe to extract as root (R4)
# numeric owners: a name with a space in it cannot shift the size column read in step 1b
listing=$(tar --numeric-owner -tvzf "$dir/storage.tar.gz") || { echo "restore: $rel/storage.tar.gz cannot be read; refusing" >&2; exit 1; }
types=$(cut -c1 <<< "$listing" | sort -u | tr -d '\n')
[[ $types =~ ^[-d]*$ ]] || { echo "restore: $rel/storage.tar.gz holds a link, device or fifo; refusing" >&2; exit 1; }
names=$(tar -tzf "$dir/storage.tar.gz")
! grep -qE '^/|(^|/)\.\.(/|$)' <<< "$names" ||
  { echo "restore: $rel/storage.tar.gz holds an absolute or .. path; refusing" >&2; exit 1; }
# the restore's temp dir in the volume is \restoring-<pid>: the archive never brings that form at its top (the swap
# in step 5 would move one onto the temp dir itself). tar -t prints a backslash as \\
! grep -qE '^(\./+)*\\\\restoring-' <<< "$names" ||
  { echo "restore: $rel/storage.tar.gz holds a \\restoring-* name at its top, the form of this restore's temp dir; refusing" >&2; exit 1; }
echo "restore: $rel verified"

# 1b. The room on the volume of the project's data, in KiB. The job sees only the storage volume; the database's
# volume is taken to be on the same filesystem (Docker volumes on one disk), so both are counted against it.
min_free=${BACKUP_MIN_FREE_MIB:-}
[[ -z $min_free || $min_free =~ ^[1-9][0-9]{0,7}$ ]] || { echo "restore: BACKUP_MIN_FREE_MIB must be a whole number of MiB from 1" >&2; exit 2; }
read -r total avail < <(df -Pk "$storage" | awk 'NR == 2 { print $2, $4 }')
if [ -n "$min_free" ]; then need=$((min_free * 1024)) rule=BACKUP_MIN_FREE_MIB
else need=$(( total / 10 > 5242880 ? total / 10 : 5242880 )) rule='10% or 5 GiB, whichever is larger'; fi
room=$((avail - need))
refused() { # <about|more than> <KiB>
  echo "restore: REFUSED: $((avail / 1024)) MiB free on the volume of the project's data, at least $((need / 1024)) MiB ($rule) needed after this restore of $1 $(($2 / 1024)) MiB; free space first" >&2
  exit 6
}
# the storage files: the listing's sizes are what tar writes (only plain files and directories pass above), each
# rounded up to 4 KiB blocks and at least one block, so a million empty files or directories count too
storage_k=$(LC_ALL=C awk 'NF == 0 { next } $3 !~ /^[0-9]+$/ { bad = 1 } { b = int(($3 + 4095) / 4096) * 4; k += b < 4 ? 4 : b }
  END { if (bad) print "bad"; else printf "%.0f\n", k }' <<< "$listing")
[[ $storage_k =~ ^[0-9]{1,18}$ ]] || { echo "restore: the sizes in $rel/storage.tar.gz cannot be read; refusing" >&2; exit 1; }
# tar makes every parent directory a name has, listed or not: each path the extraction makes, once (names
# normalised: ./, //, /./ and a trailing / do not make another), and the directories among them the archive leaves
# out, a block each on top of the listing's
read -r entries implied < <(LC_ALL=C awk '{ p = $0; gsub(/\/+/, "/", p); while (sub(/^\.\//, "", p)) ; while (sub(/\/\.\//, "/", p)) ;
    sub(/\/\.?$/, "", p); if (p == "" || p == ".") next
    listed[p] = 1; while (p != "" && !(p in seen)) { seen[p] = 1; n++; if (!sub(/\/[^\/]*$/, "", p)) break } }
  END { for (p in seen) if (!(p in listed)) m++; print n + 0, m + 0 }' <<< "$names")
storage_k=$((storage_k + implied * 4))
[ "$storage_k" -le "$room" ] || refused about "$storage_k"
# and each path takes an inode: 10% of the volume's inodes stay free (a filesystem without a fixed count reports 0)
read -r itotal ifree < <(df -Pi "$storage" | awk 'NR == 2 { print $2, $4 }')
if [[ $itotal =~ ^[1-9][0-9]{0,17}$ && $ifree =~ ^[0-9]{1,18}$ ]] && [ $((ifree - entries)) -lt $((itotal / 10)) ]; then
  echo "restore: REFUSED: $ifree inodes free on the volume of the project's data, this restore makes $entries entries and $((itotal / 10)) (10%) must stay free; free inodes first" >&2
  exit 6
fi
# the database: the dump's SQL as pg_restore would send it, decompressed and counted here, never written. On disk a
# row takes its text plus about 24 bytes of tuple header: bytes + 33 per line, once (x1). The factor was 2 (for the
# indexes) and over-refused restores that fit by 2 to 6 times; it can be low because the watchdog below is the bound,
# and this estimate only refuses early, before anything changes, a dump that cannot fit at all.
# Counting stops once the estimate passes the room, so a decompression bomb costs no more than the room.
# A dump pg_restore cannot read counts as far as it got: its table of contents is read again before step 3 (exit 10
# when it cannot be), and a failure in step 3 itself is exit 8.
db_k=$(pg_restore -f - "$dir/db.dump" 2> /dev/null | LC_ALL=C awk -v lim=$(( (room - storage_k) * 1024 )) '
  { b += length($0) + 33 } b > lim { over = 1; exit } END { if (over) print "over"; else printf "%.0f\n", b / 1024 }') || true
[ "$db_k" != over ] || refused 'more than' "$room"
[[ $db_k =~ ^[0-9]{1,18}$ ]] || { echo "restore: the size of $rel/db.dump cannot be estimated; refusing" >&2; exit 1; }
echo "restore: about $(( (storage_k + db_k) / 1024 )) MiB to write, $((room / 1024)) MiB free above the floor"

# psql resolves names in pg_catalog only, whatever search_path the role or database sets (a shadowing
# public.to_regclass would hide the tables the ROTATE_KEYS step deletes), and its calls are qualified as well.
# pg_restore keeps the default: extension scripts it runs (postgis_tiger_geocoder) need it.
# Every connection of this job (psql and pg_restore) runs with event triggers off (Postgres 17, superuser only): a
# login trigger the project's superuser made runs after the startup options and could set search_path back (a
# public || then hides the ROTATE_KEYS tables), and a ddl trigger could block or alter the restore's own steps.
export PGOPTIONS='-c event_triggers=off'
q() { PGOPTIONS="$PGOPTIONS -c search_path=pg_catalog" psql -XAtq -v ON_ERROR_STOP=1 "$@"; }
# qt: q in bounded time: every query a signal may have to wait for (bash runs a trap once the command in the
# foreground ends) and every one the cleanup runs. 5 s to connect and 10 s for its statements together (a lock they
# wait for included) are the server's bounds; timeout kills psql after 16 s, or 1 s before the cleanup's deadline,
# whatever the server does (a dead connection, a server that stops answering). psql runs in a bash -c so a psql
# function the environment exports (the tests' stand-ins) still applies
qt() {
  local n=16
  [ -z "$deadline" ] || [ $((deadline - SECONDS - 1)) -ge 16 ] || n=$((deadline - SECONDS - 1))
  [ "$n" -ge 1 ] || return 1
  PGCONNECT_TIMEOUT=5 PGOPTIONS="$PGOPTIONS -c search_path=pg_catalog -c statement_timeout=10s -c transaction_timeout=10s" \
    timeout -k 1 "$n" bash -c 'psql -XAtq -v ON_ERROR_STOP=1 "$@"' qt "$@"
}
# the cleanup's state (no function declares a local of these names: the trap runs in the scope of the function a
# signal stopped). db_done: pg_restore committed; swapped: the storage swap began; started: pg_restore started (from
# then on only db_done is known); contained: no stop failed to show that the restore's sessions ended; deadline: the
# end of the cleanup's 40 s, set by the first floor stop or the cleanup; spent: an undo found no time left
jobs='' db_done=0 swapped=0 t='' held=0 w='' wstop='' wrc=0 contained=1 started=0 deadline='' spent=0
HOLD=selfbase_restore_hold
# committed: pg_restore exited 0, the database is the backup's; the cron and ledger steps are never undone over it
committed() { db_done=1 held=0 jobs='' contained=1; }
# ends <pid or -group> <by>: waits for the background <pid> (or every process of the group) until it ends or SECONDS
# reaches <by>; 1 when it still runs then
ends() { while kill -0 -- "$1" 2> /dev/null; do [ "$SECONDS" -lt "$2" ] || return 1; sleep 0.2; done; }
# undo <done> <not done> <sql>: a step made before pg_restore started, undone when 16 s of the deadline are left (a
# qt and a margin); one skipped (spent) or failed is said, with its SQL to run by hand
undo() {
  if [ $((deadline - SECONDS)) -lt 16 ]; then spent=1; echo "restore: could NOT $2 (no time left); do it by hand: $3" >&2
  elif qt -c "$3"; then echo "restore: $1" >&2
  else echo "restore: could NOT $2; do it by hand: $3" >&2; fi
}
cleanup() {
  local rc=$? code r
  # the cleanup runs to its end, within its deadline: a second signal would end it halfway (temp dir left, nothing said)
  trap '' HUP INT TERM
  [ -n "$deadline" ] || deadline=$((SECONDS + 40))
  # a signal ended the script while a writer ran: it is stopped and reaped before its temp dir goes, so nothing writes
  # there after (reap records a pg_restore that still exited 0 as committed)
  [ -z "$w" ] || reap
  code=$rc
  if [ "$rc" = 0 ]; then :
  elif [ "$db_done" = 1 ] && [ "$swapped" = 1 ]; then code=3
    echo "restore: FAILED in the storage step: the DATABASE WAS RESTORED from $rel, storage may be partly replaced; delete this project, then import again" >&2
  elif [ "$db_done" = 1 ]; then code=7
    echo "restore: FAILED after the DATABASE WAS RESTORED from $rel (exit $rc): the storage files were NOT replaced; the import is partial: delete this project, then import again" >&2
  elif [ "$started" = 1 ]; then code=8
    echo "restore: STOPPED, STATE UNKNOWN (exit $rc): pg_restore of $rel started and did not finish, so the database may hold the whole backup, part of it, or none of it$([ "$contained" = 1 ] || echo ", and its sessions could NOT be shown to have ended"); no repair SQL was run on it$([ -z "$jobs" ] || echo " (cron jobs $jobs stay inactive)")$([ "$held" = 0 ] || echo " (the platform ledger stays in schema $HOLD)"); stop the project's database, then delete this project and import again" >&2
  else
    # before pg_restore started: what the cron and ledger steps did is undone
    [ "$held" = 0 ] || undo 'the platform ledger is back in place' 'move the platform ledger back' \
      "alter table if exists $HOLD.platform_migrations set schema selfbase; drop schema if exists $HOLD"
    [ -z "$jobs" ] || undo "cron jobs $jobs set active again" "set cron jobs $jobs active again" \
      "update cron.job set active = true where jobid in ($jobs)"
    if [ "$spent" = 1 ]; then code=8
      echo "restore: STOPPED, STATE UNKNOWN (exit $rc): the cleanup ran out of time before it undid what is named above (pg_restore never started)" >&2
    elif [ "$rc" -ge 129 ]; then
      echo "restore: STOPPED by a signal (exit $rc) before pg_restore started: nothing was restored" >&2
    fi
  fi
  # the temp dir, in the time left (one left behind is removed by the next restore, step 1)
  if [ -n "$t" ]; then
    rm -rf "$t" & r=$!
    ends "$r" "$deadline" || { kill -KILL "$r" 2> /dev/null || true; echo "restore: no time left to remove $t; the next restore removes it" >&2; }
  fi
  exit "$code"
}
trap cleanup EXIT
# a signal is a failure the cleanup sees (bash runs the EXIT trap on one with $? of the last command, often 0)
trap 'exit 129' HUP; trap 'exit 130' INT; trap 'exit 143' TERM
# at_floor: the volume is below the floor, in space or (where it counts them) in inodes: 10% of them. Step 1b admits
# a restore that leaves exactly the floor free, so exactly at it is not below
at_floor() {
  local fs_inodes fs_ifree
  [ "$(df -Pk "$storage" | awk 'NR == 2 { print $4 }')" -ge "$need" ] || return 0
  read -r fs_inodes fs_ifree < <(df -Pi "$storage" | awk 'NR == 2 { print $2, $4 }')
  [[ $fs_inodes =~ ^[1-9][0-9]{0,17}$ && $fs_ifree =~ ^[0-9]{1,18}$ ]] && [ "$fs_ifree" -lt $((fs_inodes / 10)) ]
}
# watched <stop> <writer...>: runs the writer in a process group of its own (setsid) and reads the free space and
# inodes every second; at the floor (the cleanup's deadline starts there) the writer is reaped and the restore ends:
# exit 6 for the extraction, nothing changed; exit 8 for pg_restore, which had started (the cleanup says so)
# reap: stops the running writer (its <stop> first, unless one already failed: a second would only take the time
# the rest needs), sends its process group TERM, then KILL 5 s later (2 s before the deadline at the latest) while any
# process of the group is left (a child can outlive its leader and write on), and waits for the group until the
# deadline; wrc: the leader's exit status (137 when the group is still there then). A pg_restore that exited 0 had
# committed
reap() {
  [ -z "$wstop" ] || [ "$contained" = 0 ] || "$wstop" || contained=0
  kill -TERM -- "-$w" 2> /dev/null || kill -TERM "$w" 2> /dev/null || true
  ends "-$w" $((SECONDS + 5 < deadline - 2 ? SECONDS + 5 : deadline - 2)) ||
    kill -KILL -- "-$w" 2> /dev/null || kill -KILL "$w" 2> /dev/null || true
  wrc=137
  ! ends "-$w" "$deadline" || { wrc=0; wait "$w" 2> /dev/null || wrc=$?; }
  # recorded before w is cleared: a signal between the two finds the commit
  [ "$wrc" != 0 ] || [ "$wstop" != stop_restore ] || committed
  w=''
}
watched() {
  wstop=$1; shift
  setsid "$@" & w=$!
  while kill -0 "$w" 2> /dev/null; do
    if at_floor; then
      deadline=$((SECONDS + 40))
      reap
      # a writer that exited 0 had finished before the stop reached it (pg_restore committed, as reap recorded)
      [ "$wrc" != 0 ] || return 0
      if [ "$wstop" = stop_restore ]; then
        echo "restore: STOPPED: the volume of the project's data reached the floor while pg_restore ran; at least $((need / 1024)) MiB ($rule) and 10% of its inodes must stay free; free space first" >&2
        exit 8
      fi
      echo "restore: REFUSED: the volume of the project's data reached the floor; at least $((need / 1024)) MiB ($rule) and 10% of its inodes must stay free; the extraction was stopped before the database changed, nothing was changed; free space first" >&2
      exit 6
    fi
    sleep 1
  done
  wrc=0; wait "$w" || wrc=$?
  # recorded before w is cleared: a signal from here on finds the commit
  [ "$wrc" != 0 ] || [ "$wstop" != stop_restore ] || committed
  # what its leader left running of the group writes no more (the swap moves the temp dir's files next)
  kill -KILL -- "-$w" 2> /dev/null || true
  w=''
  return "$wrc"
}
# pg_restore's server session: killing the client alone leaves a statement that sends nothing back (a REFRESH, an
# index build) running and writing; terminated, its one transaction rolls back and its new files are removed. This is
# containment only: what the database then holds is not known (exit 8). Every session of the cluster goes (client
# backends and walsenders, which a replication=database connection makes and which run SQL too, in every database: the
# cluster is the project's alone), not one picked by name: the dump's own SQL can rename its session
# (application_name) or open another (dblink), and core, rest, fn and pooler are stopped. Not every backend type: the
# launchers (autovacuum, logical replication, pg_cron) only restart. Background workers an extension starts are out
# of scope here (wave 2 quotas). Done once a pass finds none; a pass that cannot run (no login), a termination that
# fails or a session still there when 20 s of the deadline are left returns 1. One deadline covers a stop a signal
# interrupted and the cleanup's stop after it
stop_restore() {
  local found
  while [ "$SECONDS" -lt $((deadline - 20)) ]; do
    # <sessions found>,<terminations that failed or did not end their session within 1 s>
    found=$(qt -c "select pg_catalog.count(*) || ',' ||
        pg_catalog.count(*) filter (where not pg_catalog.pg_terminate_backend(pid, 1000)) from pg_catalog.pg_stat_activity
        where backend_type in ('client backend', 'walsender') and pid <> pg_catalog.pg_backend_pid()") || found=x
    [ "$found" != 0,0 ] || return 0
    sleep 1
  done
  echo "restore: WARNING: the sessions of the restore could not be shown to have ended in the time the stop has" >&2
  return 1
}
# 1c. the storage files, into a temp dir on the volume, before the database changes
# a backslash: no bucket can be named so (core refuses one in a key), so this name is the restore's alone
t="$storage/\\restoring-$$"
rm -rf "$t"
mkdir "$t"
# --no-unquote: GNU tar reads a backslash in a name it is given (-C too) as an escape
watched '' tar --no-same-owner --no-same-permissions --no-unquote -xzf "$dir/storage.tar.gz" -C "$t" ||
  { echo "restore: $rel/storage.tar.gz could not be extracted; nothing was changed" >&2; exit 1; }
[ -z "$(find "$t" ! -type f ! -type d -print -quit)" ] ||
  { echo "restore: the extracted storage holds something other than files and directories; nothing was changed" >&2; exit 1; }
jobs=$(qt -c "select case when pg_catalog.to_regclass('cron.job') is null then '' else (select coalesce(pg_catalog.string_agg(jobid::text, ','), '')
  from (select jobid from cron.job where active) j) end")
if [ -n "$jobs" ]; then
  qt -c "update cron.job set active = false where jobid in ($jobs)"
  echo "restore: cron jobs $jobs set inactive for the restore"
fi
qt -c "select pg_catalog.pg_terminate_backend(pid) from pg_catalog.pg_stat_activity
      where (application_name = 'pg_cron' or backend_type = 'pg_cron') and pid <> pg_catalog.pg_backend_pid()" > /dev/null
# read before the restore: a TOC that cannot be listed is a dump that cannot be restored either
toc=$(pg_restore -l "$dir/db.dump") ||
  { echo "restore: FAILED: the table of contents of $rel/db.dump cannot be read; nothing was restored" >&2; exit 10; }
v1=0
grep -qE ' TABLE selfbase platform_migrations ' <<< "$toc" || v1=1
if [ "$v1" = 1 ] && [ "$(qt -c "select pg_catalog.to_regclass('selfbase.platform_migrations') is not null")" = t ]; then
  # held first: a failure or signal as the move commits still finds it (the undo's "if exists" covers one that did not)
  held=1
  qt -c "create schema if not exists $HOLD; alter table selfbase.platform_migrations set schema $HOLD"
fi
# from here every outcome but pg_restore's exit 0 is exit 8, state unknown, and nothing is undone
started=1
watched stop_restore pg_restore --clean --if-exists --single-transaction --exit-on-error \
  -d "${PGDATABASE:-postgres}" "$dir/db.dump" || exit 8
# from here a failure or a signal is exit 7 (3 once the swap began), never an undo
committed
if [ "$v1" = 1 ]; then
  # the v1 restore is committed (held is 0 since): the old ledger never goes back over it
  if qt -c "drop schema if exists $HOLD cascade"; then
    echo "restore: a v1 database: the platform ledger is dropped, core adopts it at its next start"
  else
    echo "restore: WARNING: the old platform ledger is left in schema $HOLD; the restore itself succeeded and core adopts"       "the database at its next start; drop it by hand: drop schema $HOLD cascade" >&2
  fi
fi
if [ "$rotate" = 1 ]; then
  # step 3 is committed: a failure here is exit 5, not one of the storage step (the trap is off)
  # every credential row (sessions, pending links and codes); users, identities and MFA factors are the data moved
  # then counted in a second statement, after the delete committed: a trigger returning NULL, a DO INSTEAD rule or a
  # deferred constraint trigger re-inserting at COMMIT (all of which the dump can carry) would undo it unseen
  creds="array['refresh_tokens', 'sessions', 'mfa_amr_claims', 'one_time_tokens', 'flow_state', 'mfa_challenges',
    'saml_relay_states', 'oauth_authorizations']"
  { q -c "do \$\$ declare t text; begin
      foreach t in array $creds loop
        if pg_catalog.to_regclass('auth.' || t) is not null then execute pg_catalog.format('delete from auth.%I', t); end if;
      end loop;
    end \$\$" &&
    q -c "do \$\$ declare t text; remains boolean; begin
      foreach t in array $creds loop
        if pg_catalog.to_regclass('auth.' || t) is not null then
          execute pg_catalog.format('select exists (select 1 from auth.%I)', t) into remains;
          if remains then raise exception 'auth.% still has rows after the delete', t; end if;
        end if;
      end loop;
    end \$\$"; } || { trap - EXIT; rm -rf "$t"
    echo "restore: FAILED: the DATABASE WAS RESTORED from $rel but its sessions could not be deleted (ROTATE_KEYS); delete this project, then import again" >&2
    exit 5; }
  echo "restore: the restored sessions are deleted (ROTATE_KEYS)"
fi
echo "restore: database restored (cron jobs as in the backup)"
# 5. core (not root) owns its storage: everything restored belongs to the volume's owner, as core wrote it
chown -R "$(stat -c %u:%g "$storage")" "$t"
swapped=1
find "$storage" -mindepth 1 -maxdepth 1 ! -samefile "$t" -exec rm -rf {} +
find "$t" -mindepth 1 -maxdepth 1 -exec mv -t "$storage" {} +
echo "restore: storage restored"
