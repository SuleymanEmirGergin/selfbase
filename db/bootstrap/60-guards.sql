-- Query guards and queue upkeep. Existing databases get the same statements from db/upgrade/2026-11-22.sql.

-- Supabase's per-role statement timeouts: PostgREST applies the settings of the role it switches to.
-- core's asUser() switches roles with set_config inside a transaction, which does not apply them.
alter role anon set statement_timeout = '3s';
alter role authenticated set statement_timeout = '8s';

-- The netqueue worker scans pending rows every 30 s; finished rows are pruned after 7 days
create index if not exists http_queue_pending_idx on selfbase.http_queue (status) where status = 'pending';
