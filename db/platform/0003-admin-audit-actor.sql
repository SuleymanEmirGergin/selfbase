-- Who made an admin write: the x-selfbase-actor header control sends (a dashboard user's email), default 'control'.
-- Rows written before this migration have no actor. Idempotent.

alter table selfbase.admin_audit add column if not exists actor text;
