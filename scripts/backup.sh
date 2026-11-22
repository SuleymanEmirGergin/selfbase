#!/usr/bin/env bash
# Runs inside the compose `backup` service (postgres:17; PG* env points at db, the storage volume is
# mounted read-only at /data/storage, BACKUP_DIR or the backups volume at /backups).
#   docker compose run --rm backup /scripts/backup.sh     one backup now
#   backup.sh --daily                                     the service's command: one backup a day at 03:15 UTC
# Writes /backups/<YYYYMMDD-HHMMSS UTC>/{db.dump (pg_dump -Fc of the whole database), globals.sql (roles,
# pg_dumpall --globals-only --no-role-passwords; for a disaster restore onto a fresh volume only),
# storage.tar.gz, MANIFEST (file, size, sha256)}. It is built in /backups/.tmp-<ts> and renamed when
# complete, so a directory with a timestamp name is always a whole backup. Backups older than
# BACKUP_RETENTION_DAYS (default 7) are deleted, never the one just written. Any failure: non-zero exit
# and a "backup: FAILED" line.
# shortcut: backups live on the same server, add off-site copy before production
set -euo pipefail

if [ "${1:-}" = --daily ]; then
  while :; do
    now=$(date -u +%s)
    next=$(date -u -d 'today 03:15' +%s)
    [ "$next" -gt "$now" ] || next=$(date -u -d 'tomorrow 03:15' +%s)
    echo "backup: next run $(date -u -d "@$next" '+%Y-%m-%d %H:%M') UTC"
    sleep $((next - now))
    bash "$0" || echo "backup: this run failed; next try tomorrow" >&2
  done
fi

backups=/backups
storage=/data/storage
keep=${BACKUP_RETENTION_DAYS:-7}
ts=$(date -u +%Y%m%d-%H%M%S)
tmp="$backups/.tmp-$ts"
trap 'rc=$?; [ $rc = 0 ] || { rm -rf "$tmp"; echo "backup: FAILED (exit $rc); no backup written for $ts" >&2; }' EXIT

[[ $keep =~ ^[0-9]+$ ]] || { echo "backup: BACKUP_RETENTION_DAYS must be a whole number of days" >&2; exit 2; }
[ -d "$storage" ] || { echo "backup: storage directory $storage not mounted" >&2; exit 1; }
[ ! -e "$backups/$ts" ] || { echo "backup: $backups/$ts already exists" >&2; exit 1; }
# leftovers of killed runs (a running backup's temp dir is never a day old)
find "$backups" -mindepth 1 -maxdepth 1 -name '.tmp-*' -mmin +1440 -exec rm -rf {} +
mkdir "$tmp"
pg_dump -Fc -f "$tmp/db.dump"
pg_dumpall --globals-only --no-role-passwords -f "$tmp/globals.sql"
# GNU tar exits 1 when a file changed while it was read (core kept writing); the archive is still
# usable, so only exit 2 and above fail the backup.
rc=0
tar -czf "$tmp/storage.tar.gz" -C "$storage" . || rc=$?
[ "$rc" -le 1 ] || exit "$rc"
[ "$rc" = 0 ] || echo "backup: WARNING: storage files changed while archiving; they are as tar read them" >&2
for f in db.dump globals.sql storage.tar.gz; do
  echo "$f $(stat -c %s "$tmp/$f") $(sha256sum "$tmp/$f" | cut -d' ' -f1)"
done > "$tmp/MANIFEST"
mv "$tmp" "$backups/$ts"
echo "backup: wrote $backups/$ts ($(du -sh "$backups/$ts" | cut -f1))"

# Retention by the name's timestamp; the backup just written (the newest) always stays.
cutoff=$(date -u -d "-$keep days" +%Y%m%d-%H%M%S)
for d in $(ls "$backups" | grep -E '^[0-9]{8}-[0-9]{6}$' || true); do
  if [ "$d" != "$ts" ] && [[ $d < $cutoff ]]; then
    rm -rf "${backups:?}/$d"
    echo "backup: deleted $d (older than $keep days)"
  fi
done
