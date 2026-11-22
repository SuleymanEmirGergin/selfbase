-- Platform migration 0001: the v1 bootstrap (v1's db/bootstrap/*.sql), concatenated in order.
-- A v1 database already has all of this and is stamped 0001 without running it (core/src/platform/migrate.ts).

-- ==== 00-roles.sql ====

-- API roles (PostgREST / Supabase convention)
create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;

-- PostgREST connects as authenticator and switches to the role in the JWT.
-- No password here: core sets it from AUTHENTICATOR_PASSWORD at every start (setRolePassword).
create role authenticator login noinherit;
grant anon, authenticated, service_role to authenticator;

-- Supabase-owned role names, kept so grants in dumps and migrations do not fail
create role supabase_admin nologin;
create role supabase_auth_admin nologin;
create role supabase_storage_admin nologin;
create role dashboard_user nologin;

-- Supabase default: API roles get all privileges in public, RLS decides rows
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;

-- ==== 01-extensions.sql ====

-- Supabase-compatible schemas
create schema extensions;
create schema auth;
create schema storage;
create schema net;
create schema vault;
create schema selfbase;

grant usage on schema extensions to anon, authenticated, service_role;

create extension if not exists pgcrypto with schema extensions;
create extension if not exists "uuid-ossp" with schema extensions;
create extension if not exists pg_trgm with schema extensions;
create extension if not exists unaccent with schema extensions;
create extension if not exists vector with schema extensions;
create extension if not exists postgis with schema extensions;
create extension if not exists pg_cron; -- lives in its own "cron" schema

-- Unqualified calls (gen_random_bytes, uuid_generate_v4, similarity, ...) resolve like on Supabase
alter database postgres set search_path to "$user", public, extensions;

-- ==== 02-auth.sql ====

-- GoTrue-compatible auth tables (column names match Supabase so dumps and migrations apply unchanged)

create table auth.users (
  instance_id uuid,
  id uuid primary key default gen_random_uuid(),
  aud varchar(255),
  role varchar(255),
  email varchar(255),
  encrypted_password varchar(255),
  email_confirmed_at timestamptz,
  invited_at timestamptz,
  confirmation_token varchar(255),
  confirmation_sent_at timestamptz,
  recovery_token varchar(255),
  recovery_sent_at timestamptz,
  email_change_token_new varchar(255),
  email_change varchar(255),
  email_change_sent_at timestamptz,
  last_sign_in_at timestamptz,
  raw_app_meta_data jsonb,
  raw_user_meta_data jsonb,
  is_super_admin boolean,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  phone text unique default null,
  phone_confirmed_at timestamptz,
  phone_change text default '',
  phone_change_token varchar(255) default '',
  phone_change_sent_at timestamptz,
  confirmed_at timestamptz generated always as (least(email_confirmed_at, phone_confirmed_at)) stored,
  email_change_token_current varchar(255) default '',
  email_change_confirm_status smallint default 0 check (email_change_confirm_status between 0 and 2),
  banned_until timestamptz,
  reauthentication_token varchar(255) default '',
  reauthentication_sent_at timestamptz,
  is_sso_user boolean not null default false,
  deleted_at timestamptz,
  is_anonymous boolean not null default false
);
create unique index users_email_partial_key on auth.users (email) where is_sso_user = false;

create table auth.identities (
  id uuid primary key default gen_random_uuid(),
  provider_id text not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  identity_data jsonb not null,
  provider text not null,
  last_sign_in_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  email text generated always as (lower(identity_data ->> 'email')) stored,
  unique (provider_id, provider)
);
create index identities_user_id_idx on auth.identities (user_id);

create table auth.refresh_tokens (
  instance_id uuid,
  id bigserial primary key,
  token text unique,
  user_id uuid references auth.users (id) on delete cascade,
  session_id uuid,
  revoked boolean not null default false,
  parent text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index refresh_tokens_session_id_idx on auth.refresh_tokens (session_id);
create index refresh_tokens_parent_idx on auth.refresh_tokens (parent);

create table auth.one_time_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  token_type text not null,
  token_hash text not null check (char_length(token_hash) > 0),
  relates_to text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index one_time_tokens_token_hash_idx on auth.one_time_tokens using hash (token_hash);

-- JWT helpers: read the claims PostgREST (and core's asUser) put in request.jwt.claims
create function auth.jwt() returns jsonb language sql stable as $$
  select nullif(current_setting('request.jwt.claims', true), '')::jsonb
$$;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub', '')::uuid
$$;
create function auth.role() returns text language sql stable as $$
  select nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'
$$;
create function auth.email() returns text language sql stable as $$
  select nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email'
$$;

-- Policies call auth.*(); the tables themselves stay private to postgres
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.jwt(), auth.uid(), auth.role(), auth.email() to anon, authenticated, service_role;

-- ==== 03-storage.sql ====

-- Supabase Storage-compatible metadata tables; files live on disk under STORAGE_DIR

create table storage.buckets (
  id text primary key,
  name text not null unique,
  owner uuid,
  owner_id text,
  public boolean not null default false,
  file_size_limit bigint,
  allowed_mime_types text[],
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets (id),
  name text,
  owner uuid,
  owner_id text,
  metadata jsonb,
  path_tokens text[] generated always as (string_to_array(name, '/')) stored,
  version text,
  user_metadata jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  last_accessed_at timestamptz default now(),
  unique (bucket_id, name)
);

alter table storage.buckets enable row level security;
alter table storage.objects enable row level security;

-- Path helpers used in storage policies, e.g. (storage.foldername(name))[1] = auth.uid()::text
create function storage.foldername(name text) returns text[] language sql immutable as $$
  select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1]
$$;
create function storage.filename(name text) returns text language sql immutable as $$
  select (string_to_array(name, '/'))[array_length(string_to_array(name, '/'), 1)]
$$;
create function storage.extension(name text) returns text language sql immutable as $$
  select reverse(split_part(reverse(storage.filename(name)), '.', 1))
$$;

grant usage on schema storage to anon, authenticated, service_role;
grant all on storage.buckets, storage.objects to anon, authenticated, service_role;
grant execute on function storage.foldername(text), storage.filename(text), storage.extension(text)
  to anon, authenticated, service_role;

-- ==== 04-shims.sql ====

-- pg_net and supabase_vault stand-ins

-- net.http_* only queue the request; core's netqueue worker sends it
create table selfbase.http_queue (
  id bigserial primary key,
  method text not null,
  url text not null,
  headers jsonb not null default '{}',
  body jsonb,
  status text not null default 'pending',
  attempts int not null default 0,
  last_error text,
  created_at timestamptz not null default now()
);

create function selfbase.enqueue_http(method text, url text, params jsonb, headers jsonb, body jsonb)
returns bigint language plpgsql security definer set search_path = '' as $$
declare
  qs text;
  new_id bigint;
begin
  -- shortcut: params appended without percent-encoding; known callers pass none
  select string_agg(key || '=' || value, '&') into qs from jsonb_each_text(coalesce(params, '{}'));
  if qs is not null then
    url := url || case when position('?' in url) > 0 then '&' else '?' end || qs;
  end if;
  insert into selfbase.http_queue (method, url, headers, body)
  values (method, url, coalesce(headers, '{}'), body)
  returning id into new_id;
  perform pg_notify('selfbase_http', new_id::text);
  return new_id;
exception when others then
  -- pg_net never raises into the caller (triggers rely on that)
  raise warning 'net.http_% enqueue failed: %', lower(method), sqlerrm;
  return null;
end
$$;
revoke all on function selfbase.enqueue_http(text, text, jsonb, jsonb, jsonb) from public;

create function net.http_post(
  url text,
  body jsonb default '{}',
  params jsonb default '{}',
  headers jsonb default '{}',
  timeout_milliseconds int default 5000
) returns bigint language sql security definer set search_path = '' as $$
  select selfbase.enqueue_http('POST', url, params, headers, body)
$$;

create function net.http_get(
  url text,
  params jsonb default '{}',
  headers jsonb default '{}',
  timeout_milliseconds int default 5000
) returns bigint language sql security definer set search_path = '' as $$
  select selfbase.enqueue_http('GET', url, params, headers, null)
$$;

grant usage on schema net to anon, authenticated, service_role;
grant execute on function net.http_post(text, jsonb, jsonb, jsonb, int), net.http_get(text, jsonb, jsonb, int)
  to anon, authenticated, service_role;

-- shortcut: secrets stored plaintext, upgrade to pgcrypto with a key from env before production
create table vault.secrets (
  id uuid primary key default gen_random_uuid(),
  name text unique,
  description text not null default '',
  secret text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create view vault.decrypted_secrets as
  select id, name, description, secret, secret as decrypted_secret, created_at, updated_at
  from vault.secrets;

revoke all on vault.secrets, vault.decrypted_secrets from public;
grant usage on schema vault to service_role;
grant select on vault.secrets, vault.decrypted_secrets to service_role;

-- ==== 05-realtime.sql ====

-- Change notifications for core's realtime hub. The payload carries only the row id;
-- the hub re-reads the row as each subscriber so RLS decides who sees it.

create function selfbase.notify_change() returns trigger language plpgsql as $$
begin
  perform pg_notify('selfbase_changes', json_build_object(
    'schema', tg_table_schema,
    'table', tg_table_name,
    'type', tg_op,
    'id', case when tg_op = 'DELETE' then to_jsonb(old) -> 'id' else to_jsonb(new) -> 'id' end
  )::text);
  return null;
end
$$;

create function selfbase.enable_realtime(tbl regclass) returns void language plpgsql as $$
begin
  if not exists (select 1 from pg_attribute where attrelid = tbl and attname = 'id' and not attisdropped) then
    raise exception 'selfbase.enable_realtime: % has no id column', tbl;
  end if;
  execute format('drop trigger if exists selfbase_realtime on %s', tbl);
  execute format('create trigger selfbase_realtime after insert or update or delete on %s '
                 'for each row execute function selfbase.notify_change()', tbl);
end
$$;

-- Empty on purpose: migrations may run ALTER PUBLICATION supabase_realtime ADD TABLE ...
create publication supabase_realtime;

-- ==== 11-auth-flows.sql ====

-- Auth mail flows: the outgoing mail log and one-time token rules

-- Outgoing auth mails when SMTP_HOST is empty (tests and local development read them here)
create table selfbase.mail_log (
  id bigserial primary key,
  to_email text not null,
  subject text not null,
  html text not null,
  created_at timestamptz not null default now()
);
create index mail_log_to_email_idx on selfbase.mail_log (to_email);

-- One live token per user and type (same index GoTrue has): a new link replaces the previous one
create unique index one_time_tokens_user_id_token_type_key on auth.one_time_tokens (user_id, token_type);

-- Guesses against a short (6-digit SMS) code; the code dies after 5. selfbase-only column: dumps with GoTrue's columns still load
alter table auth.one_time_tokens add column attempts int not null default 0;

-- ==== 40-compat.sql ====

-- Supabase compatibility shims needed to load the CorteQS baseline dump and its migrations
-- unedited. Each block names the migration or dump section that needs it.
-- Runs after the postgis image's 10_postgis.sh.

-- The image's tiger/topology extensions go (CorteQS uses neither). tiger depends on fuzzystrmatch,
-- and Postgres 17.6+ refuses to move an extension others depend on, so it is dropped first.
drop extension postgis_tiger_geocoder, postgis_topology;
drop schema if exists tiger, tiger_data, topology; -- left behind empty by the two extensions (tiger_data not in every postgis release)

-- 10_postgis.sh puts fuzzystrmatch in public; CorteQS does not use it, Supabase keeps it in extensions.
alter extension fuzzystrmatch set schema extensions;

-- Real shim: CorteQS has vector, pg_trgm, unaccent and postgis in public (the baseline uses
-- public.vector, public.gin_trgm_ops, public.geography, and SQL functions with search_path=public
-- call unaccent(); 20260730120000_cadde_v1_002_hashtags_mentions and 5 others fail otherwise).
-- postgis is not relocatable, so it is reinstalled.
alter extension vector set schema public;
alter extension pg_trgm set schema public;
alter extension unaccent set schema public;
drop extension postgis;
create extension postgis with schema public;

-- Real shim: vault.create_secret / vault.update_secret, same signatures as supabase_vault
-- (20260907103000_move_notification_dispatch_secret_to_vault).
create function vault.create_secret(
  new_secret text, new_name text default null, new_description text default '', new_key_id uuid default null
) returns uuid language sql security definer set search_path = '' as $$
  insert into vault.secrets (secret, name, description)
  values (new_secret, new_name, coalesce(new_description, ''))
  returning id
$$;

create function vault.update_secret(
  secret_id uuid, new_secret text default null, new_name text default null,
  new_description text default null, new_key_id uuid default null
) returns void language sql security definer set search_path = '' as $$
  update vault.secrets set
    secret = coalesce(new_secret, secret),
    name = coalesce(new_name, name),
    description = coalesce(new_description, description),
    updated_at = now()
  where id = secret_id
$$;

revoke all on function vault.create_secret(text, text, text, uuid),
  vault.update_secret(uuid, text, text, text, uuid) from public;

-- Real shim: the migration history table the Supabase CLI keeps; three migrations insert into
-- it (20260805200000_cadde_geo_bridge_backfill and two others) and the dump scripts read it.
create schema supabase_migrations;
create table supabase_migrations.schema_migrations (
  version text primary key,
  statements text[],
  name text
);

-- Inert stubs: the rest of Supabase's platform roles, so GRANTs and default privileges naming them
-- in a full dump of the source (02-restore) apply. They own nothing and cannot log in.
create role supabase_functions_admin nologin;
create role supabase_realtime_admin nologin;
create role supabase_replication_admin nologin;
create role supabase_read_only_user nologin;
create role pgbouncer nologin;

-- ==== 50-admin.sql ====

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

-- ==== 60-guards.sql ====

-- Query guards and queue upkeep. v1 databases get the same statements from 0002.

-- Supabase's per-role statement timeouts: PostgREST applies the settings of the role it switches to.
-- core's asUser() switches roles with set_config inside a transaction, which does not apply them.
alter role anon set statement_timeout = '3s';
alter role authenticated set statement_timeout = '8s';

-- The netqueue worker scans pending rows every 30 s; finished rows are pruned after 7 days
create index if not exists http_queue_pending_idx on selfbase.http_queue (status) where status = 'pending';
