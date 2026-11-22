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
