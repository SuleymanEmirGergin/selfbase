# The provisioner's job image (selfbase-job): backup.sh and restore.sh, run one at a time in one-off containers.
# Build context is the repository root. The scripts are baked in: deploy tools such as Coolify do not put
# repository files behind relative bind mounts.
FROM postgres:17.12
ENV PGUSER=postgres
COPY job/backup.sh job/restore.sh /scripts/
