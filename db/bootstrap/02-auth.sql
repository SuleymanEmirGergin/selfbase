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
