# selfbase v2 — Wave 1 (control plane and project #1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (chosen by the owner) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the single v1 stack into a multi-project platform: a control stack (Studio + management API + provisioner) that creates isolated project stacks through the Docker API and Traefik labels, deployed on the shared server, with CorteQS running as project #1.

**Architecture:** One control stack (`control`, `control-db`, `provisioner`, `socket-proxy`, `logs`) installed with compose. `control` holds desired state in control-db and converges it through `provisioner`, the only component that speaks the Docker API, behind a socket proxy with a name-scoped allow-list. Each project is the v1 stack evolved (`db`, `rest`, `core` with a private admin port, `fn`, `pooler`) on its own /27 network; only `core` joins the proxy network. Projects keep serving with the control stack stopped.

**Tech Stack:** Node 24 + TypeScript (run directly, type stripping) + Hono + `pg` + `jose`, React 19 + Vite (Studio), Postgres 17, PostgREST 14.1, PgBouncer, Deno 2, Docker Engine API through `wollomatic/socket-proxy`, Traefik v3 labels, VictoriaLogs, vitest, Playwright, GitHub Actions + GHCR.

**Spec:** `docs/superpowers/specs/2026-11-22-selfbase-v2-design.md` (binding; every implementer reads sections 3–7, 9–11 and the sections their task names). v1 design: `docs/superpowers/specs/2026-11-22-selfbase-design.md`.

## Execution

- Branch: `v2`, cut from `v1`. Branch `v1` is never changed (it must stay deployable until cutover is confirmed).
- Subagent-driven: one Opus implementer per task, a task review after each task. The **whole-branch review** runs after Task 19, before anything is pushed or deployed (Task 20 starts only when it is clean); the proof and guide documents of Tasks 20–24 get their task reviews. The controller dispatches and merges.
- Tasks with no dependency between them may run in parallel in separate git worktrees. A parallel task writes **only** the paths in its **Files** block. If it needs a file another task owns, it stops and reports to the controller.
- Root `package-lock.json` is the one shared file every package touches. On a merge conflict there: take either side, run `npm install` at the root, commit the result.
- **Owner step** lines need the owner at that moment. A builder never works around one.
- Server tasks (1, 20, 21, 22) are run by a builder over SSH under the shared-host rule (spec section 5). They are never parallel with each other.

## Global Constraints

- No `supabase/*` image and no `@supabase/*` package at runtime. `@supabase/supabase-js` is not added in this wave at all.
- Shared-host rule: a builder touches only `sb-*` / `selfbase-*` containers, networks, volumes and paths under `/opt/selfbase`. Read-only inspection of shared objects is allowed. Anything else needs the owner's OK at that moment. `coolify-proxy` is never restarted or reconfigured; nothing is written into Coolify's directories; Docker daemon settings are never changed.
- Never write the server's IP address or hostname into the repository. Use `<ip>` and `<BASE>`.
- Secrets are never printed, logged, committed, put in job payloads, audit rows or error messages. Scripts that read env files print key **names** only.
- Naming: project objects `sb-<ref>-<service>` (containers, volumes), `sb-<ref>` (network); control stack containers `selfbase-<service>`. Labels on every project object: `selfbase.managed=true`, `selfbase.project=<ref>`.
- Project ref: `^[a-z]{20}$`. Personal access token: `sbp_` + 40 hex (AC-1).
- The provisioner never sets `Privileged`, `CapAdd`, host namespaces, devices, published ports (this wave) or bind mounts, except the one fixed host backup directory in job containers (AC-11). It has no runtime dependency beyond Node's standard library and stays under 1000 lines.
- Every container the provisioner creates has `Memory`, `MemorySwap` equal to it, `NanoCpus`, `PidsLimit`, `no-new-privileges`, restart policy `unless-stopped`.
- `OVERCOMMIT` is 1.0 (CC-2). Memory budget 16384 MiB. Sizes (MiB) — micro: db 512, rest 128, core 256, fn 256, pooler 32 = 1184; small: 1024, 256, 512, 512, 32 = 2336; medium: 2048, 256, 512, 1024, 32 = 3872.
- `/v1` routes name the `operationId` they implement and match path, method and field names of `docs/reference/management-api.json`. Anything without a Supabase equivalent goes under `/platform`.
- Certificates: this wave requests **at most 3 new hosts** (`MAX_NEW_HOSTS_PER_WEEK`), exactly these: `selfbase.<BASE>` (Studio), `sb-test.<BASE>` (the fixed test host, pool `test`), `<ref>.<BASE>` of project #1. `selfbase-corteqs.<ip>.sslip.io` already has its certificate. No other hostname may reach the proxy with a certificate resolver. There is no slack: a hostname typo costs a week.
- CorteQS repository (`D:\Dev\corteqsemir`, worktree `D:\Dev\corteqsemir-wt\selfbase`, branch `selfbase/client-swap`): no push, no PR, migration files never edited, `scripts/ops/*` never run.
- Code, comments, commit messages in English. Commit format `<type>: <description>`. Commits are local; **pushing is an Owner step** (Task 20). `docs/REHBER.md` and Studio UI text are Turkish.
- Each code task: failing test → implementation → passing test → commit. Integration tests run against real Postgres / real Docker, no mocks of either.
- Platform migrations numbered `0002` and above must be safe to run twice.

## Review Focus

1. **Hostile ref or name reaching Docker.** A ref such as `../x`, `SB`, `sb-other`, 19 letters or an empty string is refused by the provisioner before any Docker call. → Task 6.
2. **Admin API on the public port.** Every `/admin/*` and `/panel/*` path on `:8080` answers 404 with or without the admin token; `:8081` without the token answers 401. → Task 4.
3. **Two creates racing for the last new host.** With one new host left under the cap, two concurrent creates end with exactly one project and one refusal. → Task 11.
4. **Control restarted in the middle of a create.** The job resumes at its recorded step, and the project ends with exactly one network and one container per service. → Task 12.
5. **Secret values leaking through failure paths.** After a create and a deliberately failed import, no generated or imported secret value appears in `jobs`, `job_events`, `audit_log`, an HTTP response or captured logs. → Task 14.

## Decisions this plan makes where the spec is silent or contradicts itself

