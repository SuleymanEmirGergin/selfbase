FROM postgis/postgis:17-3.5

# The base image is bullseye; PGDG moved bullseye to its archive host.
RUN sed -i 's#apt.postgresql.org/pub/repos/apt/#apt-archive.postgresql.org/pub/repos/apt/#' /etc/apt/sources.list.d/pgdg.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends postgresql-17-pgvector postgresql-17-cron \
 && rm -rf /var/lib/apt/lists/*

COPY bootstrap/ /docker-entrypoint-initdb.d/

CMD ["postgres", "-c", "shared_preload_libraries=pg_cron", "-c", "cron.database_name=postgres", "-c", "wal_level=logical"]
