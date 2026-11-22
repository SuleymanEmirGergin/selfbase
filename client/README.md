# selfbase-js

A drop-in for the subset of `@supabase/supabase-js` 2.108.2 that CorteQS uses (see `INVENTORY.md`), talking to selfbase core.

- `npm run build` writes `dist/selfbase.mjs` (browser + Node), `dist/selfbase.deno.mjs` (Deno), `dist/selfbase.d.ts`
  and the license files. `dist/` is committed; `test/dist-fresh.test.ts` fails when it is stale, so rebuild and commit
  it with every change under `src/` or `vendor/`.
- `npm test` runs the unit and contract tests. They need the throwaway test stack (db + PostgREST):
  `TEST_DB_PORT=… TEST_REST_PORT=… docker compose -p <name> -f ../compose.test.yml up -d --build`, with the same two
  variables (and `TEST_COMPOSE_PROJECT=<name>` when it is not `sb-t8`) exported for vitest. Auth, storage, realtime and
  functions run against `test/fake-server.ts`, which follows core's contracts.

## Integration test against a real selfbase

`test/integration.test.ts` is skipped unless all four required variables are set:

| Variable | | Meaning |
|---|---|---|
| `SELFBASE_URL` | required | public origin of core, e.g. `http://localhost:8080` |
| `SELFBASE_ANON_KEY` | required | the stack's `ANON_KEY` |
| `SELFBASE_SERVICE_KEY` | required | the stack's `SERVICE_ROLE_KEY` |
| `TEST_COMPOSE_PROJECT` | required | compose project whose `db` service receives the setup SQL through `psql` (RLS table with realtime, public and private bucket with policies); there is no HTTP API for DDL or policies |
| `TEST_COMPOSE_FILE` | optional | compose file of that project, default `../compose.test.yml` |
| `SELFBASE_FAILING_FUNCTION` | optional | a deployed function that answers 500; enables the `FunctionsHttpError` case |
| `SELFBASE_COUNT_FUNCTION` | optional | a deployed `verify_jwt` function answering `{ count, user }` (row count of `body.table` with the service role, caller's user id); enables the `functions.invoke` case |

The stack must run with `AUTH_CONFIRM_EMAIL=true` and an empty `SMTP_HOST` (confirmation and recovery links are read
from `selfbase.mail_log`). Against the full stack (`TEST_COMPOSE_FILE=../compose.yml`) `psql` runs `docker compose exec`,
which needs that stack's env file: export `COMPOSE_ENV_FILES=<absolute path of it>` as well.
