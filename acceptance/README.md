# Acceptance suite

Runs against a deployed selfbase project over its public URLs: `selfbase-js` (from `client/src`) on the project host
and the Management API on the control host. It needs no database port and no Docker; setup SQL goes through
`POST /v1/projects/{ref}/database/query`.

```
npm run acceptance -w acceptance      # configured only by the variables below
```

| Variable | | Meaning |
|---|---|---|
| `ACCEPTANCE_MODE` | required | `full` (a throw-away project) or `live` (a project in use) |
| `SELFBASE_URL` | required | the project's API URL, e.g. `https://<host>` |
| `SELFBASE_ANON_KEY` | required | the project's anon key |
| `SELFBASE_SERVICE_KEY` | `full` | the project's service_role key (removes the uploaded objects); in `live` only compared against the masked key |
| `SELFBASE_API_URL` | required | the control URL, e.g. `https://selfbase.<domain>` |
| `SELFBASE_ACCESS_TOKEN` | required | an `sbp_` access token of a member allowed to run SQL and pause the project |
| `SELFBASE_PROJECT_REF` | required | the project's ref |
| `ACCEPTANCE_LOGIN_EMAIL`, `ACCEPTANCE_LOGIN_PASSWORD` | optional | `live`: one sign-in with this account (reported as skipped without them) |

## Modes

- `full`: sign-up, the confirmation link read from `selfbase.mail_log`, verify, sign-in; refresh rotation and reuse
  refusal; an RLS table (the owner sees its rows, another user none); storage upload, public read, a private object
  refused to another user, a signed URL; a realtime INSERT that reaches its owner and not the other subscriber; an
  unknown function is 404; `/admin/*` and `/panel/` on the project host are 404; Management API get project, health,
  api-keys (anon in full, service_role masked), pause → 540 → restore → 200. It stops before any write when
  `GET /platform/projects/{ref}` does not report `smtp_configured: false`. Every table, policy, bucket, object, user
  and mail-log row it makes starts with the run prefix (`acc_…`, in `last-run.json`) and is removed in `afterAll`.
- `live`: no sign-up, no schema change. Health, `/rest/v1/` with the anon key, one object of a public bucket when
  there is one, a realtime connection (ping/pong), the hidden paths, Management API get, health and masked keys, and
  the sign-in above. The only writes are that sign-in's session and its sign-out.

The run ends with one line per case (passed, failed, skipped, not run, with its duration) and writes
`acceptance/last-run.json` (git-ignored): mode, project ref, run prefix, counts, duration and the cases.

## Against the local e2e stack

`E2E_KEEP=1 node --test test/e2e/stack.test.mjs` (test/e2e/README.md) leaves the stack up with Traefik on 18443.
Names under `localhost` are resolved to 127.0.0.1 and Traefik's default certificate is accepted, only when both URLs
are `*.localhost`: `SELFBASE_URL=https://<project host>:18443`, `SELFBASE_API_URL=https://selfbase.localhost:18443`.
