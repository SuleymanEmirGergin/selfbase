-- API roles (PostgREST / Supabase convention)
create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;

-- PostgREST connects as authenticator and switches to the role in the JWT
\getenv pgpass POSTGRES_PASSWORD
create role authenticator login noinherit password :'pgpass';
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
