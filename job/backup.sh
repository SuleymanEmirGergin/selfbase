#!/usr/bin/env bash
# One backup, run as a provisioner job (selfbase-job image, spec 8.8): control asks the provisioner for a `backup`
# job, which runs this in a one-off container on the project's network with
#   /backups        the host backup directory (BACKUP_HOST_DIR), read-write
#   /data/storage   the project's storage volume, read-only (absent for the control database)
#   PGHOST, PGPASSWORD (PGUSER, PGDATABASE default to postgres), BACKUP_SUBDIR (one or two path segments),
#   BACKUP_RETENTION_DAYS (default 7), EXPORT_RETENTION_DAYS (export-<ref>, default 7), BACKUP_MAX_COUNT (per
#   subdirectory, default 14), MANIFEST_B64 (an export: base64 of project.json, sealed by control),
#   CONTROL_GID (an export: control's group, default 1000)
# The provisioner mounts only /backups/$BACKUP_SUBDIR (R5). The run is refused (exit 4, nothing written) when the
# backup volume would keep less than 10% or 5 GiB free, whichever is larger, after this backup (sized at its start
# from the database and the storage files): one project must never fill the shared disk.
# BACKUP_MIN_FREE_MIB (the provisioner's node setting, never a request's) replaces that floor, e.g. on a small test disk.
# Writes /backups/$BACKUP_SUBDIR/<YYYYMMDD-HHMMSS UTC>/{db.dump (pg_dump -Fc), globals.sql (roles, without
# passwords; for a disaster restore onto a fresh cluster only), storage.tar.gz, project.json (exports only),
# MANIFEST (file, size, sha256)}. BACKUP_SUBDIR=control backs up the control database: no storage archive.
# It is built in a .tmp-<ts> directory next to it and renamed when complete, so a directory with a timestamp name
# is always a whole backup. Backups in that subdirectory older than BACKUP_RETENTION_DAYS (exports:
# EXPORT_RETENTION_DAYS) or beyond the newest BACKUP_MAX_COUNT are deleted, never the one just written. The last stdout line is `backup: wrote <subdir>/<ts>` (control reads
# it, and the size line before it). Any failure: non-zero exit and a "backup: FAILED" line. Never prints a value from the environment.
# shortcut: backups live on the same server, add off-site copy before production
set -euo pipefail
umask 077 # the dump holds every row and the auth password hashes: owner-only files and directories

sub=${BACKUP_SUBDIR:?BACKUP_SUBDIR is required}
[[ $sub =~ ^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)?$ ]] && [[ ! /$sub/ =~ /\.\.?/ ]] ||
  { echo "backup: BACKUP_SUBDIR must be one or two plain path segments" >&2; exit 2; }
backups=/backups/$sub
storage=/data/storage
keep=${BACKUP_RETENTION_DAYS:-7}
ts=$(date -u +%Y%m%d-%H%M%S)
tmp="$backups/.tmp-$ts"
trap 'rc=$?; [ $rc = 0 ] || { rm -rf "$tmp"; echo "backup: FAILED (exit $rc); no backup written for $sub/$ts" >&2; }' EXIT

export_keep=${EXPORT_RETENTION_DAYS:-7}
max=${BACKUP_MAX_COUNT:-14}
[[ $keep =~ ^[0-9]+$ && $export_keep =~ ^[0-9]+$ ]] || { echo "backup: BACKUP_RETENTION_DAYS and EXPORT_RETENTION_DAYS must be whole numbers of days" >&2; exit 2; }
[[ $max =~ ^[1-9][0-9]*$ ]] || { echo "backup: BACKUP_MAX_COUNT must be a whole number from 1" >&2; exit 2; }
min_free=${BACKUP_MIN_FREE_MIB:-}
[[ -z $min_free || $min_free =~ ^[1-9][0-9]{0,7}$ ]] || { echo "backup: BACKUP_MIN_FREE_MIB must be a whole number of MiB from 1" >&2; exit 2; }
files='db.dump globals.sql'
if [ "$sub" != control ]; then
  [ -d "$storage" ] || { echo "backup: storage directory $storage not mounted" >&2; exit 1; }
  files="$files storage.tar.gz"
