# Debian 13 (trixie) base with current Postgres 17; pgvector and pg_cron come from PGDG.
# The schema is not baked in: core applies db/platform/*.sql at start (core/src/platform/migrate.ts).
# Build context is the repository root, like every other image.
FROM postgis/postgis:17-3.6@sha256:1ac10b2551ba84ae05db8e7da477afcd0a3fede99bcb7705da2ee157390cb095

RUN apt-get update \
 && apt-get install -y --no-install-recommends postgresql-17-pgvector postgresql-17-cron \
 && rm -rf /var/lib/apt/lists/*

CMD ["postgres", "-c", "shared_preload_libraries=pg_cron", "-c", "cron.database_name=postgres", "-c", "wal_level=logical"]
