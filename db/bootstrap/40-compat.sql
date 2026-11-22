-- Supabase compatibility shims needed to load the CorteQS baseline dump and its migrations
-- unedited (Task 10). Each block names the migration or dump section that needs it.
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
