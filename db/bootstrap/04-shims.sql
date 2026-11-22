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
