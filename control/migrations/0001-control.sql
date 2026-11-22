-- control-db schema (spec section 9). Applied by control at start (src/db.ts), one transaction with its ledger row.
-- Dashboard users are core's auth.users (core's platform migrations run first).
create schema control;

create table control.organizations (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  created_at timestamptz not null default now()
);

create table control.nodes (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  docker_endpoint text not null,
  advertise_addr text,
  proxy_mode text not null default 'coolify' check (proxy_mode in ('coolify', 'own')),
  proxy_network text not null,
  memory_budget_mb integer not null check (memory_budget_mb > 0)
);

create table control.projects (
  id uuid primary key default gen_random_uuid(),
  ref text not null unique check (ref ~ '^[a-z]{20}$'),
  org_id uuid not null references control.organizations (id),
  name text not null,
  -- Supabase's names: COMING_UP, ACTIVE_HEALTHY, INACTIVE, RESTORING, UPGRADING, REMOVED, ...
  status text not null,
  size text not null check (size in ('micro', 'small', 'medium')),
  node_id uuid references control.nodes (id),
  template_version text,
  subnet cidr not null unique,
  parent_project_id uuid references control.projects (id),
  branch_name text,
  git_branch text,
  persistent boolean not null default true,
  ha_enabled boolean not null default false,
  pitr_enabled boolean not null default false,
  db_port integer,
  pooler_port integer,
  disk_limit_mb integer,
  paused_at timestamptz,
  last_activity_at timestamptz,
  created_at timestamptz not null default now()
);

create table control.memberships (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references control.organizations (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null check (role in ('owner', 'administrator', 'developer', 'read_only')),
  -- set: the role applies to this project only
  project_id uuid references control.projects (id) on delete cascade,
  created_at timestamptz not null default now(),
  -- an org-wide membership has project_id null; two of those for one user are a duplicate too
  unique nulls not distinct (org_id, user_id, project_id)
);

create table control.invitations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references control.organizations (id) on delete cascade,
  email text not null,
  role text not null check (role in ('owner', 'administrator', 'developer', 'read_only')),
  token_hash text not null unique,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table control.access_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  token_hash text not null unique,
  last_used_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz not null default now()
);

create table control.project_domains (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references control.projects (id) on delete cascade,
  hostname text not null unique,
  kind text not null check (kind in ('default', 'custom', 'legacy'))
);

-- a row with null project_id is a free, already-certified host (spec 7.3)
create table control.host_slots (
  id uuid primary key default gen_random_uuid(),
  hostname text not null unique,
  pool text not null check (pool in ('project', 'branch', 'test')),
  project_id uuid references control.projects (id) on delete set null,
  first_issued_at timestamptz
);

-- AES-256-GCM (src/secrets.ts): ciphertext has the 16-byte tag appended; AAD is '<ref>:<name>'
create table control.project_secrets (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references control.projects (id) on delete cascade,
  name text not null,
  kind text not null check (kind in ('platform', 'function')),
  ciphertext bytea not null,
  nonce bytea not null check (length(nonce) = 12),
  key_version integer not null,
  updated_at timestamptz not null default now(),
  unique (project_id, name)
);

-- non-secret values only
create table control.project_config (
  project_id uuid not null references control.projects (id) on delete cascade,
  section text not null check (section in ('auth', 'postgrest', 'storage', 'realtime', 'database', 'pooler', 'functions')),
  data jsonb not null default '{}',
  version integer not null default 1,
  updated_by uuid,
  updated_at timestamptz not null default now(),
  primary key (project_id, section)
);

create table control.api_keys (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references control.projects (id) on delete cascade,
  type text not null check (type in ('legacy_anon', 'legacy_service_role', 'publishable', 'secret')),
  name text not null,
  prefix text not null,
  hash text not null unique,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

-- source lives in the project's volume
create table control.functions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references control.projects (id) on delete cascade,
  slug text not null,
  version integer not null default 1,
  verify_jwt boolean not null default true,
  entrypoint text,
  import_map text,
  sha256 text,
  status text not null,
  updated_at timestamptz not null default now(),
  unique (project_id, slug)
);

create table control.backups (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references control.projects (id) on delete cascade,
  kind text not null check (kind in ('logical', 'physical')),
  status text not null,
  started_at timestamptz,
  finished_at timestamptz,
  size_bytes bigint,
  location text,
  lsn pg_lsn
);

-- payload never contains secret values, only their names
create table control.jobs (
  id uuid primary key default gen_random_uuid(),
  type text not null,
  project_id uuid references control.projects (id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'running', 'succeeded', 'failed')),
  lane text not null check (lane in ('light', 'heavy')),
  step text,
  payload jsonb not null default '{}',
  error text,
  attempts integer not null default 0,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on control.jobs (status, lane, created_at);

create table control.job_events (
  id bigint generated always as identity primary key,
  job_id uuid not null references control.jobs (id) on delete cascade,
  at timestamptz not null default now(),
  status text,
  step text,
  message text
);
create index on control.job_events (job_id, id);

create table control.snippets (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references control.projects (id) on delete cascade,
  owner_id uuid not null,
  name text not null,
  sql text not null default '',
  visibility text not null default 'user' check (visibility in ('user', 'project', 'org')),
  updated_at timestamptz not null default now()
);

-- every write through /v1 and /platform; no foreign keys, so rows outlive what they name
create table control.audit_log (
  id bigint generated always as identity primary key,
  actor text not null,
  org_id uuid,
  project_id uuid,
  action text not null,
  target text,
  ip text,
  at timestamptz not null default now(),
  details jsonb not null default '{}'
);
create index on control.audit_log (at);

-- keys this wave: current_template_version, control_host_first_issued_at
create table control.settings (
  key text primary key,
  value text not null
);
