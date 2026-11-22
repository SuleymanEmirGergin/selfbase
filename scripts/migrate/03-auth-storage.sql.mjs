#!/usr/bin/env node
// Prints SQL for psql; two phases around `02-restore.sh post` (see README for the order):
//   rows      01's auth.users, auth.identities, storage.buckets, storage.objects into selfbase's
//             tables. Only columns both sides have are copied (source-only column names are reported);
//             afterwards every source id must exist in the target, or the transaction aborts.
//   policies  recreates the source's storage policies and its user triggers on auth.users / storage.objects.
// Run as:
//   . scripts/migrate/lib.sh    # once per shell: defines psql_target (password via PGPASSWORD in the container)
//   node scripts/migrate/03-auth-storage.sql.mjs rows | psql_target
// Re-runnable: existing rows are kept, policies and triggers are replaced.
// Env (or .env at the repo root): TARGET_DB_URL (checked: never a Supabase host). Reads DUMP_DIR (default dump/).
import { existsSync, readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadEnv, refuseSupabaseTarget, requireEnv } from './05-rewrite-urls.mjs'

const phase = process.argv[2]
if (phase !== 'rows' && phase !== 'policies') {
  console.error('usage: 03-auth-storage.sql.mjs rows|policies')
  process.exit(2)
}
loadEnv()
refuseSupabaseTarget(requireEnv('TARGET_DB_URL')[0])
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

const out = ['\\set ON_ERROR_STOP 1', '\\o /dev/null', 'set client_min_messages = warning;', 'begin;']

if (phase === 'rows') {
  out.push(`-- Users come with their app rows (profiles, roles, ...) already restored by 02, so the source's
-- triggers must not fire again here; replica mode also skips FK checks for the load.
set local session_replication_role = replica;
create function pg_temp.sb_import(tbl regclass, data jsonb) returns void language plpgsql as $$
declare cols text; dropped text; n bigint; present bigint; total int := jsonb_array_length(data);
begin
  if total = 0 then raise warning '03: % has no source rows', tbl; return; end if;
  select string_agg(quote_ident(a.attname), ', ' order by a.attnum) into cols
    from pg_attribute a
   where a.attrelid = tbl and a.attnum > 0 and not a.attisdropped and a.attgenerated = ''
     and a.attname in (select jsonb_object_keys(data -> 0));
  select string_agg(k, ', ' order by k) into dropped
    from jsonb_object_keys(data -> 0) k
   where not exists (select 1 from pg_attribute a where a.attrelid = tbl and a.attname = k and not a.attisdropped);
  if dropped is not null then raise warning '03: %: source-only columns not copied: %', tbl, dropped; end if;
  execute format('insert into %s (%s) select %s from jsonb_populate_recordset(null::%s, $1) on conflict do nothing',
                 tbl, cols, cols, tbl) using data;
  get diagnostics n = row_count;
  -- on conflict do nothing must not hide a lost row (e.g. another user with the same email)
  execute format('select count(*) from %s where id::text in (select e ->> ''id'' from jsonb_array_elements($1) e)', tbl)
    into present using data;
  if present <> total then
    raise exception '03: %: % source rows but only % present here (% inserted now)', tbl, total, present, n;
  end if;
  raise warning '03: %: % source rows present (% inserted now)', tbl, total, n;
end $$;`)
  for (const t of ['auth.users', 'auth.identities', 'storage.buckets', 'storage.objects']) {
    out.push(`select pg_temp.sb_import('${t}', ${literal(JSON.stringify(readJsonl(t)))}::jsonb);`)
  }
} else {
  for (const p of readCatalog('storage_policies')) {
    const roles = p.roles.map((r) => (r === 'public' ? 'public' : qi(r))).join(', ')
    out.push(`drop policy if exists ${qi(p.policyname)} on storage.${qi(p.tablename)};
create policy ${qi(p.policyname)} on storage.${qi(p.tablename)} as ${p.permissive} for ${p.cmd} to ${roles}` +
      (p.qual ? ` using (${p.qual})` : '') + (p.with_check ? ` with check (${p.with_check})` : '') + ';')
  }
  for (const t of readCatalog('triggers')) {
    out.push(`drop trigger if exists ${qi(t.name)} on ${qi(t.schema)}.${qi(t.table)};\n${t.def};`)
  }
}

out.push('commit;')
process.stdout.write(out.join('\n') + '\n')
