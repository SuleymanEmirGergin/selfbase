-- Brings a database created before 2026-11-22 up to the bootstrap of that release (db/bootstrap/60-guards.sql).
-- Idempotent: safe to run more than once. Run as postgres, e.g.
--   docker compose exec -T db psql -U postgres -d postgres -v ON_ERROR_STOP=1 < db/upgrade/2026-11-22.sql
-- then reload PostgREST so it reads the new role settings: docker compose restart rest

alter role anon set statement_timeout = '3s';
alter role authenticated set statement_timeout = '8s';

create index if not exists http_queue_pending_idx on selfbase.http_queue (status) where status = 'pending';
