-- Admin panel audit log: one row per admin write and per SQL runner execution
create table selfbase.admin_audit (
  id bigserial primary key,
  at timestamptz not null default now(),
  action text not null,
  target text,
  detail jsonb
);
-- only the database owner (core's superuser pool) reads or writes it
revoke all on selfbase.admin_audit from public;