fi
mkdir -p "$backups"
# Docker creates the bind mount's directory 0755; owner-only as mkdir under the umask made it before (R5)
[[ $sub == export-* ]] || chmod 0700 "$backups"
# KiB: the volume's size and what is free on it
read -r total avail < <(df -Pk "$backups" | awk 'NR == 2 { print $2, $4 }')
if [ -n "$min_free" ]; then need=$((min_free * 1024)) rule=BACKUP_MIN_FREE_MIB
else need=$(( total / 10 > 5242880 ? total / 10 : 5242880 )) rule='10% or 5 GiB, whichever is larger'; fi
# what this backup will write, at most: the database as postgres stores it (the dump is smaller) and the storage
# files as they are on disk, measured here and now (control's check before queueing is an early refusal only)
db_bytes=$(psql -XAtq -v ON_ERROR_STOP=1 -c 'select pg_database_size(current_database())')
[[ $db_bytes =~ ^[0-9]+$ ]] || { echo "backup: the database size could not be read" >&2; exit 1; }
est=$((db_bytes / 1024))
[ "$sub" = control ] || est=$((est + $(du -sk "$storage" | cut -f1)))
[ $((avail - est)) -ge "$need" ] || { echo "backup: REFUSED: $((avail / 1024)) MiB free on the backup volume, at least $((need / 1024)) MiB ($rule) needed after this backup of up to $((est / 1024)) MiB; free space first" >&2; exit 4; }
[ ! -e "$backups/$ts" ] || { echo "backup: $sub/$ts already exists" >&2; exit 1; }
# leftovers of killed runs (a running backup's temp dir is never a day old)
find "$backups" -mindepth 1 -maxdepth 1 -name '.tmp-*' -mmin +1440 -exec rm -rf {} +
mkdir "$tmp"
# mail_log holds sign-in and recovery links in clear when SMTP is off: its rows never enter a backup
pg_dump -Fc --exclude-table-data=selfbase.mail_log -f "$tmp/db.dump"
pg_dumpall --globals-only --no-role-passwords -f "$tmp/globals.sql"
if [ "$sub" != control ]; then
  # GNU tar exits 1 when a file changed while it was read (core kept writing); the archive is still
  # usable, so only exit 2 and above fail the backup.
  rc=0
  tar -czf "$tmp/storage.tar.gz" -C "$storage" . || rc=$?
  [ "$rc" -le 1 ] || exit "$rc"
  [ "$rc" = 0 ] || echo "backup: WARNING: storage files changed while archiving; they are as tar read them" >&2
fi
if [ -n "${MANIFEST_B64:-}" ]; then
  base64 -d <<< "$MANIFEST_B64" > "$tmp/project.json"
  files="$files project.json"
  # control (not root, read-only mount) reads project.json for an import: its group (CONTROL_GID) may enter the
  # directories and read the manifest, nobody else; the dump and storage stay owner-only
  [[ ${CONTROL_GID:=1000} =~ ^[0-9]+$ ]] || { echo "backup: CONTROL_GID must be a numeric group id" >&2; exit 2; }
  chgrp "$CONTROL_GID" "$backups" "$tmp" "$tmp/project.json"
  chmod 0750 "$backups" "$tmp"
  chmod 0640 "$tmp/project.json"
fi
for f in $files; do
  echo "$f $(stat -c %s "$tmp/$f") $(sha256sum "$tmp/$f" | cut -d' ' -f1)"
done > "$tmp/MANIFEST"
mv "$tmp" "$backups/$ts"

# Retention by the name's timestamp, then by count (newest first); the backup just written always stays. Exports
# (export-<ref>) too, by EXPORT_RETENTION_DAYS: an export is taken to be moved or imported within days (R3).
[[ $sub == export-* ]] && days=$export_keep || days=$keep
cutoff=$(date -u -d "-$days days" +%Y%m%d-%H%M%S)
n=0
for d in $(ls "$backups" | grep -E '^[0-9]{8}-[0-9]{6}$' | sort -r || true); do
  n=$((n + 1))
  [ "$d" != "$ts" ] || continue
  if [[ $d < $cutoff ]]; then why="older than $days days"
  elif [ "$n" -gt "$max" ]; then why="beyond the newest $max"
  else continue; fi
  rm -rf "${backups:?}/$d"
  echo "backup: deleted $sub/$d ($why)"
done
echo "backup: size $(du -sb "$backups/$ts" | cut -f1) bytes"
echo "backup: wrote $sub/$ts"
