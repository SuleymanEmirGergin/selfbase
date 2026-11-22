#!/usr/bin/env bash
# Fixture backup job: succeeds when the fixed backup directory is mounted. BACKUP_SUBDIR=slow keeps it running.
set -euo pipefail
if [ "${BACKUP_SUBDIR:-}" = slow ]; then sleep 5; fi
test -d /backups
echo "backup fixture done"
