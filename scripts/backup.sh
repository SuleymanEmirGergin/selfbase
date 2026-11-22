#!/usr/bin/env bash
# Runs inside the compose `backup` service (postgres:17; PG* env points at db, the storage volume is
# mounted read-only at /data/storage, BACKUP_DIR or the backups volume at /backups).
#   docker compose run --rm backup /scripts/backup.sh     one backup now
#   backup.sh --daily                                     the service's command: one backup a day at 03:15 UTC
# Writes /backups/<YYYYMMDD-HHMMSS UTC>/{db.dump (pg_dump -Fc of the whole database), storage.tar.gz,
# MANIFEST (file, size, sha256)}. It is built in /backups/.tmp-<ts> and renamed when complete, so a
# directory with a timestamp name is always a whole backup. Backups older than BACKUP_RETENTION_DAYS
# (default 7) are deleted, never the newest one. Any failure: non-zero exit and a "backup: FAILED" line.
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
mkdir "$tmp"
pg_dump -Fc -f "$tmp/db.dump"
tar -czf "$tmp/storage.tar.gz" -C "$storage" .
for f in db.dump storage.tar.gz; do
  echo "$f $(stat -c %s "$tmp/$f") $(sha256sum "$tmp/$f" | cut -d' ' -f1)"
done > "$tmp/MANIFEST"
mv "$tmp" "$backups/$ts"
echo "backup: wrote $backups/$ts ($(du -sh "$backups/$ts" | cut -f1))"

# Retention by the name's timestamp; only complete backups (with a MANIFEST) count, the newest always stays.
cutoff=$(date -u -d "-$keep days" +%Y%m%d-%H%M%S)
newest=$(ls "$backups" | grep -E '^[0-9]{8}-[0-9]{6}$' | while read -r d; do [ -f "$backups/$d/MANIFEST" ] && echo "$d"; done | sort | tail -n 1)
for d in $(ls "$backups" | grep -E '^[0-9]{8}-[0-9]{6}$'); do
  if [ "$d" != "$newest" ] && [[ $d < $cutoff ]]; then
    rm -rf "${backups:?}/$d"
    echo "backup: deleted $d (older than $keep days)"
  fi
done
