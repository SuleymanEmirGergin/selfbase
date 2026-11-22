#!/usr/bin/env bash
# Restores a backup made by backup.sh over the running stack. Run on the host:
#   scripts/restore.sh <YYYYMMDD-HHMMSS> --yes-overwrite
# Safe sequence:
#   1. verifies the backup's MANIFEST (sizes and sha256) inside the backup service; any mismatch, a
#      missing file or an unknown timestamp is refused before anything changes
#   2. without --yes-overwrite it stops here
#   3. `docker compose stop core rest fn`, so nothing writes to the database or storage during the restore
#   4. pg_restore --clean --if-exists --single-transaction: every object in the dump is dropped and
#      recreated in ONE transaction; a failure rolls back and the database stays as it was.
#      Objects created after the backup that the dump does not contain are not dropped.
#   5. the storage volume: the archive is extracted into a temp dir inside the volume, then swapped in
#      (files added after the backup are removed)
#   6. prints the command that starts the services again
# Uses plain `docker compose` from the repo root; for another stack set COMPOSE_PROJECT_NAME,
# COMPOSE_ENV_FILES (or COMPOSE_FILE) in the environment.
set -euo pipefail

if [ "${1:-}" = --inside ]; then # runs in the backup container: --inside verify|apply <ts>
  step=$2 ts=$3 dir=/backups/$3
  [ -f "$dir/MANIFEST" ] || { echo "restore: there is no backup $ts" >&2; exit 1; }
  [ "$(cut -d' ' -f1 "$dir/MANIFEST" | sort | tr '\n' ' ')" = 'db.dump storage.tar.gz ' ] ||
    { echo "restore: the MANIFEST of $ts does not list exactly db.dump and storage.tar.gz; refusing" >&2; exit 1; }
  while read -r f size sum; do
    if [ "$(stat -c %s "$dir/$f" 2>/dev/null)" != "$size" ] || [ "$(sha256sum < "$dir/$f" | cut -d' ' -f1)" != "$sum" ]; then
      echo "restore: $ts/$f does not match its MANIFEST (size or sha256); refusing" >&2
      exit 1
    fi
  done < "$dir/MANIFEST"
  echo "restore: $ts verified"
  [ "$step" = apply ] || exit 0
  pg_restore --clean --if-exists --single-transaction --exit-on-error -d "${PGDATABASE:-postgres}" "$dir/db.dump"
  echo "restore: database restored"
  t="/restore-storage/.restoring-$ts"
  rm -rf "$t"
  mkdir "$t"
  tar -xzf "$dir/storage.tar.gz" -C "$t"
  find /restore-storage -mindepth 1 -maxdepth 1 ! -name ".restoring-$ts" -exec rm -rf {} +
  find "$t" -mindepth 1 -maxdepth 1 -exec mv -t /restore-storage {} +
  rmdir "$t"
  echo "restore: storage restored"
  exit 0
fi

ts=${1:-}
[[ $ts =~ ^[0-9]{8}-[0-9]{6}$ ]] || { echo "usage: restore.sh <YYYYMMDD-HHMMSS> --yes-overwrite" >&2; exit 2; }
cd "$(dirname "$0")/.."
export MSYS_NO_PATHCONV=1 # keeps Git Bash on Windows from rewriting the container paths
docker compose run --rm --no-deps -T backup bash /scripts/restore.sh --inside verify "$ts"
[ "${2:-}" = --yes-overwrite ] ||
  { echo "restore: this overwrites the database and the storage files; run again with --yes-overwrite" >&2; exit 2; }

core=$(docker compose ps -aq core)
[ -n "$core" ] || { echo "restore: no core container; start the stack once (docker compose up -d)" >&2; exit 1; }
vol=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/data/storage"}}{{.Name}}{{end}}{{end}}' "$core")
[ -n "$vol" ] || { echo "restore: cannot find core's storage volume" >&2; exit 1; }

echo "restore: stopping core rest fn"
docker compose stop core rest fn
trap 'echo "restore: FAILED; core rest fn are stopped: docker compose start rest core fn" >&2' ERR
docker compose run --rm --no-deps -T -v "$vol:/restore-storage" backup bash /scripts/restore.sh --inside apply "$ts"
echo "restore: done; start the services again: docker compose start rest core fn"
