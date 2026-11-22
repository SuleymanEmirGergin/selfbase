# The script is baked in: deploy tools such as Coolify do not put repository files behind relative bind mounts.
FROM postgres:17.12
COPY backup.sh restore.sh /scripts/
