# Notes

## Idle RAM (Task 1, 2026-11-22)

`docker compose up -d` locally, all four services healthy, `docker stats --no-stream` right after start:

| service | memory |
|---|---|
| db (Postgres 17 + PostGIS + pgvector + pg_cron) | 76.4 MiB |
| core (Node 24, empty routers) | 37.3 MiB |
| fn (placeholder Deno) | 15.4 MiB |
| rest (PostgREST 14.1) | 13.3 MiB |
| **total** | **~142 MiB** (target ≤ 1.5 GB) |

No data loaded yet; re-measure after the dev DB copy and the real function host.
