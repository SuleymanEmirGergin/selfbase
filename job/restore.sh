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
#      (a link, device or fifo) or a name that is absolute or has a .. part: an imported archive is foreign data
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
#   5. the storage volume: the archive is extracted into a temp dir inside the volume (owner: the volume's, modes from
#      the umask, never the archive's), checked again for anything but files and directories, then swapped in (a
#      failure here, after the database was restored: exit 3)
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
# the MANIFEST only proves the archive is the one listed, not that it is safe to extract as root (R4)
types=$(tar -tvzf "$dir/storage.tar.gz" | cut -c1 | sort -u | tr -d '\n') || { echo "restore: $rel/storage.tar.gz cannot be read; refusing" >&2; exit 1; }
[[ $types =~ ^[-d]*$ ]] || { echo "restore: $rel/storage.tar.gz holds a link, device or fifo; refusing" >&2; exit 1; }
names=$(tar -tzf "$dir/storage.tar.gz")
! grep -qE '^/|(^|/)\.\.(/|$)' <<< "$names" ||
  { echo "restore: $rel/storage.tar.gz holds an absolute or .. path; refusing" >&2; exit 1; }
echo "restore: $rel verified"

q() { psql -XAtq -v ON_ERROR_STOP=1 "$@"; }
jobs='' db_done=0 t='' held=0
HOLD=selfbase_restore_hold
cleanup() {
  local rc=$?
  [ -z "$t" ] || rm -rf "$t"
  [ "$rc" != 0 ] || return 0
  if [ "$db_done" = 1 ]; then
    echo "restore: FAILED in the storage step: the DATABASE WAS RESTORED from $rel, storage may be partly replaced; delete this project, then import again" >&2
    exit 3
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
  exit "$rc"
}
trap cleanup EXIT
jobs=$(q -c "select case when to_regclass('cron.job') is null then '' else (select coalesce(string_agg(jobid::text, ','), '')
  from (select jobid from cron.job where active) j) end")
if [ -n "$jobs" ]; then
  q -c "update cron.job set active = false where jobid in ($jobs)"
  echo "restore: cron jobs $jobs set inactive for the restore"
fi
q -c "select pg_terminate_backend(pid) from pg_stat_activity
      where (application_name = 'pg_cron' or backend_type = 'pg_cron') and pid <> pg_backend_pid()" > /dev/null
# read before the restore: a TOC that cannot be listed is a dump that cannot be restored either
toc=$(pg_restore -l "$dir/db.dump") || exit 10
v1=0
grep -qE ' TABLE selfbase platform_migrations ' <<< "$toc" || v1=1
if [ "$v1" = 1 ] && [ "$(q -c "select to_regclass('selfbase.platform_migrations') is not null")" = t ]; then
  q -c "create schema if not exists $HOLD; alter table selfbase.platform_migrations set schema $HOLD"
  held=1
fi
pg_restore --clean --if-exists --single-transaction --exit-on-error -d "${PGDATABASE:-postgres}" "$dir/db.dump" || exit 10
if [ "$v1" = 1 ]; then
  # the v1 restore is committed: from here the old ledger must never go back over it
  held=0
  if q -c "drop schema if exists $HOLD cascade"; then
    echo "restore: a v1 database: the platform ledger is dropped, core adopts it at its next start"
  else
    echo "restore: WARNING: the old platform ledger is left in schema $HOLD; the restore itself succeeded and core adopts"       "the database at its next start; drop it by hand: drop schema $HOLD cascade" >&2
  fi
fi
if [ "$rotate" = 1 ]; then
  # step 3 is committed: the cleanup trap must neither undo the cron or ledger steps nor call this a storage failure
  # every credential row (sessions, pending links and codes); users, identities and MFA factors are the data moved
  # then counted in a second statement, after the delete committed: a trigger returning NULL, a DO INSTEAD rule or a
  # deferred constraint trigger re-inserting at COMMIT (all of which the dump can carry) would undo it unseen
  creds="array['refresh_tokens', 'sessions', 'mfa_amr_claims', 'one_time_tokens', 'flow_state', 'mfa_challenges',
    'saml_relay_states', 'oauth_authorizations']"
  { q -c "do \$\$ declare t text; begin
      foreach t in array $creds loop
        if to_regclass('auth.' || t) is not null then execute format('delete from auth.%I', t); end if;
      end loop;
    end \$\$" &&
    q -c "do \$\$ declare t text; remains boolean; begin
      foreach t in array $creds loop
        if to_regclass('auth.' || t) is not null then
          execute format('select exists (select 1 from auth.%I)', t) into remains;
          if remains then raise exception 'auth.% still has rows after the delete', t; end if;
        end if;
      end loop;
    end \$\$"; } || { trap - EXIT
    echo "restore: FAILED: the DATABASE WAS RESTORED from $rel but its sessions could not be deleted (ROTATE_KEYS); delete this project, then import again" >&2
    exit 5; }
  echo "restore: the restored sessions are deleted (ROTATE_KEYS)"
fi
db_done=1
echo "restore: database restored (cron jobs as in the backup)"
t="$storage/.restoring-$$"
rm -rf "$t"
mkdir "$t"
tar --no-same-owner --no-same-permissions -xzf "$dir/storage.tar.gz" -C "$t"
[ -z "$(find "$t" ! -type f ! -type d -print -quit)" ] || { echo "restore: the extracted storage holds something other than files and directories" >&2; exit 3; }
# core (not root) owns its storage: everything restored belongs to the volume's owner, as core wrote it
chown -R "$(stat -c %u:%g "$storage")" "$t"
find "$storage" -mindepth 1 -maxdepth 1 ! -name ".restoring-$$" -exec rm -rf {} +
find "$t" -mindepth 1 -maxdepth 1 -exec mv -t "$storage" {} +
echo "restore: storage restored"
