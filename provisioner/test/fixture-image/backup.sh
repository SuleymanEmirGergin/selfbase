#!/usr/bin/env bash
# Fixture backup job: succeeds when its own backup directory is mounted, and says what else it can see under
# /backups (R5: nothing). BACKUP_SUBDIR=export-* keeps it running for a while.
set -euo pipefail
if [[ ${BACKUP_SUBDIR:-} == export-* ]]; then sleep 5; fi
test -d "/backups/$BACKUP_SUBDIR"
echo "backup fixture sees: $(ls -A /backups | tr '\n' ' ')"
echo "backup fixture done"
