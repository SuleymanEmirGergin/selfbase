#!/usr/bin/env bash
# One backup, run as a provisioner job (selfbase-job image, spec 8.8): control asks the provisioner for a `backup`
# job, which runs this in a one-off container on the project's network with
#   /backups        the host backup directory (BACKUP_HOST_DIR), read-write
#   /data/storage   the project's storage volume, read-only (absent for the control database)
#   PGHOST, PGPASSWORD (PGUSER, PGDATABASE default to postgres), BACKUP_SUBDIR (one or two path segments),
#   BACKUP_RETENTION_DAYS (default 7), MANIFEST_B64 (an export: base64 of project.json, sealed by control),
#   CONTROL_GID (an export: control's group, default 1000)
# Writes /backups/$BACKUP_SUBDIR/<YYYYMMDD-HHMMSS UTC>/{db.dump (pg_dump -Fc), globals.sql (roles, without
# passwords; for a disaster restore onto a fresh cluster only), storage.tar.gz, project.json (exports only),
# MANIFEST (file, size, sha256)}. BACKUP_SUBDIR=control backs up the control database: no storage archive.
# It is built in a .tmp-<ts> directory next to it and renamed when complete, so a directory with a timestamp name
# is always a whole backup. Backups in that subdirectory older than BACKUP_RETENTION_DAYS are deleted, never the
# one just written; exports are never pruned. The last stdout line is `backup: wrote <subdir>/<ts>` (control reads
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

[[ $keep =~ ^[0-9]+$ ]] || { echo "backup: BACKUP_RETENTION_DAYS must be a whole number of days" >&2; exit 2; }
files='db.dump globals.sql'
if [ "$sub" != control ]; then
  [ -d "$storage" ] || { echo "backup: storage directory $storage not mounted" >&2; exit 1; }
  files="$files storage.tar.gz"
fi
mkdir -p "$backups"
[ ! -e "$backups/$ts" ] || { echo "backup: $sub/$ts already exists" >&2; exit 1; }
# leftovers of killed runs (a running backup's temp dir is never a day old)
find "$backups" -mindepth 1 -maxdepth 1 -name '.tmp-*' -mmin +1440 -exec rm -rf {} +
mkdir "$tmp"
pg_dump -Fc -f "$tmp/db.dump"
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

# Retention by the name's timestamp; the backup just written (the newest) always stays. Exports (export-<ref>) are
# kept until an operator deletes them: an export is taken to be moved or imported, not rotated.
cutoff=$(date -u -d "-$keep days" +%Y%m%d-%H%M%S)
[[ $sub == export-* ]] && old='' || old=$(ls "$backups" | grep -E '^[0-9]{8}-[0-9]{6}$' || true)
for d in $old; do
  if [ "$d" != "$ts" ] && [[ $d < $cutoff ]]; then
    rm -rf "${backups:?}/$d"
    echo "backup: deleted $sub/$d (older than $keep days)"
  fi
done
echo "backup: size $(du -sb "$backups/$ts" | cut -f1) bytes"
echo "backup: wrote $sub/$ts"
