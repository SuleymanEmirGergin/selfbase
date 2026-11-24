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
#      (a link, device or fifo), a name that is absolute or has a .. part, or a top-level .restoring-<its pid> (the
#      restore's own temp dir): an imported archive is foreign data. The .restoring-<n> dirs a restore killed outright
#      (SIGKILL) left in the volume are removed first (backup.sh leaves them out; core serves no bucket of such a name)
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
#      (step 1b admits a restore that leaves exactly the floor free) the writer is stopped (every session of the
#      cluster but this job's own is terminated, so pg_restore's one transaction rolls back), the temp dir removed, and
#      the restore ends with exit 6, nothing changed: what the server writes for the dump (a materialized view it
#      refreshes, an index it builds) is no line of the dump, so no estimate can bound it. A writer that exits 0 as it
#      is stopped had already finished (pg_restore committed): the restore goes on.
#      A signal (a job container stopped) ends the restore as a failure (exit 128 + its number): the writer is
#      stopped and reaped first, then the temp dir removed and the cron and ledger steps undone.
#      A stop that cannot show the sessions ended within 30 s (a termination that fails, sessions that keep coming,
#      a database it cannot reach) undoes nothing and claims no rollback: exit 8, the state is unknown (control then
#      stops the project's database as well)
#   2. cron: every active job is set inactive (committed) and running job sessions are terminated, so no job runs
#      during the restore; the restore brings back the backup's job states (on failure the jobs set inactive here
#      are set active again)
#   3. pg_restore --clean --if-exists --single-transaction --exit-on-error: every object in the dump is dropped and
#      recreated in ONE transaction; a failure rolls back and the database stays as it was (exit 10)
#   4. a dump whose table of contents has no selfbase.platform_migrations (a v1 database): the ledger the new
#      project's core created is moved aside before step 3 (it would keep --clean from dropping schema selfbase) and
#      dropped after it (moved back if step 3 fails), so core adopts the restored database at its next start and
#      applies 0002+
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
while read -r f size sum; do
  if [ "$(stat -c %s "$dir/$f" 2>/dev/null)" != "$size" ] || [ "$(sha256sum < "$dir/$f" | cut -d' ' -f1)" != "$sum" ]; then
    echo "restore: $rel/$f does not match its MANIFEST (size or sha256); refusing" >&2
    exit 1
  fi
done < "$dir/MANIFEST"
[ -d "$storage" ] || { echo "restore: storage directory $storage not mounted" >&2; exit 1; }
# the temp dirs of restores killed outright (SIGKILL runs no trap). Safe to remove: control's heavy lane has one
# worker, so no other restore (or backup) of this project runs now, and core serves no bucket named so
find "$storage" -mindepth 1 -maxdepth 1 -regextype posix-extended -regex '.*/\.restoring-[0-9]+' -exec rm -rf {} +
# the MANIFEST only proves the archive is the one listed, not that it is safe to extract as root (R4)
# numeric owners: a name with a space in it cannot shift the size column read in step 1b
listing=$(tar --numeric-owner -tvzf "$dir/storage.tar.gz") || { echo "restore: $rel/storage.tar.gz cannot be read; refusing" >&2; exit 1; }
types=$(cut -c1 <<< "$listing" | sort -u | tr -d '\n')
[[ $types =~ ^[-d]*$ ]] || { echo "restore: $rel/storage.tar.gz holds a link, device or fifo; refusing" >&2; exit 1; }
names=$(tar -tzf "$dir/storage.tar.gz")
! grep -qE '^/|(^|/)\.\.(/|$)' <<< "$names" ||
  { echo "restore: $rel/storage.tar.gz holds an absolute or .. path; refusing" >&2; exit 1; }
