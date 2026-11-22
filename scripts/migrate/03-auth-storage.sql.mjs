#!/usr/bin/env node
// Prints the SQL that moves 01's auth/storage data into selfbase's tables, then recreates the
// source's storage policies and its user triggers on auth.users / storage.objects. Run after 02:
//   node scripts/migrate/03-auth-storage.sql.mjs | docker run --rm -i [--network ...] -e TARGET_DB_URL \
//     postgres:17 bash -c 'psql "$TARGET_DB_URL" -X -q -v ON_ERROR_STOP=1'
// Only columns both sides have are copied (selfbase's auth tables are a subset of GoTrue's).
// Re-runnable: existing rows are kept (on conflict do nothing), policies and triggers are replaced.
// Reads DUMP_DIR (default dump/). Prints no secrets other than the rows themselves (password hashes).
import { existsSync, readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = process.env.DUMP_DIR || fileURLToPath(new URL('../../dump', import.meta.url))
const qi = (s) => `"${String(s).replaceAll('"', '""')}"`

function readJsonl(name) {
  const file = join(dir, `${name}.jsonl`)
  if (!existsSync(file)) {
    console.error(`03: ${file} missing, run 01 first`)
    process.exit(1)
  }
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

function readCatalog(name) {
  const file = join(dir, 'catalog', `${name}.json`)
  if (!existsSync(file)) {
    console.error(`03: catalog/${name}.json missing (01 could not read it); ${name} not recreated`)
    return []
  }
  return JSON.parse(readFileSync(file, 'utf8'))
}

// Dollar-quoted literal with a tag the content cannot contain.
function literal(text) {
  let tag
  do tag = `$sb${randomBytes(6).toString('hex')}$`; while (text.includes(tag))
  return `${tag}${text}${tag}`
}

const out = []
out.push(`\\set ON_ERROR_STOP 1
\\o /dev/null
set client_min_messages = warning;
begin;
-- Users come with their app rows (profiles, roles, ...) already restored by 02, so the source's
-- triggers must not fire again here; replica mode also skips FK checks for the load.
set local session_replication_role = replica;
create function pg_temp.sb_import(tbl regclass, data jsonb) returns bigint language plpgsql as $$
declare cols text; n bigint;
begin
  if jsonb_array_length(data) = 0 then return 0; end if;
  select string_agg(quote_ident(a.attname), ', ' order by a.attnum) into cols
    from pg_attribute a
   where a.attrelid = tbl and a.attnum > 0 and not a.attisdropped and a.attgenerated = ''
     and a.attname in (select jsonb_object_keys(data -> 0));
  execute format('insert into %s (%s) select %s from jsonb_populate_recordset(null::%s, $1) on conflict do nothing',
                 tbl, cols, cols, tbl) using data;
  get diagnostics n = row_count;
  raise warning '03: % rows into %', n, tbl;
  return n;
end $$;`)

for (const t of ['auth.users', 'auth.identities', 'storage.buckets', 'storage.objects']) {
  out.push(`select pg_temp.sb_import('${t}', ${literal(JSON.stringify(readJsonl(t)))}::jsonb);`)
}
out.push('reset session_replication_role;')

for (const p of readCatalog('storage_policies')) {
  const roles = p.roles.map((r) => (r === 'public' ? 'public' : qi(r))).join(', ')
  out.push(`drop policy if exists ${qi(p.policyname)} on storage.${qi(p.tablename)};
create policy ${qi(p.policyname)} on storage.${qi(p.tablename)} as ${p.permissive} for ${p.cmd} to ${roles}` +
    (p.qual ? ` using (${p.qual})` : '') + (p.with_check ? ` with check (${p.with_check})` : '') + ';')
}

for (const t of readCatalog('triggers')) {
  out.push(`drop trigger if exists ${qi(t.name)} on ${qi(t.schema)}.${qi(t.table)};\n${t.def};`)
}

out.push('commit;')
process.stdout.write(out.join('\n') + '\n')
