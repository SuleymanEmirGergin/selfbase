-- Custom and legacy hostnames outside the operator's LEGACY_HOSTNAMES also reach the proxy with the certificate
-- resolver: each counts toward MAX_NEW_HOSTS_PER_WEEK when first added. The row stays after the domain is removed
-- (the certificate was ordered), so removing and adding again never hides an issue from the cap.
create table if not exists control.issued_hosts (
  hostname text primary key,
  first_issued_at timestamptz not null default now()
);
-- names added before this table existed hold their certificates already: recorded, outside any week
insert into control.issued_hosts (hostname, first_issued_at)
  select hostname, timestamptz '2000-01-01' from control.project_domains where kind <> 'default'
on conflict do nothing;