# the restore's temp dir in the volume is .restoring-<pid>: the archive never brings that one (the swap in step 5
# would move it onto the temp dir itself)
! grep -qE "^(\./+)*\.restoring-$$(/|\$)" <<< "$names" ||
  { echo "restore: $rel/storage.tar.gz holds .restoring-$$, the name of this restore's temp dir; refusing" >&2; exit 1; }
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
# A dump pg_restore cannot read counts as far as it got: the restore itself then fails and rolls back (exit 10).
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
# the cleanup's state (no function declares a local of these names: the trap runs in the scope of the function a
# signal stopped). db_done: pg_restore committed; swapped: the storage swap began; contained: no stop failed to show
# that the restore's sessions ended
jobs='' db_done=0 swapped=0 t='' held=0 w='' wstop='' wrc=0 contained=1
HOLD=selfbase_restore_hold
# committed: pg_restore exited 0, the database is the backup's; the cron and ledger steps are never undone over it
committed() { db_done=1 held=0 jobs='' contained=1; }
cleanup() {
  local rc=$?
  # a signal ended the script while a writer ran: it is stopped and reaped before its temp dir goes, so nothing writes
  # there after (reap records a pg_restore that still exited 0 as committed)
  [ -z "$w" ] || reap
  [ -z "$t" ] || rm -rf "$t"
  [ "$rc" != 0 ] || return 0
  if [ "$contained" = 0 ]; then
    echo "restore: STOPPED, STATE UNKNOWN (exit $rc): the sessions of the restore of $rel could not be shown to have ended, so its transaction may yet commit or roll back; nothing was undone; stop the project's database, then delete this project and import again" >&2
    exit 8
  fi
  if [ "$db_done" = 1 ] && [ "$swapped" = 1 ]; then
    echo "restore: FAILED in the storage step: the DATABASE WAS RESTORED from $rel, storage may be partly replaced; delete this project, then import again" >&2
    exit 3
  fi
  if [ "$db_done" = 1 ]; then
    echo "restore: FAILED after the DATABASE WAS RESTORED from $rel (exit $rc): the storage files were NOT replaced; the import is partial: delete this project, then import again" >&2
    exit 7
  fi
  if [ "$held" = 1 ]; then
    if q -c "alter table $HOLD.platform_migrations set schema selfbase; drop schema $HOLD"; then echo "restore: the platform ledger is back in place" >&2
    else echo "restore: could NOT move the platform ledger back; do it by hand: alter table $HOLD.platform_migrations set schema selfbase" >&2; fi
  fi
  if [ -n "$jobs" ]; then
    if q -c "update cron.job set active = true where jobid in ($jobs)"; then echo "restore: cron jobs $jobs set active again" >&2
    else echo "restore: could NOT set cron jobs $jobs active again; do it by hand: update cron.job set active = true where jobid in ($jobs)" >&2; fi
  fi
  [ "$rc" != 10 ] || echo "restore: FAILED: the database restore rolled back; the database and storage are unchanged" >&2
  [ "$rc" -lt 129 ] || echo "restore: STOPPED by a signal (exit $rc); the database and storage are unchanged" >&2
  exit "$rc"
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
# inodes every second; at the floor <stop> runs (empty: none), the writer's group is killed and the restore ends with
# exit 6. The cleanup trap then removes the temp dir and undoes the cron and ledger steps.
# reap: stops the running writer (its <stop> first: one that fails leaves the state unknown), kills its process group
# and waits for it; wrc: its exit status. A pg_restore that exited 0 had committed
reap() {
  [ -z "$wstop" ] || "$wstop" || contained=0
  kill -TERM -- "-$w" 2> /dev/null || kill -TERM "$w" 2> /dev/null || true
  wrc=0; wait "$w" 2> /dev/null || wrc=$?
  # 127: watched's own wait had already reaped it when the signal came, and its status is lost with it: a pg_restore
  # not yet recorded as committed may have committed
  [ "$wrc" != 127 ] || [ "$wstop" != stop_restore ] || [ "$db_done" = 1 ] || contained=0
  # recorded before w is cleared: a signal between the two finds the commit
  [ "$wrc" != 0 ] || [ "$wstop" != stop_restore ] || committed
  w=''
}
watched() {
  wstop=$1; shift
  setsid "$@" & w=$!
  while kill -0 "$w" 2> /dev/null; do
    if at_floor; then
      reap
      # a writer that exited 0 had finished before the stop reached it (pg_restore committed, as reap recorded)
      [ "$wrc" != 0 ] || return 0
      [ "$contained" = 1 ] || exit 8
      echo "restore: REFUSED: the volume of the project's data reached the floor; at least $((need / 1024)) MiB ($rule) and 10% of its inodes must stay free; the restore was stopped and rolled back, nothing was changed; free space first" >&2
      exit 6
    fi
    sleep 1
  done
  wrc=0; wait "$w" || wrc=$?
  # recorded before w is cleared: a signal from here on finds the commit (or, with w still set, the lost status above)
  [ "$wrc" != 0 ] || [ "$wstop" != stop_restore ] || committed
  w=''
  return "$wrc"
}
# pg_restore's server session: killing the client alone leaves a statement that sends nothing back (a REFRESH, an
# index build) running; terminated, its one transaction rolls back and its new files are removed. Every session of
# the cluster goes (client backends and background workers, in every database: the cluster is the project's alone),
# not one picked by name: the dump's own SQL can rename its session (application_name) or open another (dblink), and
# core, rest, fn and pooler are stopped. Done once a pass finds none; a pass that cannot run (no login), a
# termination that fails or a session still there after 30 s in all returns 1: the state is unknown
stop_restore() {
  local deadline=$((SECONDS + 30)) found
  while [ "$SECONDS" -lt "$deadline" ]; do
    # <sessions found>,<terminations that failed or did not end their session within 1 s>
    found=$(PGCONNECT_TIMEOUT=5 PGOPTIONS="$PGOPTIONS -c statement_timeout=10s" q -c "select pg_catalog.count(*) || ',' ||
        pg_catalog.count(*) filter (where not pg_catalog.pg_terminate_backend(pid, 1000)) from pg_catalog.pg_stat_activity
        where backend_type in ('client backend', 'background worker') and pid <> pg_catalog.pg_backend_pid()") || found=''
    [ "$found" != 0,0 ] || return 0
    sleep 1
  done
  echo "restore: WARNING: the sessions of the restore could not be shown to have ended within 30 s" >&2
  return 1
}
# 1c. the storage files, into a temp dir on the volume, before the database changes
t="$storage/.restoring-$$"
rm -rf "$t"
mkdir "$t"
watched '' tar --no-same-owner --no-same-permissions -xzf "$dir/storage.tar.gz" -C "$t" ||
  { echo "restore: $rel/storage.tar.gz could not be extracted; nothing was changed" >&2; exit 1; }
[ -z "$(find "$t" ! -type f ! -type d -print -quit)" ] ||
  { echo "restore: the extracted storage holds something other than files and directories; nothing was changed" >&2; exit 1; }
jobs=$(q -c "select case when pg_catalog.to_regclass('cron.job') is null then '' else (select coalesce(pg_catalog.string_agg(jobid::text, ','), '')
  from (select jobid from cron.job where active) j) end")
if [ -n "$jobs" ]; then
  q -c "update cron.job set active = false where jobid in ($jobs)"
  echo "restore: cron jobs $jobs set inactive for the restore"
fi
q -c "select pg_catalog.pg_terminate_backend(pid) from pg_catalog.pg_stat_activity
      where (application_name = 'pg_cron' or backend_type = 'pg_cron') and pid <> pg_catalog.pg_backend_pid()" > /dev/null
# read before the restore: a TOC that cannot be listed is a dump that cannot be restored either
toc=$(pg_restore -l "$dir/db.dump") || exit 10
v1=0
grep -qE ' TABLE selfbase platform_migrations ' <<< "$toc" || v1=1
if [ "$v1" = 1 ] && [ "$(q -c "select pg_catalog.to_regclass('selfbase.platform_migrations') is not null")" = t ]; then
  q -c "create schema if not exists $HOLD; alter table selfbase.platform_migrations set schema $HOLD"
  held=1
fi
watched stop_restore pg_restore --clean --if-exists --single-transaction --exit-on-error \
  -d "${PGDATABASE:-postgres}" "$dir/db.dump" || exit 10
# from here a failure or a signal is exit 7 (3 once the swap began), never an undo
committed
if [ "$v1" = 1 ]; then
  # the v1 restore is committed (held is 0 since): the old ledger never goes back over it
  if q -c "drop schema if exists $HOLD cascade"; then
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
find "$storage" -mindepth 1 -maxdepth 1 ! -name ".restoring-$$" -exec rm -rf {} +
find "$t" -mindepth 1 -maxdepth 1 -exec mv -t "$storage" {} +
echo "restore: storage restored"
