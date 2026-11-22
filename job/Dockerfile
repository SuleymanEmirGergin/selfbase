# Build context is the repository root. The scripts are baked in: deploy tools such as Coolify do not put
# repository files behind relative bind mounts.
FROM postgres:17.12
COPY job/backup.sh job/restore.sh /scripts/
