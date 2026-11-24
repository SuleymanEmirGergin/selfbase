-- A hostname never moves to another organization (Codex 2): clients, integrations and OAuth callbacks that still
-- target a released name must never reach another tenant's project.
-- host_slots.org_id: the org a pool slot belongs to. Released, the slot keeps it (a tombstone): only that org reuses it.
-- A free slot whose org is unknown (released before this column) is never handed out again.
alter table control.host_slots add column if not exists org_id uuid;
update control.host_slots s set org_id = p.org_id from control.projects p where p.id = s.project_id and s.org_id is null;

-- issued_hosts.org_id: the org that claimed a custom (or unlisted legacy) name; released_at: when it last left a
-- project. Another org may claim it only 30 days after that (src/hosts.ts, DOMAIN_HOLD).
alter table control.issued_hosts add column if not exists org_id uuid;
alter table control.issued_hosts add column if not exists released_at timestamptz;
update control.issued_hosts i set org_id = p.org_id
  from control.project_domains d join control.projects p on p.id = d.project_id
 where d.hostname = i.hostname and i.org_id is null;
-- names no project holds now, of an unknown org: the hold starts with this migration
update control.issued_hosts set released_at = now() where org_id is null and released_at is null;