| # | Issue | Resolution |
|---|---|---|
| D-1 | CC-1 says the provisioner pulls "with the daemon's stored credential". The Docker daemon stores none; an API pull without `X-Registry-Auth` is anonymous and fails on private GHCR. | Images are **local-first**: a release pulls them on the host with `docker pull` (root's `docker login`, entered by the owner). The provisioner uses a local image when present and only then tries an anonymous pull. It never holds a token. If Task 1 finds that Coolify's cleanup deletes our images, the controller decides between a read-only token for the provisioner and a re-pull step. |
| D-2 | The socket-proxy allow-list permits pulls for our registry path only, but `rest` is Docker Hub's PostgREST. | CI re-tags PostgREST and builds PgBouncer as `selfbase-rest` and `selfbase-pooler` in GHCR. |
| D-3 | The provisioner must interpret `template/compose.yml` (AC-4) with no dependency (7.5). YAML needs a parser. | The provisioner image build converts the template to JSON (`yaml` as a build-only devDependency). Runtime reads JSON with the standard library and validates it strictly. |
| D-4 | A catch-all `HostRegexp` on the base domain (7.3) would also match other teams' hosts under the same `<ip>.sslip.io`. | The catch-all matches only selfbase-shaped names: `^([a-z]{20}|sb-[a-z0-9-]+)\.<BASE>$`, priority 1. |
| D-5 | A TCP syslog driver stops a container from starting when the listener is down, which breaks "projects run with the control stack stopped". | UDP: `syslog-address=udp://127.0.0.1:5514`, `mode=non-blocking`. Task 17 proves a restart with `logs` stopped. |
| D-6 | `db/bootstrap/00-roles.sql` uses psql's `\getenv`; a migration applied by core cannot. | Migration 0001 creates `authenticator` without a password; core sets it from `AUTHENTICATOR_PASSWORD` at every start. |
| D-7 | AC-6 removes the per-project backup daemon; the wave list does not name scheduled backups. Project #1 would have none until wave 4. | Wave 1 includes the daily backup as a control-plane job to the host backup directory (spec 8.8). |
| D-8 | The template has a `functions` volume, but function deploy is wave 2. | In wave 1 a production project has an empty functions volume and every function answers 404. The v1 server install has no `SUPABASE_DIR` (Task 1 confirms), so nothing regresses. |
| D-9 | The spec allows the control stack as a Coolify resource or plain compose and does not choose. | Plain `docker compose` in `/opt/selfbase` (project name `selfbase`), a 0600 env file. Reason: fixed container names, no `$` mangling, and it is the same path as the owner's own server later. |
| D-10 | The spec does not say how the first dashboard user exists. | `docker compose exec control node src/cli.ts create-owner <email>` reads the password from stdin. Sign-up is closed; others join by invitation. Dashboard MFA arrives with core's MFA in wave 3. |
| D-11 | `/v1/projects/{ref}/upgrade` is not in the wave list, but a fix release must reach existing projects. | `POST /platform/projects/{ref}/upgrade` sets the pinned version to the current one; reconcile recreates. |
| D-12 | Local mode (`SELFBASE_LOCAL`), `selfbase start`, config editing routes, external database ports, imgproxy, metrics, Garage and etcd. | Not in this wave. Their memory is reserved in admission from day one (2720 MiB shared + 512 job slot). |
| D-13 | PgBouncer needs credentials; nothing uses the pooler before wave 2. | Single-user userlist from `POSTGRES_PASSWORD`, marked `shortcut:`; a pooler role with `auth_query` comes with external access. |

## Dependency map

```
Task 1 (server facts) ───────────────────────────────────────────────┐
Task 2 (monorepo, stubs, CI) ─┬─► 3 ─► 4 ─► 5 ◄─ 6                    │
                              ├─► 6 ─► 7 ─► 8 (needs 5)               │
                              ├─► 9 (needs 3) ─┬─► 10 (needs 4)       │
                              │                └─► 11 ─► 12 ─► 13 ─► 14
                              └─► 15 ─► 16                            │
            17 (control stack, e2e) ◄─ 5, 8, 10, 13, 14, 16           │
            18 (acceptance suite) ◄─ 17      19 (Windows proof) ◄─ 17 │
            20 (release, deploy) ◄─ 1, 18, 19 ─► 21 ─► 22 ─► 23, 24 ◄─┘
```

---

### Task 1: Server facts (read-only, over SSH)

**Depends on:** nothing. **Files:** `docs/superpowers/specs/2026-11-22-selfbase-v2-design.md` (new section 15 and every server-side *(verify)*), `docs/proofs/wave1-before.md`.

No command in this task changes anything on the server. Allowed: `docker inspect|ps|network ls|network inspect|volume ls|info|version|system df`, `free`, `df`, `ss -lntu`, `cat /proc/meminfo`, `systemctl show`, reading Traefik's log with `docker logs coolify-proxy`, `crontab -l`. Not allowed: anything that writes, `docker exec` into another team's container, reading another team's env or files.

- [ ] **Step 1:** Record in spec section 15 "Server facts (measured <date>)", one row per fact, value + the command that produced it:
  proxy container name and image tag (Traefik major and minor); proxy network name; entrypoint names (from the proxy's command line); certificate-resolver name; whether a global HTTP→HTTPS redirect exists; Docker Engine and API version; cgroup driver and cgroup version; storage driver; `live-restore`, `userns-remap`, rootless (expected: off); free RAM, swap, cores, free disk on the Docker root; every Docker network with its subnet; listening TCP/UDP ports in 5000–7000 and 54000–55000; whether UDP 5514 on 127.0.0.1 is free; Coolify version and its cleanup settings (what it prunes: stopped containers, unused images, with which filters — from the Coolify UI or its documented defaults for that version); whether the v1 resource sets `SUPABASE_DIR` and `SMTP_HOST` (names only, from `docker inspect` of the v1 `fn`/`core` containers, values never printed); the v1 resource's container, network and volume names.
- [ ] **Step 2:** sslip.io certificates, issuing nothing: count certificates for `%.<ip>.sslip.io` on crt.sh in the last 7 days, and grep the proxy log for `rateLimited` / `too many certificates`. Record both. Confirm `selfbase-corteqs.<ip>.sslip.io` has a valid certificate (`openssl s_client`).
- [ ] **Step 3:** "Before" listing. On the server write `/opt/selfbase/proofs/before.txt` (mode 0600; creating `/opt/selfbase` is ours): sorted names of all containers, networks and volumes that do **not** start with `sb-` or `selfbase-`. In the repo, `docs/proofs/wave1-before.md` gets only the three counts and the sha256 of that file.
- [ ] **Step 4:** Replace each server-side *(verify)* in the spec with the measured value. Choose and record: `PROXY_NETWORK`, `PROXY_ENTRYPOINT_HTTP`, `PROXY_ENTRYPOINT_HTTPS`, `PROXY_CERTRESOLVER`, `PROXY_TRAEFIK_MAJOR`, `PROJECT_SUBNET_POOL` (a /16 overlapping no existing subnet), `DB_PORT_RANGE` (recorded for wave 2), `LOG_SYSLOG_ADDR`, `CGROUP_PARENT`.
- [ ] **Step 5:** Commit `docs: record server facts for wave 1`.

**If a fact contradicts the design** — stop, report to the controller, and these tasks change:

| Fact | Effect |
|---|---|
| Proxy network, entrypoint or resolver names differ from the defaults | Values in Task 20's env file only. No code change. |
| Traefik major is 2 | Task 17: catch-all label uses v2 `HostRegexp` syntax (`PROXY_TRAEFIK_MAJOR=2`). |
| The proxy is not Traefik, or its network cannot be joined | Wave stops. `PROXY_MODE=coolify` is unbuildable as designed. |
| cgroup driver is not systemd | Task 20 skips the slice step, `CGROUP_PARENT` empty; Task 23 says so. |
| Docker API < 1.44 | Task 7: attach the proxy network with a separate connect call (already the plan) and pin the API version in requests. |
| Rootless, `userns-remap` or `live-restore` on | Wave stops; controller decides. |
| A subnet overlaps `10.207.0.0/16` | Different `PROJECT_SUBNET_POOL`. No code change. |
| UDP 5514 is taken | Different port in `LOG_SYSLOG_ADDR`. No code change. |
| Coolify prunes stopped containers | Nothing changes in code (Task 12's reconcile recreates them); Task 23 documents it. |
| Coolify prunes images still used only by stopped containers | D-1 goes to the controller before Task 20. Task 7 may gain an optional `REGISTRY_AUTH`. |
| sslip.io issuance is already rate-limited, or fewer than 3 new certificates look obtainable | Tasks 20–21 wait; controller decides (wait a week, or the path-routing fallback, which is a new design). |
| Free RAM < 16 GB or free disk < 50 GB | Wave stops; owner decides the budget. |
| The v1 resource sets `SUPABASE_DIR` | D-8 is wrong for project #1. Controller decides before Task 21 (keep v1 until wave 2, or accept functions being off). |
| The v1 resource sets `SMTP_HOST` | Task 21 runs the acceptance suite in `live` mode only on project #1. |

### Task 2: Monorepo, package stubs, CI images

**Depends on:** nothing (parallel with Task 1). **Files:** root `package.json`, `package-lock.json`, `tsconfig.base.json`, `.gitignore`, `.dockerignore`, `README.md`, `.github/workflows/{ci.yml,images.yml}`; `git mv panel studio`; `git mv compose.yml template/compose.yml`, `compose.test.yml` and `compose.local.yml` → `template/`; `git mv scripts/backup.Dockerfile job/Dockerfile`, `scripts/{backup,restore}.sh` → `job/`; `core/Dockerfile`, `fn/Dockerfile`, `rest/Dockerfile`, `pooler/Dockerfile` (stub), `control/{package.json,tsconfig.json,Dockerfile,src/server.ts}`, `provisioner/{package.json,tsconfig.json,Dockerfile,src/server.ts}`, `scripts/test/compose-env.test.mjs` (path only), per-package `package-lock.json` files deleted.

**Interfaces — Produces:**
- Root `package.json`: `"private": true`, `"version": "2.1.0"`, `"workspaces": ["core","control","provisioner","studio","client"]`. Package names: `selfbase-core`, `selfbase-control`, `selfbase-provisioner`, `selfbase-studio`, `selfbase-js`. `fn` (Deno), `db`, `rest`, `pooler`, `job`, `template` are not workspaces.
- Images, all built with the repository root as context and tagged `ghcr.io/suleymanemirgergin/selfbase-<name>:<tag>`: `db`, `core`, `fn`, `rest` (`FROM postgrest/postgrest:v14.1`), `pooler`, `job`, `control`, `provisioner`. `REGISTRY` = `ghcr.io/suleymanemirgergin`.
- `ci.yml` (push and PR on `v2`): `npm ci`, typecheck and unit tests of every workspace with the `template/compose.test.yml` database, `docker build` of all eight images without pushing. Job `e2e` is added by Task 17 in this file's reserved `e2e:` block (Task 2 leaves the block with one `echo` step).
- `images.yml` (tag `v*`): build and push all eight images tagged with the git tag (without the `v`) and `sha-<short>`; uses `GITHUB_TOKEN` with `packages: write`.
- `control/src/server.ts` and `provisioner/src/server.ts`: `GET /health` → `{ok:true}` on `PORT` (8080 / 8090). Enough for the images to build and start.
- `core/Dockerfile` no longer builds the panel (Task 4 removes the route).

- [ ] **Step 1:** Write `scripts/test/workspace.test.mjs` (node:test): the root lists exactly the five workspaces; no `package-lock.json` exists below the root; every Dockerfile named above exists; `images.yml` names all eight images.
- [ ] **Step 2:** `node --test scripts/test/workspace.test.mjs` → FAIL.
- [ ] **Step 3:** Do the moves and write the files. Keep `template/compose.yml` behaving as v1's compose (local `docker compose -f template/compose.yml up` still works; `build:` contexts adjusted to `..`). Task 5 evolves it.
- [ ] **Step 4:** `npm ci && npm test --workspaces --if-present` green against `docker compose -f template/compose.test.yml up -d --build db rest`; all eight `docker build` commands succeed locally; the workspace test passes.
- [ ] **Step 5:** Commit `chore: npm workspaces monorepo, package stubs and CI image builds`.

### Task 3: Platform migrations and the db image

**Depends on:** Task 2. **Files:** `db/Dockerfile`, `git mv db/bootstrap core/test/fixtures/v1-bootstrap` (kept as the v1 fixture), `db/platform/0001-bootstrap.sql`, `db/platform/0002-guards-2026-11-22.sql`, `db/upgrade/` removed, `core/src/platform/migrate.ts`, `core/src/server.ts` (the three start lines only), `core/src/config.ts` (two keys), `core/Dockerfile` (copy `db/platform`), `core/test/{setup.ts,global-setup.ts,platform.test.ts}`, `core/vitest.config.ts`, `template/compose.test.yml`.

**Interfaces — Produces:**
- `db/platform/NNNN-name.sql`, name regex `^\d{4}-[a-z0-9-]+\.sql$`. `0001-bootstrap.sql` is the ten v1 bootstrap files concatenated in order, with `\getenv` removed and `authenticator` created `login noinherit` without a password (D-6). `0002` is `db/upgrade/2026-11-22.sql` unchanged. The db image no longer copies anything into `/docker-entrypoint-initdb.d/`.
- `core/src/platform/migrate.ts`:
  - `applyMigrations(pool: pg.Pool, opts: { dir: string; ledger: string; lockKey: number; adoptV1?: boolean }): Promise<string[]>` — returns the versions applied in this call. Takes `pg_advisory_lock(lockKey)` on one connection for the whole run; creates the ledger `(version text primary key, name text not null, applied_at timestamptz not null default now())`; runs each pending file and its ledger insert in one transaction, in version order; throws on a duplicate version, a gap, or a ledger version with no file. With `adoptV1`, when the ledger does not exist and `to_regclass('selfbase.http_queue')` is not null, it inserts `0001` without running it.
  - `setRolePassword(pool: pg.Pool, role: 'authenticator', password: string): Promise<void>`.
- core start order: `applyMigrations(pool, { dir: config.platformDir, ledger: 'selfbase.platform_migrations', lockKey: 7213014, adoptV1: true })` → `setRolePassword` → listen. A failed migration exits the process with code 1 and one log line naming the file (never the SQL).
- Config: `PLATFORM_DIR` (default `/app/db/platform`), `AUTHENTICATOR_PASSWORD` (default: `POSTGRES_PASSWORD`, so plain compose keeps working). `db.ts`'s `userPool` uses it.
- Tests: `global-setup.ts` applies the migrations once before any test file.

- [ ] **Step 1:** `core/test/platform.test.ts`: on an empty database `applyMigrations` returns `['0001','0002']` and a second call returns `[]`; two concurrent calls apply each file once (ledger has 2 rows, no error); a directory with `0001` and `0003` throws and applies nothing new; a broken `0003` leaves the ledger at `0002` and none of `0003`'s objects exist; a database built by running the v1 fixture files with psql inside the db container (`core/test/fixtures/v1-bootstrap/`) and no ledger gets `0001` stamped without running and `0002` applied; running `0002` twice by hand succeeds; after `setRolePassword`, a connection as `authenticator` with that password works and with the old one fails. The existing suite (`bootstrap.test.ts` and the rest) passes unchanged.
- [ ] **Step 2:** `npx vitest run test/platform.test.ts` in `core` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Whole core suite PASS against a fresh `template/compose.test.yml` database.
- [ ] **Step 5:** Commit `feat: versioned platform migrations applied by core`.

### Task 4: Core — private admin port, bearer token, JSON request log, sign-up switch

**Depends on:** Task 3. **Files:** `core/src/{app.ts,server.ts,config.ts,log.ts}`, `core/src/admin/{index.ts,auth.ts}`, `core/src/admin/session.ts` (deleted), `core/src/auth/routes-core.ts`, `core/package.json` (drop `bcryptjs` only if nothing else imports it), `core/test/{admin.test.ts,admin-port.test.ts,log.test.ts,hardening.test.ts,panel.test.ts (deleted)}`, `db/platform/0003-admin-audit-actor.sql`, `scripts/set-panel-password.mjs` and its test (deleted), `.env.example`.

**Interfaces — Produces:**
- `core/src/app.ts` exports `app` (public, `:8080`) and `adminApp` (`:ADMIN_PORT`, default 8081). `app` has no `/admin` and no `/panel` route. `adminApp` serves the existing admin routers under `/admin/*` plus `GET /admin/ready` → `{ok:true}`.
- `core/src/admin/auth.ts`: `requireAdminToken` — `Authorization: Bearer <ADMIN_TOKEN>`, compared with `timingSafeEqual` on sha256 digests; 401 `{error:'admin token required'}` otherwise. Sets `actor` from header `x-selfbase-actor` (max 320 chars, default `control`).
- `ADMIN_TOKEN` shorter than 32 characters or empty → the admin server is not started and one warning is logged. `server.ts` starts the second listener only otherwise.
- `selfbase.admin_audit` gains `actor text` (migration 0003, idempotent); every admin write stores it.
- Removed: panel login, cookie, `sameOrigin`, `PANEL_ADMIN_EMAIL`, `PANEL_ADMIN_PASSWORD_HASH`, `PANEL_DIR`, the panel build.
- `core/src/log.ts`: `requestLog(svc: string)` Hono middleware. One JSON object per request on stdout: `ts, level, svc, project, request_id, method, path, status, latency_ms`. `project` = env `PROJECT_REF` (default empty). `path` is the URL path **without the query string**; no header and no body is ever logged. `request_id` = incoming `x-request-id` if it matches `^[A-Za-z0-9-]{8,64}$`, else a new UUID; echoed in the response header. `logLine(level, msg, fields?)` for non-request lines; existing `console.*` calls in `core/src` move to it.
- `AUTH_DISABLE_SIGNUP` (default false): `POST /auth/v1/signup` answers 422 `{code:422,error_code:'signup_disabled',msg:'Signups not allowed for this instance'}`.

- [ ] **Step 1:** Tests. `admin-port.test.ts`: on `app`, each of `/admin/tables`, `/admin/sql`, `/admin/login`, `/admin/files/b/x`, `/panel/`, `/panel/index.html` answers 404 with no header, with the admin token, and with a service_role JWT (Review Focus 2); on `adminApp` without a token and with a wrong token of equal length → 401; with the token `GET /admin/tables?schema=public` → 200; a service_role JWT as bearer → 401; a write with `x-selfbase-actor: a@b.test` stores that actor. `log.test.ts`: a request to `/auth/v1/verify?token=SECRETTOKEN` logs one parseable JSON line whose `path` is `/auth/v1/verify` and the captured stdout does not contain `SECRETTOKEN`; an `apikey` header value never appears; `x-request-id: abc` (too short) is replaced. Sign-up switch on → 422 and no row in `auth.users`. `admin.test.ts` is rewritten to use the token; its identifier-injection, CRUD, policy, SQL and file cases stay.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** Whole core suite PASS.
- [ ] **Step 5:** Commit `feat: core admin api on a private port behind a token; json request log`.

### Task 5: Project template v2, pooler and sizes

**Depends on:** Tasks 4 and 6. **Files:** `template/{compose.yml,compose.build.yml,compose.test.yml,sizes.json,README.md,.env.example}`, `pooler/{Dockerfile,entrypoint.sh}`, `fn/{Dockerfile,config.ts}` (volume layout comment only if code is unchanged), `scripts/test/{compose-env.test.mjs,template.test.mjs}`, root `.env.example` (deleted; `template/.env.example` replaces it).

**Interfaces — Produces:**
- `template/compose.yml`, the strict subset. Top level: `services`, `volumes` only. Per service: `image`, `command`, `environment` (map), `volumes` (`<name>:<path>[:ro]`, named volumes only), `depends_on` (list), `healthcheck`, `init`, `user`, `stop_grace_period`. Nothing else: no `build`, `ports`, `networks`, limits, `logging`, `restart`, `labels`, anchors or `x-*`. Interpolation forms: `${VAR}`, `${VAR:-default}`, `${VAR:?message}`.
- Services and images: `db` → `${REGISTRY}/selfbase-db:${TEMPLATE_VERSION}`, likewise `rest`, `core`, `fn`, `pooler`. No `backup` service. Volumes: `pgdata` (db), `storage` (core `/data/storage`), `functions` (fn `/supabase`, read-only), `denocache` (fn).
- `db` command adds `-c shared_buffers=${DB_SHARED_BUFFERS} -c max_connections=${DB_MAX_CONNECTIONS}` to v1's three settings.
- Environment delivered to a project (the names Task 12 fills): `POSTGRES_PASSWORD`, `AUTHENTICATOR_PASSWORD`, `JWT_SECRET`, `ANON_KEY`, `SERVICE_ROLE_KEY`, `ADMIN_TOKEN`, `PROJECT_REF`, `PUBLIC_URL`, `SITE_URL`, `PGRST_DB_SCHEMAS`, `PGRST_DB_MAX_ROWS`, every `AUTH_*`, `SMTP_*`, `GOOGLE_*` and `STORAGE_MAX_UPLOAD_BYTES` key v1's compose passes to `core`, `FN_IMPORT_TIMEOUT_MS`, and the computed `REGISTRY`, `TEMPLATE_VERSION`, `DB_SHARED_BUFFERS`, `DB_MAX_CONNECTIONS`, `POOL_SIZE`. `rest` connects as `authenticator` with `AUTHENTICATOR_PASSWORD`. `core` gets `ADMIN_PORT=8081`.
- `template/sizes.json`: per size and service `mem_mb`, `cpus`, `pids`, plus `db.shm_mb`, `db.shared_buffers`, `db.max_connections`, `pooler.pool_size`. Memory as in Global Constraints. cpus micro: db 1, rest 0.5, core 0.5, fn 0.5, pooler 0.25; small and medium: db 2, rest 1, core 1, fn 1, pooler 0.25. pids 512 (pooler 64). shm 128 / 256 / 512. shared_buffers 128MB / 256MB / 512MB. max_connections 60 / 100 / 150. pool_size 15 / 20 / 30.
- `pooler`: `alpine` + `pgbouncer`, port 6432, `pool_mode=transaction`, `max_client_conn=200`, `default_pool_size=${POOL_SIZE}`, upstream `db:5432`, userlist written by `entrypoint.sh` from `POSTGRES_PASSWORD` into a 0600 file (`# shortcut: single superuser in the userlist, a pooler role with auth_query when external access lands (wave 2)`).
- `template/compose.build.yml`: adds `build:` for every image, publishes core on `127.0.0.1:${CORE_PORT:-8080}`, and mounts `${SUPABASE_DIR:-../fn/empty}` over the functions volume for local development. Local use: `docker compose -f template/compose.yml -f template/compose.build.yml up -d --build`. The provisioner never reads this file.

- [ ] **Step 1:** `scripts/test/template.test.mjs`: `node provisioner/src/template.ts --check template/compose.yml` (Task 6's CLI) exits 0 and renders for micro, small and medium with a complete env; `sizes.json` sums to 1184, 2336, 3872; the local stack (both compose files) comes up healthy and then: `GET /health` 200, `GET /rest/v1/` with the anon key 200, `psql` through `pooler:6432` returns `select 1`, `docker port` shows only core's 8080, `curl core:8081/admin/ready` from inside the network with the token 200, a function name answers 404. `compose-env.test.mjs` points at the new path and passes.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS, and the core and client integration suites pass against the local stack.
- [ ] **Step 5:** Commit `feat: project template v2 with admin port, pooler and sizes`.

### Task 6: Provisioner — template validation and container spec builder (pure)

**Depends on:** Task 2. **Files:** `provisioner/src/{template.ts,spec.ts,names.ts,settings.ts}`, `provisioner/test/{template.test.ts,spec.test.ts,fixtures/template.yml}`, `provisioner/scripts/bake-template.mjs`, `provisioner/package.json` (`yaml` as devDependency only).

**Interfaces — Produces:**
```ts
// names.ts
export const REF_RE = /^[a-z]{20}$/
export function assertRef(ref: unknown): asserts ref is string            // throws ProvisionError(400,'invalid_ref')
export const containerName = (ref: string, service: string) => `sb-${ref}-${service}`
export const networkName = (ref: string) => `sb-${ref}`
export const volumeName = (ref: string, volume: string) => `sb-${ref}-${volume}`

// settings.ts — read once from env
export type NodeSettings = { registry: string; templateVersion: string; proxyNetwork: string; entrypointHttp: string
  entrypointHttps: string; certResolver: string; logSyslogAddr: string; cgroupParent: string; backupHostDir: string
  subnetPool: string; controlContainer: string; controlNetwork: string }

// template.ts
export type Template = { services: Record<string, TemplateService>; volumes: string[] }
export function validateTemplate(json: unknown): Template                  // throws TemplateError naming the key
export function render(value: string, env: Record<string, string>): string // the three ${} forms; unknown var throws

// spec.ts
export type Size = 'micro' | 'small' | 'medium'
export type EnsureInput = { ref: string; templateVersion: string; size: Size; subnet: string; hosts: string[]
  env: Record<string, string> }
export type JobType = 'backup' | 'restore' | 'clone' | 'basebackup' | 'volume-copy' | 'migra-diff'
export type JobInput = { ref: string | 'control'; type: JobType; args: { dir?: string }; env: Record<string, string> }
export type ContainerSpec = { name: string; service: string; body: Record<string, unknown>; specHash: string
  networks: string[] }                                                     // body = POST /containers/create payload
export function buildProject(input: EnsureInput, tpl: Template, sizes: Sizes, node: NodeSettings):
  { network: { name: string; body: Record<string, unknown> }; volumes: string[]; containers: ContainerSpec[] }
export function buildJob(input: JobInput, node: NodeSettings): ContainerSpec
```
- `bake-template.mjs <compose.yml> <out.json>`: YAML → JSON at image build (D-3). `template.ts --check <compose.yml>` is the same conversion plus `validateTemplate` and a render for each size (needs devDependencies; used by tests and CI only).
- Every container body: `Image` (must equal `<registry>/selfbase-<service>:<templateVersion>` after rendering, otherwise refused), `Env`, `Cmd`, `Healthcheck`, `Labels` (`selfbase.managed`, `selfbase.project`, `selfbase.service`, `selfbase.template`, `selfbase.spec`=specHash), `HostConfig` with `Memory`, `MemorySwap` (equal), `NanoCpus`, `PidsLimit`, `SecurityOpt:['no-new-privileges:true']`, `RestartPolicy:{Name:'unless-stopped'}`, `CgroupParent` (when set), `Mounts` of `Type:'volume'` only, `ShmSize` for `db`, `Init` when the template says so, `LogConfig` (`syslog` with `syslog-address`, `syslog-format=rfc5424`, `tag=sb-<ref>-<service>`, `mode=non-blocking` when `logSyslogAddr` is set; otherwise `json-file` 10m × 3). Network: `sb-<ref>` with aliases `[service]`.
- `specHash` = sha256 of the canonical JSON of `body` without the `selfbase.spec` label.
- `core` additionally: `networks` includes `proxyNetwork`, and the labels of spec 7.3 — router `sb-<ref>` with rule ``Host(`h1`) || Host(`h2`)`` from `hosts`, entrypoint, `tls=true`, `tls.certresolver` only when `certResolver` is set, service port 8080, an HTTP router `sb-<ref>-http` with middleware `sb-<ref>-redirect` (redirect to https). Each host must match `^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$`; a backtick or any other character is refused.
- Network body: bridge, `IPAM.Config:[{Subnet}]`, labels. `subnet` must be a /27 inside `node.subnetPool`, otherwise refused.
- `buildJob`: name `sb-<ref>-job-<type>`, image `selfbase-job`, `Cmd` fixed per type (`backup` → `["bash","/scripts/backup.sh"]`, `restore` → `["bash","/scripts/restore.sh"]`), `RestartPolicy:{Name:'no'}`, memory 512 MiB, one bind mount `backupHostDir` → `/backups` (the only bind the provisioner ever writes; refused when `backupHostDir` is empty), the project's `storage` volume at `/data/storage`, network `sb-<ref>` (or `controlNetwork` for `ref:'control'`, with no volume). `args.dir` must match `^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)?$` with no `.` or `..` segment. Allowed env keys: `PGHOST`, `PGPASSWORD`, `PGUSER`, `PGDATABASE`, `BACKUP_SUBDIR`, `BACKUP_RETENTION_DAYS`, `RESTORE_DIR`, `MANIFEST_B64`; any other key is refused. `clone`, `basebackup`, `volume-copy`, `migra-diff` → `ProvisionError(501,'not_implemented')`.

- [ ] **Step 1:** Tests. `template.test.ts`: the fixture validates; adding any one of `privileged`, `cap_add`, `ports`, `network_mode`, `pid`, `devices`, `build`, `labels`, `x-foo`, a top-level `networks`, a bind volume `/:/host`, `./rel:/x` or `C:\x:/y` throws `TemplateError` naming that key; `${A:-b}` renders `b`, `${A:?m}` throws with `m`, `$(cmd)` and `${A/b/c}` throw. `spec.test.ts`: for each size the per-service `Memory` equals `sizes.json` and `MemorySwap === Memory`; no body anywhere contains the keys `Privileged`, `CapAdd`, `Binds`, `PidMode`, `IpcMode`, `UsernsMode`, `Devices`, `PortBindings`, `NetworkMode:'host'` (deep scan of the JSON); only `core` lists the proxy network and carries `traefik.*` labels, all prefixed `sb-<ref>`; refs `'../x'`, `'SB'`, `'sb-other'`, 19 letters, 21 letters, `''`, `undefined` throw `invalid_ref` (Review Focus 1); host ``a`) || Host(`evil`` throws; subnet `10.208.0.0/27` and a `/24` throw with pool `10.207.0.0/16`; an image rendered to another registry throws; a service with no entry in `sizes.json` throws; `specHash` is stable across two calls and changes when one env value changes; `buildJob` with env key `LD_PRELOAD`, dir `../etc`, dir `a/b/c`, or empty `backupHostDir` throws; `buildJob` for `clone` throws 501; the backup job body has exactly one bind and it is `backupHostDir`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS; `wc -l provisioner/src/*.ts` recorded in the commit body.
- [ ] **Step 5:** Commit `feat: provisioner template validation and spec builder`.

### Task 7: Provisioner — Docker operations, HTTP API, socket-proxy allow-list

**Depends on:** Task 6. **Files:** `provisioner/src/{docker.ts,ops.ts,server.ts}`, `provisioner/socket-proxy.env`, `provisioner/Dockerfile`, `provisioner/test/{ops.test.ts,proxy.test.ts,compose.test.yml,fixture-image/Dockerfile}`.

**Interfaces — Consumes:** Task 6. **Produces (HTTP, JSON, `Authorization: Bearer <PROVISIONER_TOKEN>`, listens on `:8090`, control-stack network only):**

| Route | Body → Result |
|---|---|
| `GET /health` | → `{ok:true, templateVersion}` |
| `GET /projects` | → `[{ref, services:[ServiceState]}]` (from label filter `selfbase.managed=true`) |
| `GET /projects/:ref` | → `{ref, network:boolean, controlAttached:boolean, services:[ServiceState]}` |
| `POST /projects/:ref/ensure` | `EnsureInput` (+ `recreate?: string[]`) → the same shape as GET. Idempotent: creates the network, volumes and containers that are missing, recreates a container whose `selfbase.spec` differs or that is named in `recreate`, connects `core` to the proxy network and `selfbase-control` to `sb-<ref>`, starts in `depends_on` order. |
| `POST /projects/:ref/start`, `/stop` | `{services?: string[]}` → state |
| `DELETE /projects/:ref?volumes=true\|false` | → `{removed:{containers,volumes,network}}` |
| `POST /projects/:ref/attach-proxy` | → state |
| `POST /projects/:ref/jobs` | `{type, args, env}` → `{id}`; 409 `job_running` when any `sb-*-job-*` container is running |
| `GET /projects/:ref/jobs/:type` | → `{status:'running'\|'succeeded'\|'failed', exitCode, tail}`; a finished job container is removed on the read that reports it |
| `GET /projects/:ref/services/:service/logs?tail=` | → text |
| `GET /projects/:ref/services/:service/stats` | → `{mem_usage_mb, mem_limit_mb, cpu_percent}` |

`ServiceState = {service, exists, state, health, specHash, templateVersion, memLimitMb, proxyAttached}`. Errors: `{error:<code>, message}` with 400 / 401 / 404 / 409 / 501 / 502 (Docker refused). Request bodies are limited to 256 KiB. Env values are never logged; a log line carries the ref, the operation and the result code.

- `docker.ts`: `dockerFetch(method, path, body?)` over `fetch` to `DOCKER_HOST` (`http://selfbase-socket-proxy:2375`), API version prefix pinned. Objects are always addressed by name.
- `ensureImage(image)`: `GET /images/<name>/json` → use when present; otherwise `POST /images/create?fromImage=…` anonymously; failure → `ProvisionError(502,'image_unavailable')` naming the image (D-1).
- `provisioner/socket-proxy.env` — the allow-list for `wollomatic/socket-proxy` (pinned tag), one regex per method, exactly spec 7.5: `GET` `/_ping`, `/version`, `/info`, `/containers/json`, `/containers/sb-…/(json|logs|stats|wait)`, `/volumes/sb-…`, `/networks/sb-…`, `/images/…/json`; `POST` `/containers/create`, `/containers/sb-…/(start|stop|kill|restart|wait)`, `/volumes/create`, `/networks/create`, `/networks/sb-…/(connect|disconnect)`, `/networks/<PROXY_NETWORK>/(connect|disconnect)`, `/images/create`; `DELETE` `/containers/sb-…`, `/volumes/sb-…`, `/networks/sb-…`. Each pattern allows an optional `/v1.NN` prefix. Client restriction to the provisioner's address (`-allowfrom`). *(verify, upstream)*: whether the proxy can match the query string (`name=sb-…` on create, `fromImage=<REGISTRY>/…` on pull). If it can, add both; if not, record in the file's header that those two are enforced by the provisioner alone.
- The provisioner image bakes `template/compose.yml` to `/app/template.json` and copies `template/sizes.json`; it is validated at start, and a failure exits with code 1.

- [ ] **Step 1:** Tests against real Docker (`provisioner/test/compose.test.yml`: socket-proxy with `socket-proxy.env`, the provisioner, a locally built fixture image tagged for a test registry name, a fixture template of two services). `ops.test.ts`: ensure creates the network with the given /27, the volumes and containers with the labels; a second ensure changes nothing (same container ids); changing one env value recreates only that service; `recreate:['core']` recreates only core; stop then start; delete with `volumes=false` keeps volumes and with `true` removes them; a container removed by hand (`docker rm -f`) is recreated by ensure; a backup job with a fixture script runs, reports `succeeded` and is removed; a second job while one runs → 409; `GET /projects` lists only labelled objects; a wrong bearer → 401; an image that is neither local nor pullable → 502 `image_unavailable`. `proxy.test.ts` (requests sent straight to the socket proxy): `POST /containers/sb-x/exec`, `POST /build`, `POST /commit`, `GET /swarm`, `POST /containers/prune`, `POST /system/prune`, `GET /containers/<a non-sb container>/json`, `DELETE /volumes/<a non-sb volume>`, `POST /networks/<a non-sb network>/connect` each answer 403; the same inspect for an `sb-` container answers 200.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS; total `provisioner/src` under 1000 lines (state the count).
- [ ] **Step 5:** Commit `feat: provisioner docker operations behind a scoped socket proxy`.

### Task 8: Provisioner security review

**Depends on:** Tasks 5 and 7. **Files:** `docs/reviews/wave1-provisioner-security.md`, fixes in `provisioner/**`, `provisioner/test/refusal.test.ts`.

A review task, not a feature. The reviewer has not written Tasks 6–7.

- [ ] **Step 1:** Read all of `provisioner/src`, `socket-proxy.env`, the baked real template. Threat: `control` is fully compromised and holds `PROVISIONER_TOKEN`. For each API route and each field of `EnsureInput` / `JobInput`, write down what an attacker can reach. Required answers in the document: can any input produce a bind mount, a privileged or host-namespace container, a container, volume or network not named `sb-*`, an image outside our registry path, a Traefik label not prefixed `sb-<ref>` (router hijack of another team's host), a host rule outside what `hosts` validation allows, an env value that changes the command (`Cmd` is from the template only), a path outside `backupHostDir`, or a log line with a secret. What a compromised provisioner process itself could still do through the proxy (residual risk, spec 7.5).
- [ ] **Step 2:** For every finding write a failing test in `refusal.test.ts` first, then fix. At minimum the file asserts refusal of: a `hosts` entry that equals another project's host is **accepted by the provisioner** (uniqueness is control's job, Task 11) — state this boundary in the document; env keys containing `=` or a NUL; an env value over 64 KiB; a `templateVersion` that is not `^[0-9A-Za-z._-]{1,64}$`; a `service` path segment not in the template; `ref:'control'` on any route except jobs of type `backup`.
- [ ] **Step 3:** All provisioner tests PASS; line count still under 1000.
- [ ] **Step 4:** Commit `fix: provisioner hardening from the security review` and `docs: provisioner security review`. Findings the reviewer could not fix are listed for the controller, each with severity.

### Task 9: Control — skeleton, data model, secrets

**Depends on:** Task 3. **Files:** `control/src/{server.ts,app.ts,config.ts,db.ts,secrets.ts,ids.ts,project-secrets.ts,sizes.ts,errors.ts}`, `control/src/routes/{platform-auth.ts,platform-orgs.ts,v1.ts,platform-projects.ts,platform-transfer.ts}` (empty Hono routers), `control/src/jobs/{index.ts,project.ts,transfer.ts}` (empty exports), `control/migrations/0001-control.sql`, `control/test/{setup.ts,global-setup.ts,secrets.test.ts,schema.test.ts,ids.test.ts}`, `control/{package.json,vitest.config.ts,compose.test.yml}`, `scripts/gen-keys.mjs`, `scripts/test/gen-keys.test.mjs`.

**Interfaces — Produces:**
- `control/src/config.ts` (env, read once; a missing required value stops startup naming the key): `SELFBASE_MASTER_KEY` (base64 of exactly 32 bytes), `CONTROL_DB_PASSWORD`, `CONTROL_JWT_SECRET` (≥ 32 chars), `PROVISIONER_URL` (`http://selfbase-provisioner:8090`), `PROVISIONER_TOKEN`, `PUBLIC_URL` (`https://selfbase.<BASE>`), `BASE_DOMAIN`, `NODE_NAME` (`main`), `TEMPLATE_VERSION`, `MEMORY_BUDGET_MB` (16384), `OVERCOMMIT` (1.0), `SHARED_RESERVED_MB` (2720), `JOB_SLOT_MB` (512), `PROJECT_SUBNET_POOL` (`10.207.0.0/16`), `MAX_NEW_HOSTS_PER_WEEK` (3), `BRANCH_HOST_SLOTS` (2), `TEST_HOST` (`sb-test.<BASE>`), `CERT_PROBE` (`on`), `LOGS_URL` (`http://selfbase-logs:9428`), `BACKUP_RETENTION_DAYS` (7), `SMTP_*`.
- Before importing anything from `selfbase-core`, `control/src/db.ts` sets `process.env` so core's modules point at control-db: `DB_HOST=selfbase-control-db`, `POSTGRES_PASSWORD=<CONTROL_DB_PASSWORD>`, `JWT_SECRET=<CONTROL_JWT_SECRET>`, `PUBLIC_URL`, `SITE_URL=<PUBLIC_URL>`, `AUTH_DISABLE_SIGNUP=true`. Then at start: core's `applyMigrations` with core's platform directory (ledger `selfbase.platform_migrations`, creates the `auth` schema), then again with `control/migrations` (ledger `control.migrations`, lock key 7213015).
- `0001-control.sql`: schema `control` with every table and column of spec section 9, and: `projects.ref` unique with check `ref ~ '^[a-z]{20}$'`; `projects.subnet` unique; `host_slots.hostname` unique; `project_domains.hostname` unique; `project_secrets` unique `(project_id, name)`; `access_tokens.token_hash` unique; `memberships` unique `(org_id, user_id, project_id)` with role check; `jobs.status` check `pending|running|succeeded|failed`, plus `jobs.lane text` (`light|heavy`); one `nodes` row seeded from config. `settings` keys used this wave: `current_template_version`, `control_host_first_issued_at`.
- `secrets.ts`: `encrypt(ref: string, name: string, plaintext: string): { ciphertext: Buffer; nonce: Buffer; keyVersion: number }` (AES-256-GCM, random 96-bit nonce, AAD `` `${ref}:${name}` ``, tag appended to the ciphertext); `decrypt(ref, name, row): string` (throws `SecretError`); `putSecret(db, project: {id, ref}, name, kind: 'platform'|'function', value): Promise<void>`; `getSecrets(db, project: {id, ref}): Promise<Record<string, string>>`.
- `ids.ts`: `newRef(): string`, `REF_RE`, `newAccessToken(): { token: string; hash: string }` (`sbp_` + 40 hex; hash = sha256 hex), `hashToken(token): string`.
- `project-secrets.ts`: `generateProjectSecrets(ref: string, reuse?: Partial<ProjectSecrets>): ProjectSecrets` with keys `POSTGRES_PASSWORD`, `AUTHENTICATOR_PASSWORD`, `JWT_SECRET`, `ANON_KEY`, `SERVICE_ROLE_KEY`, `ADMIN_TOKEN`. Keys are HS256 JWTs `{role, iss:'selfbase', ref, iat, exp: +10 years}` signed with `JWT_SECRET`. A reused `JWT_SECRET` requires reused `ANON_KEY` and `SERVICE_ROLE_KEY` (throws otherwise). Passwords are 32 random bytes base64url.
- `sizes.ts`: reads `template/sizes.json`; `projectCapMb(size): number`.
- `app.ts` mounts: `/platform` → `platform-auth`, `platform-orgs`, `platform-projects`, `platform-transfer`; `/v1` → `v1Orgs` (a second router exported by `platform-orgs.ts`) and `v1`; static Studio from `STUDIO_DIR` with `index.html` fallback for non-API paths; `GET /health`. Later tasks fill the router files. Only two later edits to `app.ts` are allowed: Task 10 adds the `authenticate`, origin and `audit` middleware lines, Task 13 adds the `paused` host check as the first middleware. `server.ts`: Task 12 adds `startWorkers` and `startReconcile`, Task 14 adds the schedule.
- `scripts/gen-keys.mjs --control`: prints `SELFBASE_MASTER_KEY`, `CONTROL_DB_PASSWORD`, `CONTROL_JWT_SECRET`, `PROVISIONER_TOKEN` as env lines to stdout (the operator redirects it into a 0600 file). Without the flag it behaves as v1.

- [ ] **Step 1:** Tests. `secrets.test.ts`: round trip; a row encrypted for `(refA,'JWT_SECRET')` fails to decrypt as `(refB,'JWT_SECRET')` and as `(refA,'ANON_KEY')`; one flipped ciphertext bit fails; two encryptions of one value differ; a master key of 31 bytes stops startup; `getSecrets` returns what `putSecret` stored and the `ciphertext` column never contains the plaintext bytes. `schema.test.ts`: every table and column of spec section 9 exists (compare against a list in the test); inserting a project with ref `Abc` fails; two projects with one subnet fail; migrations run twice without error. `ids.test.ts`: 1000 refs match `^[a-z]{20}$` and are distinct; a token matches `^sbp_[0-9a-f]{40}$`. `gen-keys.test.mjs`: `--control` output has the four names, the master key decodes to 32 bytes.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat: control-plane data model and secret encryption`.

### Task 10: Control — dashboard accounts, organizations, roles, access tokens, audit

**Depends on:** Tasks 4 and 9. **Files:** `control/src/routes/{platform-auth.ts,platform-orgs.ts}`, `control/src/{session.ts,authz.ts,audit.ts,cli.ts}`, `control/src/app.ts` (middleware lines only), `control/test/{accounts.test.ts,authz.test.ts,audit.test.ts}`.

**Interfaces — Consumes:** core's auth router (`selfbase-core/src/auth/index.ts`), `verify` (`selfbase-core/src/jwt.ts`), core's mail module; Task 9. **Produces:**
- `session.ts`: `authenticate` middleware for `/platform/*` and `/v1/*`, setting `c.get('user'): { id: string; email: string; via: 'cookie' | 'token' }`. `/platform` accepts the cookie or `Authorization: Bearer sbp_…`; `/v1` accepts the bearer only. 401 `{message:'Unauthorized'}` otherwise. Cookie requests with a method other than GET/HEAD must carry an `Origin` equal to `PUBLIC_URL`'s origin (403 otherwise). Cookies: `sb_studio` (access token, 1 h) and `sb_studio_refresh` (path `/platform/refresh`), both `HttpOnly; SameSite=Strict`, `Secure` when `PUBLIC_URL` is https. Tokens never appear in a response body.
- Routes: `POST /platform/login {email,password}` (calls the mounted core router's `/token?grant_type=password` in-process with the caller's IP, so core's rate limit and ban checks apply) → `{email}`; `POST /platform/refresh`; `POST /platform/logout`; `GET /platform/me` → `{id, email, organizations:[{id, slug, name, role}]}`; core's `/recover`, `/verify` and `PUT /user` reachable under `/platform/auth/v1/`.
- `authz.ts`: `type Role = 'owner'|'administrator'|'developer'|'read_only'`; `type Action = 'project.read'|'project.write'|'project.sql'|'project.keys'|'project.manage'|'org.members'|'org.tokens'|'org.owner'`; `can(role: Role, action: Action): boolean` — read_only: `project.read`; developer: + `project.write`, `project.sql`, `project.keys`; administrator: + `project.manage`, `org.members`; owner: + `org.owner`. `org.tokens` is every member for their own tokens. `authorize(c, action, scope: { orgId: string; projectId?: string }): Promise<Role>` — 403 `{message:'Forbidden'}`; a membership with `project_id` applies only to that project.
- Organizations: `GET /platform/organizations`, `POST /platform/organizations {name}` (slug derived, creator becomes owner), `GET|PATCH|DELETE /platform/organizations/:slug/members[/:userId]` (the last owner cannot be removed or demoted: 409), `POST /platform/organizations/:slug/invitations {email, role, project_ref?}` → 201 `{id, expires_at, link?}` (`link` only when SMTP is not configured; the token is stored hashed, 7 days), `POST /platform/invitations/accept {token, password}`.
- Access tokens: `GET /platform/access-tokens`, `POST {name, expires_at?}` → `{id, name, token}` (the only time the token is returned), `DELETE /:id`. Use updates `last_used_at` at most once a minute.
- `/v1`: `GET /v1/organizations` (`v1-list-all-organizations`), `GET /v1/organizations/{slug}` (`v1-get-an-organization`), `GET /v1/organizations/{slug}/members` (`v1-list-organization-members`) — on the `v1Orgs` router exported by `platform-orgs.ts` (Task 9's `app.ts` already mounts it).
- `audit.ts`: middleware on every non-GET `/platform` and `/v1` request, after the handler: one `audit_log` row `actor` (email), `org_id`, `project_id`, `action` (`<METHOD> <route pattern>`), `target`, `ip`, `details` = `{status, body_keys: string[]}` — keys of the JSON body, never values. `GET /platform/organizations/:slug/audit-log?limit=&before=`.
- `cli.ts create-owner <email>`: reads the password from stdin (min 12 chars), creates the confirmed user, an organization `default` and the owner membership; refuses when any user exists. Prints the email only.

- [ ] **Step 1:** Tests. `accounts.test.ts`: `create-owner` then login sets both cookies and the JSON body has no token; a second `create-owner` is refused; `POST /auth/v1/signup` under any mounted path creates no user; wrong password 400 and the sixth attempt inside the window 429; `/platform/me` without a cookie 401; a POST with the cookie and `Origin: https://evil.example` 403; a created token works on `/v1/organizations`, its hash (not the token) is in the table, and after delete it answers 401; a `sbp_` token on `/platform/me` works, a cookie on `/v1/organizations` answers 401; invitation accept creates the membership and the same token a second time fails; an expired invitation fails. `authz.test.ts`: the full role × action table as data; a project-scoped developer gets 403 on another project of the same organization; removing the last owner 409. `audit.test.ts`: `POST /platform/access-tokens` writes a row whose `details.body_keys` is `['name']` and whose JSON does not contain the token; a GET writes nothing.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat: dashboard accounts, organizations, roles and access tokens`.

### Task 11: Control — admission, subnets, hostname slots and the new-host cap

**Depends on:** Task 9. **Files:** `control/src/{admission.ts,subnets.ts,hosts.ts}`, `control/test/{admission.test.ts,subnets.test.ts,hosts.test.ts}`.

**Interfaces — Produces:**
- `admission.ts`: `RUNNING_STATUSES` (every status except `INACTIVE`, `REMOVED`); `usedMb(db): Promise<number>` (sum of `projectCapMb(size)` over running projects); `admit(db, want: { size: Size; excludeProjectId?: string }): Promise<void>` — throws `AdmissionError('insufficient_memory', { neededMb, freeMb })` when `SHARED_RESERVED_MB + JOB_SLOT_MB + usedMb + projectCapMb(size) > MEMORY_BUDGET_MB × OVERCOMMIT`; `capacity(db)` → `{budget_mb, reserved_mb, job_slot_mb, used_mb, free_mb}`.
- `subnets.ts`: `allocateSubnet(db): Promise<string>` — the lowest free /27 of `PROJECT_SUBNET_POOL`; relies on the unique constraint and retries on conflict; `SubnetError('pool_exhausted')`.
- `hosts.ts`:
  - `allocateHost(db, p: { projectId: string; ref: string; pool: 'project' | 'test' }): Promise<{ hostname: string; isNew: boolean }>` — in one transaction under `pg_advisory_xact_lock`: a free `host_slots` row of that pool (null `project_id`) is taken first (`isNew:false`); otherwise for `project` a new slot `<ref>.<BASE_DOMAIN>` is created when `newHostsThisWeek(db) < MAX_NEW_HOSTS_PER_WEEK`, else `HostError('new_host_cap', { cap, retryAfter })`; for `test` the single slot `TEST_HOST` is created on first use (counted like any new host) and `HostError('test_host_busy')` when taken. Writes the `project_domains` row (`kind:'default'`).
  - `newHostsThisWeek(db): Promise<number>` — `host_slots` rows with `first_issued_at` in the last 7 days, plus 1 when `settings.control_host_first_issued_at` is in the last 7 days.
  - `releaseHost(db, projectId): Promise<void>` — the slot keeps its row with `project_id` null; the project's `default` domain row is deleted.
  - `addDomain(db, projectId, hostname, kind: 'legacy' | 'custom')` / `removeDomain`. `custom` under `BASE_DOMAIN` is refused (`HostError('custom_under_base')`); a hostname already in `project_domains` is refused; neither kind counts against the cap.
  - `hostsOf(db, projectId): Promise<string[]>` — default first.
- Error messages are complete sentences a Studio user can act on (the cap message names the cap and the date a host becomes available).

- [ ] **Step 1:** Tests. `admission.test.ts`: with the defaults 11 micro are admitted and the 12th throws with `freeMb` 128; one small plus 9 micro fit and a 10th micro throws; a paused project does not count and resuming it is refused when the budget is full; `OVERCOMMIT=1.5` admits more (setting stays functional). `subnets.test.ts`: first is `10.207.0.0/27`, second `10.207.0.32/27`; a freed subnet is reused; 20 concurrent allocations give 20 distinct subnets. `hosts.test.ts`: cap 3 with the control host recorded today → two new project hosts succeed and the third throws `new_host_cap`; release then allocate returns the freed hostname with `isNew:false` and it does not count; **two concurrent allocations with one new host left → exactly one succeeds** (Review Focus 3, run 20 times); a slot issued 8 days ago does not count; the test pool gives `TEST_HOST`, a second concurrent holder gets `test_host_busy`; `custom` under the base domain is refused; a duplicate hostname is refused.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat: admission control, subnet allocation and hostname slots with a weekly cap`.

### Task 12: Control — jobs engine, provisioner client, project lifecycle, reconcile

**Depends on:** Task 11 (and the contract of Task 7, exercised against a fake). **Files:** `control/src/jobs/{index.ts,engine.ts,project.ts}`, `control/src/{provisioner.ts,reconcile.ts,project-env.ts,cert.ts}`, `control/src/server.ts` (two start lines), `control/test/{engine.test.ts,lifecycle.test.ts,reconcile.test.ts,project-env.test.ts,fake-provisioner.ts}`.

**Interfaces — Produces:**
- `provisioner.ts`: `interface Provisioner { list(); inspect(ref); ensure(input: EnsureInput & { recreate?: string[] }); start(ref, services?); stop(ref, services?); remove(ref, volumes: boolean); attachProxy(ref); runJob(ref, type, args, env); jobStatus(ref, type); logs(ref, service, tail); stats(ref, service) }` and `httpProvisioner(url, token): Provisioner` — one method per Task 7 route, same shapes. A provisioner error becomes `ProvisionerError(code, message)`; env is never included in an error.
- `engine.ts`: `defineJob(type: string, lane: 'light' | 'heavy', steps: { name: string; run(ctx: JobCtx): Promise<void> }[])`; `enqueue(db, { type, projectId?, payload, createdBy }): Promise<string>` (payload is validated to contain no key of `ProjectSecrets` and no value longer than 2048 chars); `startWorkers(deps)` — one worker per lane, claims with `for update skip locked`; `jobs.step` is the index of the next step and is advanced in the same transaction that records the `job_events` row; on start, `running` jobs are picked up again from `jobs.step`; a step that throws is retried up to 3 attempts with backoff, then the job is `failed` with `error` = the error's message (never its cause chain) and the project's status is set by the job's `onFail`. `JobCtx = { db, provisioner, job, project, log(event: string, fields?) }`.
- `project-env.ts`: `buildEnv(project, secrets: Record<string,string>, config: Record<string, unknown>, hosts: string[]): Record<string, string>` — the template environment of Task 5: secrets, `PROJECT_REF`, `PUBLIC_URL=https://<hosts[0]>`, auth/postgrest/storage values from `project_config`, `AUTH_REDIRECT_ALLOWLIST` etc. as v1's names; third-party secrets (`SMTP_PASS`, `GOOGLE_CLIENT_SECRET`, `AUTH_SMS_HOOK_SECRET`) come from `project_secrets`.
- `cert.ts`: `probeCertificate(hostname): Promise<'ok' | 'pending'>` — an HTTPS `GET /health` with verification, 5 s timeout; cached 60 s; always `'ok'` when `CERT_PROBE=off`.
- Jobs in `project.ts` (each step idempotent, re-running a finished step changes nothing):
  - `project.create` (light): `allocate` (subnet, host; stores them) → `secrets` (generate and store unless present) → `ensure` → `healthy` (poll `inspect` until every service is healthy, 120 s) → `certificate` (poll the probe up to 10 min) → `activate` (`ACTIVE_HEALTHY`). The project is `COMING_UP` until the last step. On failure: `onFail` releases nothing (the operator deletes or retries).
  - `project.pause` (light): `stop` → status `INACTIVE`, `paused_at`. `project.restore` (light): `admit` → `start` → `healthy` → `ACTIVE_HEALTHY`.
  - `project.delete` (light): `remove(ref, true)` → `releaseHost` → delete the `project_secrets` rows → status `REMOVED`.
  - `project.apply` (light, payload `{recreate: string[]}`): `ensure` with the current env and `recreate`. Used by domain changes and by `project.upgrade`, which first sets `template_version` to `settings.current_template_version` and status `UPGRADING`.
- `createProject(db, input: { orgId, name, size, pool: 'project' | 'test', createdBy, reuseSecrets?, dbPass? }): Promise<{ project, jobId }>` — runs `admit` first, inserts the row with `newRef()`, enqueues `project.create`. `reuseSecrets` and `dbPass` are encrypted into `project_secrets` here, in the request, and never enter the payload.
- `reconcile.ts`: `reconcileOnce(deps): Promise<ReconcileReport>` and `startReconcile(deps)` (every 30 s and on `requestReconcile()`). For each project without a `pending|running` job: desired running but a container missing, exited, or with a different `specHash` / template version → enqueue `project.apply`; `core` not on the proxy network → `attachProxy`; control not attached → `ensure`; desired `INACTIVE` but running → `stop`; `ACTIVE_HEALTHY` with a failing probe → `COMING_UP` and back when it passes; unhealthy containers → `ACTIVE_UNHEALTHY`. `sb-*` objects whose ref has no project row are **reported, never removed**.
- On start, when `settings.current_template_version` is unset it is set to `TEMPLATE_VERSION`.

- [ ] **Step 1:** Tests, with `fake-provisioner.ts` (an in-memory implementation of `Provisioner` that records calls and can be told to fail or to report states). `engine.test.ts`: steps run in order and `job_events` has one row per step; a step failing twice then succeeding ends `succeeded` with `attempts` 3; three failures end `failed` and later steps never ran; **a worker stopped after step 2 of 4 and a new worker started → steps 3 and 4 run once, steps 1 and 2 are not run again** (Review Focus 4, engine half); a heavy job does not block a light one; two workers never run one job twice; `enqueue` with a payload key `JWT_SECRET` throws. `lifecycle.test.ts`: create ends `ACTIVE_HEALTHY` with a subnet, a default domain, six secrets and exactly one `ensure` whose env has every key of Task 5's list; **the same create with the process "killed" after `ensure` returned and resumed → the fake saw the network and each container created once** (Review Focus 4); create over budget throws before any row exists; pause then restore; restore over budget is refused and the project stays `INACTIVE`; delete frees the host slot, removes secrets, calls `remove(ref,true)`; the next project in that pool reuses the hostname; a probe stuck on `pending` keeps the project `COMING_UP`; `project.apply` after `addDomain` passes both hosts. `reconcile.test.ts`: a missing container → `project.apply` enqueued once even after three passes; a detached proxy network → `attachProxy`; a running container of a paused project → `stop`; an unknown `sb-` ref is in the report and no remove call is made; a project with a running job is skipped. `project-env.test.ts`: the env equals a fixture for a given config; no undefined values.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat: jobs engine, project lifecycle and reconcile loop`.

### Task 13: Control — `/v1` and `/platform` project API, admin forwarding, logs, paused answer

**Depends on:** Tasks 10 and 12. **Files:** `control/src/routes/{v1.ts,platform-projects.ts}`, `control/src/{forward.ts,logs.ts,paused.ts,health.ts}`, `control/src/app.ts` (the `paused` line only), `docs/reference/management-api.json`, `docs/reference/README.md`, `control/test/{v1.test.ts,platform-projects.test.ts,forward.test.ts,openapi.test.ts}`.

**Interfaces — Consumes:** `authenticate`, `authorize`, `audit`; `createProject`, `enqueue`, `hostsOf`, `addDomain`, `capacity`, `Provisioner`. **Produces:**
- `docs/reference/management-api.json`: Supabase's published Management API OpenAPI document, fetched once from `https://api.supabase.com/api/v1-json`; `README.md` records the date and the sha256. *(verify, upstream)*: the operationIds below are from memory — the snapshot is authoritative, and a mismatch is fixed in our route table, not in the snapshot.
- `/v1` (bearer only):

  | Route | operationId | Notes |
  |---|---|---|
  | `GET /v1/projects` | `v1-list-all-projects` | projects of the caller's organizations |
  | `POST /v1/projects` | `v1-create-a-project` | `name`, `organization_id` or `organization_slug`, `db_pass` (when sent it becomes the superuser password, as at Supabase; URL-safe characters only), `region` ignored, `desired_instance_size` ∈ micro, small, medium → 201, status `COMING_UP` |
  | `GET /v1/projects/{ref}` | `v1-get-project` | |
  | `DELETE /v1/projects/{ref}` | `v1-delete-a-project` | `project.manage` |
  | `POST /v1/projects/{ref}/pause` | `v1-pause-a-project` | |
  | `POST /v1/projects/{ref}/restore` | `v1-restore-a-project` | 400 with the admission message when refused |
  | `GET /v1/projects/{ref}/health` | `v1-get-services-health` | `services` query; per service `{name, healthy, status}` from container health (`db`, `rest`, `auth`/`realtime`/`storage` = core, `pooler`) |
  | `GET /v1/projects/{ref}/api-keys` | `v1-get-project-api-keys` | `anon` and `service_role`, `type:'legacy'`; `reveal=true` needs `project.keys`, otherwise `api_key` is masked |
  | `POST /v1/projects/{ref}/database/query` | `v1-run-a-query` | `{query}`; `project.sql`; forwards to core's `/admin/sql`; success → rows as an array of objects; an SQL error → 400 `{message}` |

  Project JSON: `id` and `ref` = ref, `organization_id`, `name`, `region` = `NODE_NAME`, `status`, `created_at`, `database: { host: 'db', version: '17', postgres_engine: '17', release_channel: 'ga' }`. Fields we cannot fill get neutral values and are not dropped. Errors `{message}`.
- `/platform` (cookie or bearer):
  - `GET /platform/projects?organization_slug=` · `POST /platform/projects {organization_slug, name, size, pool?: 'project'|'test'}` → 201 `{project, job_id}` · `GET /platform/projects/:ref` → the `/v1` object plus `size`, `template_version`, `current_template_version`, `urls: {api, legacy: string[]}`, `certificate: 'ok'|'pending'`, `smtp_configured: boolean`, `services: ServiceState[]`, `last_job: {id, type, status, step, error} | null` · `POST /platform/projects/:ref/{pause,restore,upgrade}` → `{job_id}` · `DELETE /platform/projects/:ref` with body `{confirm_name}` equal to the project name.
  - `GET /platform/projects/:ref/api-keys` (masked) · `POST …/api-keys/reveal {name: 'anon'|'service_role'}` → `{api_key}` (`project.keys`, audited).
  - `GET|POST|DELETE /platform/projects/:ref/domains` — `{hostname, kind}`; a change enqueues `project.apply {recreate:['core']}`.
  - `GET /platform/projects/:ref/jobs`, `GET /platform/jobs/:id` → `{id, type, status, step, steps: string[], error, events: [{at, event}]}`.
  - `GET /platform/projects/:ref/logs?service=db|rest|core|fn|pooler&limit=≤1000&start=<ISO>` → `[{ts, msg}]` newest first. `logs.ts` queries VictoriaLogs `LOGS_URL/select/logsql/query` with a query built only from the validated ref and the service enum (`app_name:="sb-<ref>-<service>"`); when the log store is unreachable it falls back to the provisioner's `logs` tail and sets header `x-selfbase-log-source: container`.
  - `GET /platform/capacity` → `capacity()` plus `projects: [{ref, name, size, cap_mb, status, mem_usage_mb}]`, `new_hosts_this_week`, `max_new_hosts_per_week`.
  - `ALL /platform/projects/:ref/admin/*` → `forward.ts`: `GET`/`HEAD` need `project.read`, anything else `project.write`, `/admin/sql` always `project.sql`; forwarded to `http://sb-<ref>-core:8081/admin/*` with the project's `ADMIN_TOKEN` and `x-selfbase-actor: <email>`; the caller's `Authorization` and cookies are stripped; request and response bodies are streamed (file upload and download); an unreachable core → 502 `{message:'project is not reachable'}`; a project that is not running → 409.
- `paused.ts`: a request whose `Host` is not `PUBLIC_URL`'s host is answered before any route: 540 `{message:'project paused'}` when the host is in `project_domains` of an `INACTIVE` project, otherwise 404 `{message:'not found'}`. No Studio file and no API route is ever served on another host.

- [ ] **Step 1:** Tests (fake provisioner; a stub HTTP server stands in for a project's `core:8081`). `openapi.test.ts`: every `/v1` route we register exists in the snapshot with that method; each handler's declared operationId matches the snapshot; a response of each route validates against the snapshot's response schema for its status (required fields present, types equal). `v1.test.ts`: create → 201 and a `project.create` job; a developer cannot delete (403); a member of another organization gets 404 for the ref; `api-keys` without reveal shows no full key; `database/query` `select 1 as a` → `[{a:1}]`, a syntax error → 400; a cookie is not accepted. `platform-projects.test.ts`: create with size `large` → 400; delete with a wrong `confirm_name` → 400; reveal writes an audit row without the key; logs with `service=core;x` → 400; logs with the store down come from the container tail with the header; capacity numbers add up; a domain add enqueues `project.apply`. `forward.test.ts`: the stub receives the project's token and the actor header and never the caller's cookie; read_only can GET and gets 403 on POST; developer reaches `/admin/sql`, read_only does not; a 30 MiB upload passes through unbuffered; `Host: <paused project's host>` → 540 on every path including `/platform/login`; an unknown host → 404.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat: management api for projects, admin forwarding and log queries`.

### Task 14: Control — backup, export, import; `scripts/import-project.mjs`

**Depends on:** Task 13. **Files:** `control/src/routes/platform-transfer.ts`, `control/src/jobs/transfer.ts`, `control/src/{envfile.ts,manifest.ts,schedule.ts}`, `control/src/server.ts` (the schedule line), `job/{Dockerfile,backup.sh,restore.sh,test/job.test.sh}`, `scripts/import-project.mjs`, `scripts/test/import-project.test.mjs`, `control/test/{envfile.test.ts,manifest.test.ts,transfer.test.ts,leak.test.ts}`.

**Interfaces — Consumes:** `enqueue`, `defineJob`, `createProject`, `Provisioner.runJob/jobStatus/stop/start`, `putSecret`, `getSecrets`. **Produces:**
- `job/backup.sh`: v1's one-shot backup (no `--daily` loop) writing `/backups/${BACKUP_SUBDIR}/<UTC ts>/{db.dump,globals.sql,storage.tar.gz,MANIFEST}` with v1's temp-dir-then-rename and retention inside that subdirectory; when `MANIFEST_B64` is set it also writes `project.json` and lists it in MANIFEST; the last stdout line is `backup: wrote <subdir>/<ts>`. For the control database (`BACKUP_SUBDIR=control`, no storage mount) the storage archive is skipped.
- `job/restore.sh`: runs **inside** the job container against stopped services. Verifies MANIFEST (sizes and sha256) of `/backups/${RESTORE_DIR}` and refuses before any change; then v1's restore logic: cron jobs set inactive, `pg_restore --clean --if-exists --single-transaction --exit-on-error`, storage extracted to a temp directory inside the volume and swapped in. After a successful restore: if the dump's table of contents has no `platform_migrations` entry, `drop table if exists selfbase.platform_migrations` (so core adopts the v1 database and applies `0002`+). Exit codes as v1: 10 database unchanged, 3 database restored but storage failed.
- `envfile.ts`: `parseV1Env(text: string): { secrets: Partial<ProjectSecrets> & Record<string, string>; config: Record<string, unknown>; ignored: string[]; unknown: string[] }` — recognises v1's `.env.example` keys; `JWT_SECRET`, `ANON_KEY`, `SERVICE_ROLE_KEY`, `SMTP_PASS`, `GOOGLE_CLIENT_SECRET`, `AUTH_SMS_HOOK_SECRET` → secrets; auth, SMTP host/port/user/from, Google client id, `SITE_URL`, storage limit → config; `POSTGRES_PASSWORD`, `PANEL_*`, `PUBLIC_URL`, `CORE_*`, `SUPABASE_DIR`, `BACKUP_*`, `PGRST_URL`, `FN_URL`, `TRUST_PROXY`, migration keys, and the keys a container adds by itself (`PATH`, `HOME`, `HOSTNAME`, `NODE_*`, `YARN_VERSION`, `COOLIFY_*`, `SOURCE_COMMIT`, `DB_HOST`, `STORAGE_DIR`, `PORT`, `NODE_ENV`) → `ignored`; anything else → `unknown`. `ignored` and `unknown` are key names. A duplicate key or a line that is not `KEY=value` / comment / blank → `EnvFileError` naming the line number, never its content.
- `manifest.ts`: `sealManifest(data: { config, secrets }, passphrase: string): string` (scrypt N=2^15 → AES-256-GCM, base64 JSON `{v:1, salt, nonce, ciphertext, config}` — config in clear, secrets sealed) and `openManifest(text, passphrase)`; a wrong passphrase throws `ManifestError('bad_passphrase')`. Passphrase min 12 chars.
- Routes: `POST /platform/projects/:ref/backups` → `{job_id}` (`project.manage`); `GET /platform/projects/:ref/backups` (rows of `backups`); `POST /platform/projects/:ref/export {passphrase}` → `{job_id}` — the manifest is sealed in the request and only the sealed text goes into the payload; `POST /platform/projects/import` multipart `organization_slug`, `name`, `size`, `backup_dir`, and exactly one of `env_file` (a v1 env file, ≤ 64 KiB) or `passphrase` (for a `project.json` in the directory) → 202 `{project, job_id, ignored, unknown}`. The env file is parsed and its secrets are encrypted into `project_secrets` in the request; the upload is not stored.
- Jobs (heavy lane): `project.backup` — `runJob(ref,'backup',{}, {PGHOST:'db', PGPASSWORD, BACKUP_SUBDIR: ref, BACKUP_RETENTION_DAYS})` → poll → insert the `backups` row (`kind:'logical'`, `location`, `size_bytes`); `PGPASSWORD` is read from `project_secrets` inside the step and passed to the provisioner call only. `project.export` — the same with `BACKUP_SUBDIR: 'export-<ref>'` and `MANIFEST_B64`. `project.import` — `create` steps up to `healthy` with status `RESTORING` → `stop` core, rest, fn, pooler → `restore` job with `RESTORE_DIR` → `start` → `healthy` → `certificate` → `ACTIVE_HEALTHY`; a restore exit code 10 fails the job with "the database was not changed". `control.backup` — `runJob('control','backup',…)` against `selfbase-control-db`.
- `schedule.ts`: at 03:15 UTC daily enqueue `control.backup` and one `project.backup` per `ACTIVE_HEALTHY` project (they run one at a time on the heavy lane). A missed run (control was down) is not replayed.
- `scripts/import-project.mjs --url <control url> --org <slug> --name <n> --size <s> --backup-dir <dir> --env-file <path>`: token from env `SELFBASE_ACCESS_TOKEN`; posts the multipart form; polls the job; prints the project ref, job steps, and the `ignored` / `unknown` key names. Prints no value from the env file and refuses an `http://` URL unless the host is `localhost`. It uses Node's standard library only, so it also runs from the control image (the server needs no Node).

- [ ] **Step 1:** Tests. `envfile.test.ts`: v1's `.env.example` with values filled parses with no `unknown`; `PANEL_ADMIN_PASSWORD_HASH` is in `ignored`; `FOO=bar` is in `unknown`; a duplicate `JWT_SECRET` throws with the line number and the message does not contain the value; `JWT_SECRET` without `ANON_KEY` is rejected by the import route with 400. `manifest.test.ts`: round trip; wrong passphrase throws; the sealed text does not contain any secret value. `job.test.sh` (real containers from `template/compose.test.yml` plus the job image): backup → MANIFEST matches the files; corrupt one byte → restore refuses and the database is unchanged; a v1-style dump (built from `core/test/fixtures/v1-bootstrap`, one user row, one storage file) restores into a database where the platform migrations ran, the ledger is dropped, and after core starts the ledger holds `0001`…current and the user row and file are there; restoring a v2 dump keeps its ledger. `transfer.test.ts` (fake provisioner): import calls `ensure`, `stop` of the four services, `runJob('restore')`, `start` in that order and ends `ACTIVE_HEALTHY` with the env file's `JWT_SECRET` stored and a freshly generated `POSTGRES_PASSWORD`; `backup_dir` `../x` → 400; export payload contains the sealed manifest and not the passphrase; the schedule enqueues one job per active project and none for a paused one. `leak.test.ts` (Review Focus 5): run a create, an export, and an import whose restore job fails with exit 10, with stdout/stderr captured; then assert that none of the project's secret values, the passphrase, or any value from the env file occurs in any `jobs.payload`, `jobs.error`, `job_events`, `audit_log` row, any HTTP response body of the run, or the captured output. `import-project.test.mjs`: against a local stub the script sends the multipart fields and its output contains no value from the env file; `http://example.com` is refused.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat: backup, export and import jobs with an import script`.

### Task 15: Studio — shell, sign-in, organization screens

**Depends on:** Task 2 (contracts of Tasks 10 and 13). **Files:** `studio/**` except `studio/src/project/**` and `studio/e2e/project.spec.ts`; `control/Dockerfile` (Studio build stage; output to `STUDIO_DIR`).

**Interfaces — Consumes:** the `/platform` routes of Tasks 10 and 13 as specified there. **Produces:**
- Vite `base: '/'`; history routing with these URLs (the router library is the builder's choice): `/sign-in`, `/invite/:token`, `/reset-password`, `/org/:slug` (projects), `/org/:slug/{members,tokens,audit,capacity}`, `/new/:slug` (create project), `/import/:slug`, `/project/:ref/*` (rendered by `studio/src/project/index.tsx`, a placeholder in this task that exports `default function ProjectArea()`).
- `studio/src/api.ts`: `request<T>(method, path, opts?)` against `/platform`, `credentials: 'same-origin'`; on a 401 it calls `POST /platform/refresh` once and retries, then signs out. `ApiError` as in v1. `projectAdmin(ref)` returns v1's `api` object (same method names and types) bound to `/platform/projects/<ref>/admin`.
- Layout follows the Supabase dashboard as v1 did: organization switcher, project list as cards with status badge (`COMING_UP`, `ACTIVE_HEALTHY`, `INACTIVE`, `RESTORING`, `UPGRADING`, plus "sertifika bekleniyor" when `certificate:'pending'`). v1's styles, `ui.tsx` and `Grid.tsx` are kept.
- Screens: sign-in; accept invitation; projects list; create project (name, size with the MiB totals, shows free memory and hosts left this week from `/platform/capacity`, then the job's steps live until `ACTIVE_HEALTHY`); import project (name, size, backup directory, env file upload; shows `ignored` / `unknown` key names; job steps); members (invite, change role, remove); access tokens (the new token is shown once with a copy button); audit log; capacity (budget bar, per-project rows). UI text Turkish.
- A refused create shows the server's message unchanged (admission and host-cap messages are written for the user).

- [ ] **Step 1:** `studio/e2e/shell.spec.ts` (Playwright with `page.route` fixtures in `studio/e2e/fixtures/*.json`, one per route, shaped exactly as Tasks 10 and 13 specify): sign-in shows the projects of the organization; a wrong password shows the error and stays; create project posts `{organization_slug,name,size}` and follows the job to the project URL; a 400 with the host-cap message shows that message; the token screen shows the token once and not after a reload; a read_only fixture hides create, import and member actions; a 401 on any call triggers one refresh then the sign-in screen; at 375 px nothing overflows horizontally.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS; `npm run build -w studio` succeeds and the control image serves it at `/`.
- [ ] **Step 5:** Commit `feat: studio shell, sign-in and organization screens`.

### Task 16: Studio — project screens

**Depends on:** Task 15. **Files:** `studio/src/project/**`, `studio/e2e/{project.spec.ts,fixtures/project-*.json}`, `git mv studio/src/pages/{Tables,Policies,Sql,Users,Files}.tsx studio/src/project/`, `studio/src/pages/Login.tsx` (deleted), `docs/screens/v2/*.png`.

**Interfaces — Consumes:** `projectAdmin(ref)`, `request`, the project routes of Task 13 and the transfer routes of Task 14.

- Left navigation per project: Ana sayfa, Tablolar, SQL, Kimlik doğrulama → Kullanıcılar, Depolama → Dosyalar, Veritabanı → RLS, Günlükler, Ayarlar. URLs `/project/:ref/{home,editor,sql,auth/users,storage,policies,logs,settings}`.
- The five v1 screens work unchanged in behaviour; their only change is the API object (`projectAdmin(ref)` instead of the module-level `api`). The SQL editor becomes CodeMirror 6 (spec 8.6; removes v1's textarea shortcut); Ctrl+Enter still runs.
- Home: status, API URL and legacy URLs, anon key (copy), service_role key behind "göster" (calls reveal), services with health and memory use, last job.
- Logs: service selector, last 200 lines, refresh, a notice when the source header says `container`.
- Settings: general (name, ref, size, template version, "güncelle" when `current_template_version` differs); API keys; domains (list, add legacy/custom, remove); backups (list, "şimdi yedekle", export with a passphrase field typed twice); pause / restore; delete (type the project name).
- Controls a role may not use are not rendered (role from `/platform/me`).

- [ ] **Step 1:** `project.spec.ts` (route fixtures): the v1 smoke flow (insert a row and see it, `select 1`, add a policy, users list, upload a file and see it) passes against `/platform/projects/<ref>/admin/*` fixtures; home shows the masked service key and the full one after "göster"; logs render and the fallback notice appears with the header; delete is disabled until the name matches; a paused project shows "Devam ettir" and no editor; a developer sees SQL, a read_only user does not; 375 px without horizontal overflow.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS; screenshots of home, logs and settings saved under `docs/screens/v2/`.
- [ ] **Step 5:** Commit `feat: studio project screens on the platform api`.

### Task 17: Control stack compose, both proxy modes, end-to-end proof

**Depends on:** Tasks 5, 8, 10, 13, 14, 16. **Files:** `control/{compose.yml,compose.build.yml,.env.example,traefik-socket-proxy.env}`, `control/Dockerfile` (final), `test/e2e/{stack.test.mjs,helpers.mjs,README.md}`, `.github/workflows/ci.yml` (the reserved `e2e` block only), `scripts/install-check.mjs`.

**Interfaces — Produces:**
- `control/compose.yml`, project name `selfbase`, every service with `container_name: selfbase-<service>`, `mem_limit` = spec 7.6 (control 384m, control-db 384m, provisioner 128m, socket-proxy 32m, logs 384m), `memswap_limit` equal, `pids_limit`, `no-new-privileges`, `restart: unless-stopped`, `cgroup_parent: ${CGROUP_PARENT:-}`:
  - `control` — image `${REGISTRY}/selfbase-control:${TEMPLATE_VERSION}`; networks `selfbase` and `proxy`; labels: router `selfbase-control` ``Host(`selfbase.${BASE_DOMAIN}`)`` on the https entrypoint with the resolver, service port 8080, an http router with redirect middleware `selfbase-control-redirect`, and the low-priority router `selfbase-paused` (priority 1, `tls=true`, no resolver) on ``HostRegexp(`^([a-z]{20}|sb-[a-z0-9-]+)\.<BASE escaped>$`)`` (D-4; v2 syntax when `PROXY_TRAEFIK_MAJOR=2`).
  - `control-db` — the db image, volume `selfbase-control-pgdata`, network `selfbase` only.
  - `provisioner` — network `selfbase` only, no labels, env from `NodeSettings`.
  - `socket-proxy` — `wollomatic/socket-proxy` pinned by digest, `/var/run/docker.sock` mounted read-only, `env_file: ../provisioner/socket-proxy.env`, network `selfbase` only. It is the only service that mounts the socket.
  - `logs` — VictoriaLogs pinned, volume `selfbase-logs`, `-retentionPeriod=14d -retention.maxDiskSpaceUsageBytes=5GiB -syslog.listenAddr.udp=:5514`, published `127.0.0.1:5514:5514/udp` only, network `selfbase`. *(verify, upstream)*: flag names for the pinned version; that `app_name` carries Docker's `tag`.
  - profile `proxy` (`PROXY_MODE=own`): `traefik` (`traefik:v3` pinned; entrypoints named `http` and `https` on `${PROXY_HTTP_PORT:-80}` / `${PROXY_HTTPS_PORT:-443}`; Docker provider with `constraints=Label(`selfbase.managed`,`true`)`, `exposedByDefault=false`, `network=${PROXY_NETWORK}`; resolver `letsencrypt` HTTP-01 with `ACME_EMAIL`, storage in volume `selfbase-acme`) and `traefik-socket-proxy` (a second socket proxy: GET on `/containers/…`, `/networks`, `/events`, `/version`, `/_ping` only). The `control` service carries `selfbase.managed=true`.
  - networks: `selfbase` (created by compose) and `proxy` (`external: true`, `name: ${PROXY_NETWORK}`).
- `control/compose.build.yml`: `build:` for local images (CC-1: local and CI stacks build, no registry).
- `control/.env.example`: every key of Task 9's config and of `NodeSettings`, each with one comment line; values empty.
- `scripts/install-check.mjs <env file>`: before first start — every required key present and non-empty (names only in output), no unknown key, the master key decodes to 32 bytes, `PROJECT_SUBNET_POOL` is a valid /16 or larger, `TEST_HOST` and `PUBLIC_URL` end with `BASE_DOMAIN`, the file's mode is 0600 on Linux. Exit 1 with one line per problem. Standard library only.
- The control image contains `scripts/{gen-keys,install-check,import-project}.mjs` under `/app/scripts`, so the server needs no Node.
- `test/e2e/stack.test.mjs` (node:test; `PROXY_MODE=own`, `BASE_DOMAIN=localhost`, `PROXY_CERTRESOLVER=` empty, `CERT_PROBE=off`, `PROXY_HTTP_PORT=18080`, `PROXY_HTTPS_PORT=18443`, `MAX_NEW_HOSTS_PER_WEEK=3`, images built locally; requests use `--resolve`-style host headers and accept Traefik's default certificate for localhost only).

- [ ] **Step 1:** Write the e2e cases:
  1. `create-owner`, sign in, create project A through `/platform/projects` → `ACTIVE_HEALTHY` in **under 120 s** (assert the measured time); `https://<refA>.localhost/health` 200; `/rest/v1/` with A's anon key 200; `/admin/ready` and `/panel/` on the public host 404.
  2. Create B. **Isolation:** `docker exec sb-<refA>-core` cannot resolve `sb-<refB>-core` or `db` of B, and a TCP connect to B's `db` IP on 5432 and B's `core` IP on 8080 and 8081 times out; A's anon key on B's host → 401; the two networks have different /27 subnets inside the pool.
  3. Every `sb-*` container has `Memory == MemorySwap`, a `PidsLimit`, `no-new-privileges`, no `Binds`, no published port, the syslog log config; `docker inspect` of `selfbase-control` shows no socket mount.
  4. Studio (Playwright against the real stack): sign in, open A, insert a row in the table editor, run `select 1`, open logs and see at least one `core` line.
  5. **Control down:** `docker stop` control, control-db, provisioner, socket-proxy and logs; A and B still answer `/health`, sign-up and `/rest/v1/`; `docker restart sb-<refA>-core` comes back healthy with `logs` stopped (D-5); start the control stack again and reconcile reports no change.
  6. **Proxy restart (CC-6):** `docker restart selfbase-traefik`; within 30 s both hosts answer again with no other action.
  7. Pause B → its host answers 540 `{message:'project paused'}`; restore → 200.
  8. With the cap at 3 and the control host recorded, a third project is refused with the cap message; delete B → its containers, network and volumes are gone and its slot is free; creating C reuses B's hostname.
  9. `docker rm -f sb-<refA>-rest` → reconcile recreates it within 60 s. `docker kill selfbase-control` during a create → after restart the project reaches `ACTIVE_HEALTHY` with one container per service.
  10. Export A with a passphrase, change a row in A, delete C, import the export as a new project D (it takes the freed host, no new one) → D has the old row and A's `JWT_SECRET` (A's anon key works on D's host); a wrong passphrase is refused with no project left behind.
  11. Teardown removes every `sb-*` and `selfbase-*` object it created and asserts that the list of all other containers, networks and volumes is identical to the list taken at the start.
- [ ] **Step 2:** Run → FAIL (no compose yet). **Step 3:** Write the compose files, env example and check script; fix what the run exposes in the owning package (report cross-task fixes to the controller in the commit body).
- [ ] **Step 4:** `node --test test/e2e/stack.test.mjs` PASS locally (Docker Desktop is fine) and in CI's `e2e` job on `ubuntu-latest`. Record the measured create time and the `docker stats --no-stream` memory of the idle control stack and of one idle micro project in `test/e2e/README.md`.
- [ ] **Step 5:** Commit `feat: control stack compose for both proxy modes with an end-to-end proof`.

### Task 18: Acceptance suite (CC-5, part 1)

**Depends on:** Task 17. **Files:** `acceptance/{package.json,vitest.config.ts,README.md,src/*.test.ts,src/helpers.ts}`, root `package.json` (add the workspace), `scripts/test/workspace.test.mjs` (six workspaces), `client/test/helpers.ts` is read, not changed.

**Interfaces — Produces:** `npm run acceptance -w acceptance`, configured only by env: `SELFBASE_URL` (project API URL), `SELFBASE_ANON_KEY`, `SELFBASE_SERVICE_KEY`, `SELFBASE_API_URL` (control URL), `SELFBASE_ACCESS_TOKEN`, `SELFBASE_PROJECT_REF`, `ACCEPTANCE_MODE` (`full` | `live`), optional `ACCEPTANCE_LOGIN_EMAIL` / `ACCEPTANCE_LOGIN_PASSWORD`. It uses `selfbase-js` from `client/src` and the management API for setup SQL (`/v1/projects/{ref}/database/query`); it never needs a database port or Docker.
- `full` (throw-away projects): sign-up → confirmation link read from `selfbase.mail_log` by SQL → verify → sign-in → refresh rotation and reuse refusal; an RLS table (owner sees own rows, another user none); storage upload, public read, private read refused for another user, signed URL; realtime INSERT delivered to the allowed subscriber and not to the other; an unknown function → 404; `/admin/*` and `/panel/` on the project host → 404; management API: get project, health, api-keys masked, pause → 540 → restore → 200. **It aborts before any write when the project reports `smtp_configured: true`.** Every object it creates carries a run prefix and is dropped in `afterAll`, including the users.
- `live` (project #1): no sign-up and no schema change. Health; `/rest/v1/` with the anon key; a public storage object if one exists; a realtime connection is accepted; the admin and panel paths answer 404; management API get, health, masked keys; a sign-in only when the two login variables are set (otherwise reported as skipped).
- The run ends with one summary line per case and writes `acceptance/last-run.json` (git-ignored): mode, project ref, counts, duration.

- [ ] **Step 1:** Write the suite. **Step 2:** Against the Task 17 stack (kept up with `E2E_KEEP=1`): `full` on a micro project → all pass; then set `SMTP_HOST` in that project's config and re-run → aborts with zero writes (assert row counts unchanged); `live` on the same project → passes, and a diff of `pg_dump --schema-only` before and after is empty.
- [ ] **Step 3:** Leave-nothing-behind check: after `full`, no table, bucket or user with the run prefix exists.
- [ ] **Step 4:** Commit `test: acceptance suite with full and live modes`.

### Task 19: Own-Traefik proof on the owner's Windows machine (CC-6)

**Depends on:** Task 17. **Files:** `docs/proofs/wave1-own-traefik.md`.

Run on this Windows machine with Docker Desktop. Parallel with Task 18.

- [ ] **Step 1:** If ports 80 and 443 are free, run the Task 17 stack with `PROXY_HTTP_PORT=80`, `PROXY_HTTPS_PORT=443`; otherwise keep 18080/18443 and say so. `LOG_SYSLOG_ADDR` and `CGROUP_PARENT` are left empty if Docker Desktop cannot honour them; record which.
- [ ] **Step 2:** With `PROXY_MODE=own`: create two projects, open `https://<refA>.localhost` and `https://<refB>.localhost` (default certificate), `docker restart selfbase-traefik`, and confirm both routes return by themselves. Open Studio in a browser and sign in.
- [ ] **Step 3:** Write the proof file: date, Docker Desktop version, what was run, the observed results, and the spec's "Not proven there" list verbatim (public ACME issuance and renewal; binding 80/443 on a Linux host with a firewall; the systemd slice; behaviour next to another proxy), plus anything that had to be switched off in Step 1.
- [ ] **Step 4:** Remove the stack; confirm no `sb-*` / `selfbase-*` object remains. Commit `docs: own-traefik proof on docker desktop`.

### Task 20: Release, images, deploy the control stack on the shared server

**Depends on:** Tasks 1, 18, 19 and a clean whole-branch review. **Files:** `docs/proofs/wave1-deploy.md`. Run by one builder over SSH; nothing else runs on the server meanwhile.

- [ ] **Owner step A:** OK to push branch `v2` and tag `v2.1.0` to `origin`. Without it this task does not start.
- [ ] **Step 1:** Push, tag, wait for `ci.yml` and `images.yml` green. Confirm the eight images exist in GHCR for `2.1.0` and are private.
- [ ] **Owner step B:** On the server, as root, the owner runs `docker login ghcr.io` with a token that has `read:packages` only. The builder never sees the token.
- [ ] **Step 2:** `mkdir -p /opt/selfbase/{backups,proofs}` (mode 0700). Copy `control/compose.yml`, `provisioner/socket-proxy.env`, `control/traefik-socket-proxy.env` from the tag. `docker pull` the eight images (`2.1.0`). Record image ids.
- [ ] **Step 3:** `(umask 077; docker run --rm <control image> node /app/scripts/gen-keys.mjs --control > /opt/selfbase/.env)` on the server (nothing echoed), then append the non-secret settings from Task 1's facts: `BASE_DOMAIN`, `PROXY_MODE=coolify`, `PROXY_NETWORK`, entrypoints, resolver, `PROXY_TRAEFIK_MAJOR`, `PROJECT_SUBNET_POOL`, `LOG_SYSLOG_ADDR`, `CGROUP_PARENT`, `BACKUP_HOST_DIR=/opt/selfbase/backups`, `TEMPLATE_VERSION=2.1.0`, `REGISTRY`, `MAX_NEW_HOSTS_PER_WEEK=3`, `TEST_HOST=sb-test.<BASE>`, `NODE_NAME`. Run `install-check.mjs` from the control image with the env file mounted read-only → no problems. Then by hand: `docker network inspect <PROXY_NETWORK>` succeeds, `docker image inspect` succeeds for all eight images, `/opt/selfbase/backups` exists.
- [ ] **Owner step C:** The owner copies `SELFBASE_MASTER_KEY` from `/opt/selfbase/.env` to an offline place and confirms. Losing it loses every stored secret. The builder does not display the file.
- [ ] **Owner step D (only if Task 1 found the systemd cgroup driver):** OK for `systemctl set-property selfbase.slice MemoryMax=16G`. On OK the builder runs exactly that command and records `systemctl show selfbase.slice -p MemoryMax`. Without the OK, or with another driver: `CGROUP_PARENT` stays empty and the proof file says the second wall is absent.
- [ ] **Step 4:** Check that `selfbase.<BASE>` is spelled exactly (certificate 1 of 3). `docker compose -p selfbase --env-file .env up -d` in `/opt/selfbase`. Wait for health; `https://selfbase.<BASE>/health` 200 with a valid certificate. Set `settings.control_host_first_issued_at` (control does this on first start; confirm in `/platform/capacity`: `new_hosts_this_week: 1`). If the certificate is not issued within 10 minutes: stop here, do not retry with another name, report to the controller.
- [ ] **Step 5:** `docker compose exec -T control node src/cli.ts create-owner <owner email>` — the **owner types the password** (Owner step E) or the builder generates one into a 0600 file the owner reads once and changes at first sign-in.
- [ ] **Step 6 (spec section 10, step 1):** In Studio create a throw-away micro project in the `test` pool (certificate 2 of 3, `sb-test.<BASE>`). Measure create time (under 2 minutes without the certificate wait; record both numbers). Run the acceptance suite in `full` mode against it → green. Delete it; confirm its containers, network and volumes are gone and the slot is free. Create a second throw-away project in the `test` pool → it reuses `sb-test.<BASE>` with **no** new certificate (`new_hosts_this_week` stays 2); delete it.
- [ ] **Step 7:** `docker stop` the five control containers for one minute while a throw-away project runs → it keeps serving; start them again. (Our own containers only.)
- [ ] **Step 8:** Write `docs/proofs/wave1-deploy.md` (no IP, no hostnames beyond `<BASE>` placeholders): versions, image ids, settings names, measured times, certificate count so far. Commit `docs: wave 1 deploy record`.

### Task 21: CorteQS becomes project #1 (cutover)

**Depends on:** Task 20. **Files:** `docs/proofs/wave1-cutover.md`.

- [ ] **Owner step F:** OK to run one read-only backup container attached to the v1 Coolify resource's network with its storage volume mounted read-only (these objects are selfbase's but are not named `sb-*`).
- [ ] **Step 1:** Backup with v1's own script: `docker run --rm --network <v1 network> -v <v1 storage volume>:/data/storage:ro -v /opt/selfbase/backups/v1:/backups -e PGHOST=db -e PGUSER=postgres -e PGDATABASE=postgres -e PGPASSWORD <v1 backup image> bash /scripts/backup.sh`, with `PGPASSWORD` exported from the v1 container's environment in the same shell line and never echoed. Result: `/opt/selfbase/backups/v1/<ts>/` with a MANIFEST.
- [ ] **Step 2:** Write the v1 env file for the import: `(umask 077; docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' <v1 core container> > /opt/selfbase/v1.env)` — nothing is printed; check it with `cut -d= -f1` (names only). Create an access token for the owner account (Studio, shown once, kept in the shell's environment only).
- [ ] **Step 3:** From the control image (`docker run --rm -e SELFBASE_ACCESS_TOKEN -v /opt/selfbase/v1.env:/v1.env:ro <control image> node /app/scripts/import-project.mjs …`), with the token read into the shell by `read -s`: `import-project.mjs --url https://selfbase.<BASE> --org default --name corteqs --size small --backup-dir v1/<ts> --env-file /v1.env`. This creates `<ref>.<BASE>` — **certificate 3 of 3**. Expect `ignored` to list `POSTGRES_PASSWORD`, `PANEL_*`, `PUBLIC_URL`, `TRUST_PROXY`; any `unknown` key goes to the controller before continuing. Then `shred -u /opt/selfbase/v1.env` and revoke the token.
- [ ] **Step 4 (verify on `<ref>.<BASE>`):** health 200; the v1 anon key from the app's build works on `/rest/v1/`; `select count(*)` of `auth.users` and of each public table equals the v1 database's (the database is empty today — record the zeros); a file download if any object exists; the acceptance suite in `live` mode → green (or `full` when Task 1 found no `SMTP_HOST`; record which); `selfbase.platform_migrations` lists every migration. **Isolation on the server:** create a throw-away `test`-pool project, repeat Task 17's case 2 between it and project #1 (probes only, nothing disruptive on project #1), delete it.
- [ ] **Owner step G:** OK to stop the v1 resource in Coolify. The owner (or the builder with the owner watching) stops it in the Coolify UI. It is **not deleted**.
- [ ] **Step 5:** Immediately after: in Studio → project #1 → Ayarlar → Alan adları add `selfbase-corteqs.<ip>.sslip.io` as `legacy`. Order matters: two routers must not claim one host. Confirm `https://selfbase-corteqs.<ip>.sslip.io/health` 200 with the **existing** certificate (same serial as Task 1 recorded) and `new_hosts_this_week` still 3.
- [ ] **Step 6:** Run the CorteQS unit tests on `D:\Dev\corteqsemir-wt\selfbase` (`npm run test`), with its `.env.local` pointing at the legacy host as before; compare with the last recorded result in `docs/app-swap-report.md` of that worktree. No file in that repository is edited by this step.
- [ ] **Step 7:** Rollback rehearsal on paper, in the proof file, exactly: remove the legacy domain in Studio → start the v1 resource in Coolify; its volumes were never touched. The v1 resource is deleted only when the owner says so.
- [ ] **Step 8:** Commit `docs: corteqs cutover record`.

### Task 22: Wave exit — acceptance, measurements, before/after listing

**Depends on:** Task 21. **Files:** `docs/proofs/wave1-exit.md`.

- [ ] **Step 1:** Acceptance suite, both parts: part 1 `live` on project #1 and `full` on a fresh `test`-pool project (deleted afterwards); part 2 the CorteQS unit tests (Task 21 Step 6 result, re-run if anything changed since).
- [ ] **Step 2:** Measurements with `docker stats --no-stream`, three samples a minute apart: each control-stack container and their sum (cap 928 + 384 MiB); one idle micro project per service and its sum (cap 1184 MiB); project #1 per service. `/platform/capacity` output. Disk: `docker system df -v` rows for `sb-*` and `selfbase-*` volumes and `/opt/selfbase/backups`.
- [ ] **Step 3:** First scheduled backup: after 03:15 UTC, `/opt/selfbase/backups/<ref>/<ts>/MANIFEST` and `/opt/selfbase/backups/control/<ts>/` exist and Studio lists the backup.
- [ ] **Step 4:** "After" listing: the same command as Task 1 Step 3 into `/opt/selfbase/proofs/after.txt`; `diff before.txt after.txt`. Expected differences: none. The v1 resource's containers appear in both (stopped now). Any other difference is explained line by line or reported to the owner.
- [ ] **Step 5:** Certificates: list the hosts this wave issued (expected exactly `selfbase.<BASE>`, `sb-test.<BASE>`, `<ref>.<BASE>`), from `/platform/capacity` and from the proxy log's issuance lines since Task 20 began. More than 3 is a failed exit criterion and goes to the owner.
- [ ] **Step 6:** Tick the spec's "Proves" list one by one with the evidence file and section for each: created from Studio in under two minutes without Coolify; two projects cannot reach each other; projects serve with the control stack stopped; the provisioner refuses anything outside the template (Task 8's document); CorteQS runs as project #1; at most `MAX_NEW_HOSTS_PER_WEEK` new certificates; own-Traefik mode (Task 19's file with its "not proven" list).
- [ ] **Step 7:** Commit `docs: wave 1 exit record`.

### Task 23: REHBER (Turkish)

**Depends on:** Task 22. **Files:** `docs/REHBER.md`, `README.md`, `docs/screens/v2/*`.

Written for the owner, who will move this to his own server and must understand it. Every installed thing is explained with what and why. Use the project's `turkce-dogal` skill for the text. No server address.

- [ ] **Step 1:** Rewrite or add these sections (v1's sections on local run, client alias, migration from Supabase stay, corrected where paths moved):
  1. Büyük resim v2: kontrol yığını ve proje yığını, şema, hangi parça neyi yapar, neden Docker'a doğrudan konuşuyoruz.
  2. Repo haritası (monorepo).
  3. Kontrol yığınını kurma — paylaşımlı Coolify sunucusunda (`PROXY_MODE=coolify`): sunucu bilgilerini `docker inspect coolify-proxy` ile okuma, `.env`'in her satırı, `install-check`, GHCR girişi, `SELFBASE_MASTER_KEY`'in çevrimdışı kopyası (kaybedilirse ne olur), `selfbase.slice` ve neden sahibin onayı gerekir.
  4. Kendi sunucunda kurma (`PROXY_MODE=own`): adımlar, ve **ilk kez gerçek sunucuda yapılacak, denenmemiş** adımlar ayrı bir kutuda (Task 19'un listesi).
  5. Studio: ilk sahip hesabı, davet, roller tablosu, erişim token'ları.
  6. Proje oluşturma, boyutlar, bellek bütçesi ve reddedilme mesajları; duraklatma, devam ettirme, silme, güncelleme.
  7. Alan adları ve sertifikalar: sslip.io neden kıt kaynak, haftalık sınır, test host'u, "sertifika bekleniyor", gerçek alan adına geçiş (tek ayar) ve elle yapılacaklar.
  8. Sırlar: nerede durur, nasıl şifrelenir, kim görür.
  9. Yedekler: günlük iş, yer, elle yedek, dışa aktarma/içe aktarma, v1 kurulumunu içe alma (`import-project.mjs`), aynı sunucuda durmanın sınırı.
  10. Günlükler: nereye gider, Studio'da nasıl bakılır, günlük deposu kapalıyken ne olur.
  11. Güncelleme: yeni sürüm imajlarını çekme, kontrol yığınını yükseltme, projeleri yükseltme.
  12. Coolify güncellenince / proxy yeniden başlayınca; Coolify temizlik işleri.
  13. Bu dalgada olmayanlar: fonksiyon dağıtımı (dalga 2), CLI, dış veritabanı portu, yapılandırma ekranları; `sync.mjs` bu arada nasıl çalıştırılır (`DOCKER_NETWORK=sb-<ref>`).
  14. Sorun giderme: proje `COMING_UP`'ta kaldı, 540, 502, sertifika gelmedi, bellek reddi, iş başarısız.
  15. Kaldırma: bir projeyi, tüm platformu; nelere dokunulmaz.
- [ ] **Step 2:** Verify by following sections 4, 5 and 6 literally on this Windows machine in a clean directory with local images; fix every step that did not work as written; remove the stack.
- [ ] **Step 3:** `grep -n` the guide for the server's IP and hostname → no match. Commit `docs: guide covers the control plane, projects and wave 1 operations`.

### Task 24: CorteQS handoff document

**Depends on:** Task 22 (parallel with Task 23). **Files:** `docs/handoff/wave-1-corteqs.md`.

- [ ] **Step 1:** Write for the CorteQS team (Turkish, short): what changed (the backend now runs as a project under the selfbase control plane; same data, same keys, same JWT secret); what did **not** change (the app's URL and env, the build alias, every file in the app repository — no commit was needed on `selfbase/client-swap` this wave; say so explicitly); what is new (a second URL `<ref>.<BASE>` that will become the main one, Studio at `selfbase.<BASE>` replacing `/panel`, accounts by invitation); what is temporarily different (functions are not served until wave 2's deploy — as before on the server; migrations still go through `sync.mjs`); what the team may want later (switch `VITE_SUPABASE_URL` and CSP `connect-src` to the new host at their convenience — both hosts keep working); how to verify (three commands or clicks); rollback (the v1 resource is stopped, not deleted).
- [ ] **Step 2:** Check every statement against `docs/proofs/wave1-cutover.md`. No secrets, no server address.
- [ ] **Step 3:** Commit `docs: wave 1 handoff for the corteqs team`. **Owner step H:** the owner takes it to the team; nothing is pushed to the CorteQS repository.

---

## Task table

| # | Title | Depends on | Can run in parallel with | Model tier |
|---|---|---|---|---|
| 1 | Server facts (read-only) | — | 2 – 19 | most capable |
| 2 | Monorepo, package stubs, CI images | — | 1 | standard |
| 3 | Platform migrations and db image | 2 | 1, 6, 15 | standard |
| 4 | Core admin port, token, JSON log, sign-up switch | 3 | 1, 6, 7, 9, 11, 15, 16 | standard |
| 5 | Project template v2, pooler, sizes | 4, 6 | 1, 7, 9 – 12, 15, 16 | standard |
| 6 | Provisioner spec builder | 2 | 1, 3, 4, 9, 15 | most capable |
| 7 | Provisioner Docker operations and socket-proxy allow-list | 6 | 1, 4, 5, 9 – 12, 15, 16 | most capable |
| 8 | Provisioner security review | 5, 7 | 1, 9 – 16 | most capable |
| 9 | Control skeleton, data model, secrets | 3 | 1, 4 – 7, 15 | standard |
| 10 | Accounts, organizations, roles, tokens, audit | 4, 9 | 1, 5, 7, 8, 11, 12, 15, 16 | standard |
| 11 | Admission, subnets, hostname slots and cap | 9 | 1, 4, 5, 7, 8, 10, 15, 16 | standard |
| 12 | Jobs engine, lifecycle, reconcile | 11 | 1, 5, 7, 8, 10, 15, 16 | most capable |
| 13 | `/v1` and `/platform` project API, forwarding, logs | 10, 12 | 1, 5, 8, 15, 16 | standard |
| 14 | Backup, export, import, import script | 13 | 1, 8, 15, 16 | most capable |
| 15 | Studio shell and organization screens | 2 | 1, 3 – 14 | standard |
| 16 | Studio project screens | 15 | 1, 4 – 14 | standard |
| 17 | Control stack compose, proxy modes, e2e proof | 5, 8, 10, 13, 14, 16 | 1 | most capable |
| 18 | Acceptance suite | 17 | 1, 19 | standard |
| 19 | Own-Traefik proof on Windows | 17 | 1, 18 | standard |
| 20 | Release, images, deploy on the server | 1, 18, 19 | — | most capable |
| 21 | CorteQS cutover | 20 | — | most capable |
| 22 | Wave exit: acceptance, measurements, listing | 21 | — | standard |
| 23 | REHBER (Turkish) | 22 | 24 | standard |
| 24 | CorteQS handoff document | 22 | 23 | cheap |

Dependency waves: **W-A** 1, 2 → **W-B** 3, 6, 15 → **W-C** 4, 7, 9, 16 → **W-D** 5, 10, 11 → **W-E** 8, 12 → **W-F** 13 → **W-G** 14 → **W-H** 17 → **W-I** 18, 19 → whole-branch review → **W-J** 20 → 21 → 22 → **W-K** 23, 24.

---

### Task 25: Studio redesign (owner-approved v3 design, added 2026-11-23)

Runs after the final-review fix wave merges and before Task 20, so the first deploy ships it.

**Source of truth:** `.superpowers/sdd/2026-11-22-selfbase-v2-wave1/studio-mockup-v3.html` (screens: signin, projects, capacity, home incl. Mimari tab, table incl. undo toast, sql incl. Asistan, import side sheet, palette, details) and `studio-references-browsed.md`. Copy the mockup HTML into `docs/design/` in the first commit so the repo carries it.

**Constraints:**
- Fonts self-hosted (Geist, Geist Mono, Instrument Serif as woff2 under `studio/public/fonts`); no runtime CDN calls.
- Icons: `@phosphor-icons/react` (MIT), Regular / Duotone (active nav, empty states) / Bold (12px only), plus 7 custom service glyphs as React components.
- Tokens on `:root` with light/dark and the theme circular reveal (View Transitions API with fallback); every text token at WCAG AA or better, as in the mockup's contrast table.
- `prefers-reduced-motion` disables all motion.
- UI text in Turkish; tr-TR number and relative-time formatting.
- Only screens backed by real control/core routes ship live. Sites (Wave 6), Asistan and the architecture canvas ship as clearly labelled previews or stay behind a flag; never show fake data as real.
- Existing Playwright Studio specs (role gating, 401 refresh) keep passing; add specs for the theme switch, Ctrl+K palette, undo toast and keyboard focus order.

**Steps:** tokens and fonts → shell (sidebar, top bar, palette) → org screens (projects, members, tokens, audit, capacity) → project screens (home, table editor, SQL, auth users, storage, logs, settings, import/export sheet) → states (skeleton, empty, error, toasts) → Playwright screenshots of every screen, dark and light, compared against the mockup → commit.
