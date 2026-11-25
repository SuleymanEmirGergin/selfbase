# selfbase v2 — Wave 3 (Auth, Realtime, Storage wire parity) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (chosen by the owner) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a selfbase project wire-compatible with what the pinned `@supabase/supabase-js` speaks for auth, realtime and storage, proven by a conformance suite that drives the real client and `selfbase-js` against a project stack, with a written exclusions list, and give Studio the auth, storage and realtime screens.

**Architecture:** `core` is first cut into three area modules (`auth`, `realtime`, `storage`) behind one registration interface, so the sub-waves do not collide. Each area's schema lands up front as one platform migration; code tasks add none. Auth becomes GoTrue-compatible (sessions with AAL/AMR, PKCE, OTP, a table-driven OAuth/OIDC engine, MFA, phone, SAML, hooks, asymmetric signing keys, new-style API keys resolved in the gateway). Realtime speaks Phoenix channels and reads changes from one temporary logical-replication slot. Storage streams to a backend interface and adds TUS, the S3 protocol and image transformations through one shared imgproxy. Settings reach `core` as JSON environment values built by control (AC-8). `selfbase-js` is rebuilt on the vendored MIT sources of auth-js, storage-js, realtime-js and functions-js.

**Tech Stack:** as waves 1 and 2, plus: `@supabase/supabase-js` (pinned, **devDependency of the `conformance` workspace only**), vendored auth-js / storage-js / realtime-js / functions-js sources in `client/vendor/`, `pg-logical-replication` (pgoutput), `@tus/server` + `@tus/file-store`, `@node-saml/node-saml` (AC-19), `otpauth` (TOTP), `@aws-sdk/client-s3` and `tus-js-client` (test-only), imgproxy (shared, control stack), Keycloak (e2e job only, as the local OIDC and SAML identity provider).

**Spec:** `docs/superpowers/specs/2026-11-22-selfbase-v2-design.md` (binding). Every implementer reads sections 3–5, 7.2 (AC-7, AC-8), 7.4, 8.1–8.3, 8.6, 11 (wave 3, CC-5) and 15, plus the sections their task names. Earlier plans, for conventions and what exists: `docs/superpowers/plans/2026-11-22-selfbase-v2-wave1.md`, `docs/superpowers/plans/2026-11-24-selfbase-v2-wave2.md`. What the CorteQS app calls: `client/INVENTORY.md`.

## Execution

- Branch `v2-wave3`, cut from `v2` when wave 1 closes. It runs beside `v2-wave2`. **Wave 2 merges into `v2` first, then wave 3.** `v2` stays what is deployed until Task 47.
- Sub-waves: **3.0** foundation (Tasks 1–7), **3a** auth core (8–15), **3b** realtime (16–21), **3c** storage (22–28), **3d** auth extended (29–35, 51, 52), **3e** platform integration and Studio (36–44, 53, 54), **3f** proof, release and exit (45–50). Tasks 51–54 were added by the controller's rulings of 2026-11-25 and keep their numbers although they sit inside 3d and 3e. 3a, 3b and 3c are independent after 3.0 and run in parallel worktrees; 3d starts when 3a's exit is clean; 3e starts at R2; 3f at R3.
- **Rebase points** (D-2; each is a merge into `v2-wave3` done by the controller, never a rebase of shared commits):
  - **R1** — wave 2 Tasks 2, 3, 4, 5 and 11 (db image, platform `0004`–`0008`) are task-reviewed on `v2-wave2`; that commit is merged into `v2-wave3`. Tasks 5 and 6 and everything after them wait for R1. Tasks 1–4 and 7 do not.
  - **R2** — wave 2 is merged into `v2` (after its Task 24 and whole-branch review); `v2` is merged into `v2-wave3`. 3e starts here.
  - **R3** — wave 2 is closed (its Tasks 25–28 on `v2`, `2.2.0` deployed); `v2` is merged into `v2-wave3`. Tasks 47–50 start here.
- Subagent-driven: one implementer per task on the model the task names (owner's policy: Opus 5.5 implements; Sonnet or Haiku take the small mechanical tasks), a task review after **every** task (Opus). Parallel tasks run in separate worktrees and write only the paths in their **Files** block; a task that needs a file another task or wave 2 owns stops and reports.
- **Security review at task end.** A task marked **High-risk** has a step "security review": a Codex CLI second opinion (read-only, on a `git archive` export, as in wave 1's gate) and an opus `security-reviewer` agent, both on that task's diff and its listed attack cases, run when the task's tests pass and before its task review closes. Every Critical or Important finding is fixed with a regression test in the same task. Reports go to the wave's ledger directory, not the repository.
- **Sub-wave exit** (Tasks 15, 21, 28, 35): the layered gate of the wave 1 ledger on the sub-wave's whole diff (`security-audit` skill, `security-reviewer` agent, Codex), the conformance subset of that area green with both clients, `core` memory measured, one fix wave. These exits are local (D-1). The whole-branch gate and final review run after Task 46, before anything is pushed or deployed.
- The migration chain is owned by the controller: after Task 6 the next free platform number is `0012` and is given only to Task 36. A code task that finds it needs a schema change stops and asks.
- **Owner step** lines need the owner at that moment. A builder never works around one. Server tasks (47, 48) are run by one builder over SSH, never in parallel.

## Global Constraints

- No `supabase/*` image and no `@supabase/*` package at runtime. `@supabase/supabase-js` exists only in `conformance/package.json` `devDependencies`; a test fails if it appears in any other package or in an image. Vendored client sources keep their licence file and carry no telemetry. The product never shows the Supabase name or logo; "works with supabase-js" is allowed. Identifiers that exist for compatibility (`supabase_realtime`, `supabase_auth_admin`, `sb-` cookie and storage keys, `SUPABASE_*`) keep their names.
- Parity is defined by three things and nothing else (spec 8.1, risk table): the pinned `@supabase/supabase-js` (Task 1 records the exact version), the conformance suite, and `docs/parity/exclusions.md`. Every public method of the pinned client passes a conformance test with **both** clients or is an exclusions entry with a reason; `conformance/coverage.mjs` fails otherwise. A feature is never cut for convenience; an exclusion needs spec section 3 or the pinned client marking the feature unstable. The three features spec 8.2 schedules for wave 5 are listed as "scheduled: wave 5", not as excluded.
- No third-party account is created or used by a builder (owner). OAuth, SAML, SMS, CAPTCHA and leaked-password checks are proven against local identity providers, stubs and the vendors' published test keys. On the server every provider, SMS sender and CAPTCHA stays switched off; Studio shows them as not connected until the owner enters credentials. The existing Google sign-in keeps working unchanged.
- The repository is public: never a server IP, hostname or secret in it. Use `<ip>` and `<BASE>`.
- Secrets are never printed, logged, committed, put in job payloads, audit rows or error messages. Third-party secrets (SMTP, OAuth clients, SMS, hook, CAPTCHA, S3 keys, signing private keys) are write-only: no API, CLI or Studio path returns one after it is stored, and `GET /auth/v1/settings` never carries one.
- Outbound requests from `core` go through `core/src/netguard.ts`. Endpoints of public providers are constants in code; only providers that are self-hosted by nature take a base URL from settings, and an import strips every outbound endpoint as today (`control/src/envfile.ts`).
- `/v1` routes name the `operationId` they implement and match path, method and field names of `docs/reference/management-api.json` (`control/test/openapi.test.ts` checks it). Anything else goes under `/platform`.
- Certificates: this wave requests **zero** new hostnames. Server proofs use the fixed test host `sb-test.<BASE>` (pool `test`, one project at a time).
- Shared-host rule (spec 5) as in waves 1 and 2. This wave adds one control-stack container, `selfbase-imgproxy` (cap 384 MiB, already in the spec's budget), and no published port.
- The provisioner still never sets `Privileged`, `CapAdd`, host namespaces, devices or bind mounts beyond the backup directory, has no runtime dependency beyond Node's standard library, and adds no job type. Line cap: D-27.
- A project keeps serving auth, realtime and storage with the control stack stopped. Image transformations are the stated exception (spec 4): with imgproxy unreachable a render route answers 503 and the untransformed object routes still work.
- Platform migrations `0009`+ are safe to run twice, never drop user data, and also run on control-db (control applies the platform set there), where they must be harmless. Numbers are assigned here: `0009-auth-schema`, `0010-storage-schema`, `0011-realtime-schema`, `0012-realtime-drop-v1-triggers`. They are applied only after wave 2's `0004`–`0008`. Control migrations: `0010-signing-and-api-keys`, `0011-storage-s3-keys` (D-4), after wave 2's `0008` and `0009`.
- Language: English is the product's main language, Turkish the second locale. Every new Studio string is a `t()` key present in **both** `studio/src/i18n/en.ts` and `tr.ts`; no literal user-facing string in a component. Turkish strings are checked with the `turkce-dogal` skill before the task's commit. `docs/REHBER.md` stays Turkish.
- Code, comments, commit messages in English. Commit format `<type>: <description>`. Commits are local; pushing is an Owner step (Task 47).
- CorteQS repository (`D:\Dev\corteqsemir`, worktree `D:\Dev\corteqsemir-wt\selfbase`, branch `selfbase/client-swap`): no push, no PR, migration files never edited, `scripts/ops/*` never run. What the app side needs is a commit on that local branch plus `docs/handoff/wave-3-corteqs.md`.
- Each code task: failing test → implementation → passing test → commit. Integration tests run against real Postgres, real Docker and real Deno, no mocks of them. Upstream facts marked *(verify, upstream)* are checked by the task that depends on them, against the pinned client's source and the upstream server's source at the same date, and the task records what it found.
- A shortcut with a known limit carries a `shortcut: <limit>, <when to upgrade>` comment.
- Release version of this wave: `2.3.0` (root `package.json`, image tags), after wave 2's `2.2.0`.

## Review Focus

Each item is a lesson of the wave 1 security gates (ledger, 2026-11-24) carried to this wave's surface.

1. **A revocation that loses a race.** Logout, ban, password change, MFA unenroll and "sign out other sessions" run while a refresh rotates the same session: no child token survives, and a banned user's next request fails (wave 1 S4). → Tasks 8, 31.
2. **A token accepted for a purpose it was not signed for.** Signed-URL, signed-upload, render-source, flow-state, relay-state and API-key-derived tokens are each refused everywhere else; an ES256 public key is never accepted as an HS256 secret; an unknown `kid` or `alg: none` is refused. → Tasks 9, 11, 23, 25, 34.
3. **An outbound request whose target a tenant or an import chose.** OAuth and OIDC endpoints, an ID token's issuer and JWKS, SAML metadata URLs, hook URLs, SMS, CAPTCHA and leaked-password calls never reach a private address, and an imported project carries no endpoint (wave 1 runtime I1). → Tasks 13, 29, 30, 32, 33, 34.
4. **A realtime message that reaches a subscriber who cannot read it.** A change, a database broadcast or a private-channel message is delivered only when that subscriber's role and claims pass the policy at delivery time; an expired token stops delivery; two subscribers with different claims never share one check. → Tasks 17, 19.
5. **Storage reached around RLS.** SigV4 canonicalisation, presigned expiry and chunk signatures, a guessed TUS upload id, a signed URL replayed for another object, copy or move across buckets, and a symlink or `..` in any name never read or write an object the caller's policy does not allow (wave 1 R4). → Tasks 22, 23, 24, 26, 27.
6. **One project reaching another through a shared service.** imgproxy sits on every project's control network: it fetches only `sb-<ref>-core:8080` render-source URLs signed by that project, and never an admin port or another project's private object (wave 1 runtime C1, R5, R6). → Tasks 25, 39.
7. **A secret that comes back.** No value from `AUTH_SECRETS`, `STORAGE_SECRETS`, `JWT_KEYS` or `API_KEYS` appears in a config GET, `/auth/v1/settings`, an audit row, a job payload, an error or a log line (wave 1 Review Focus 5). → Tasks 4, 37, 38.
8. **A copy that shares credentials.** An import, restore or export of a project with the new tables and keys neither keeps live sessions, factors, flow states and signing keys in use elsewhere, nor carries third-party endpoints (wave 1 Codex C-1, S1). → Tasks 36, 38.

## Decisions

Open points and contradictions, decided here with the reason. The controller can overturn any of them before the task that implements it.

| # | Issue | Decision and reason |
|---|---|---|
| D-1 | Spec 11: every wave is deployed before the next. The ledger gives each sub-wave its own exit. Wave 3 cannot be deployed before wave 2 merges. | Sub-wave exits 3a–3d are local: CI, the conformance subset, the layered security gate and a memory measurement on a compose stack. There is one server deploy, Task 47. Reason: the owner's merge order; a local exit still catches what a smaller exit is for. |
| D-2 | `applyMigrations` throws on a gap, wave 2 owns `0004`–`0008`, and wave 2 also owns the db image and template lines wave 3 builds on. | Rebase points R1, R2, R3 (Execution). R1 brings wave 2's migration chain into `v2-wave3` as a merge, so wave 3 writes `0009`+ on top of the real files. Reason: placeholders for reserved numbers would stamp a database as migrated without running anything. Cost: `v2-wave3` carries wave 2 commits before wave 2's whole-branch review; fixes arrive with R2. |
| D-3 | Three parallel areas each need tables, and one numbered chain allows one writer. | Schema first: Tasks 5 and 6 write `0009`–`0011` in sequence during 3.0, from the upstream schemas *(verify, upstream)*. Code tasks add no migration. `0012` is the one later file (D-16). |
| D-4 | Control migration numbers. `control/migrations/` on `v2` holds `0004-jwt-fingerprint.sql` to `0007-removed-project-members.sql` from wave 1's fix waves. | Ruled by the controller: wave 2 uses `0008-functions-created-at` and `0009-external-db`; wave 3 uses `0010-signing-and-api-keys` and `0011-storage-s3-keys`, written in Task 38 after R2 and confirmed against the merged tree in Task 36. No control migration is written before R2. |
| D-5 | AC-8 delivers config as container environment; GoTrue alone has well over a hundred settings, and the template and `buildEnv` name every variable one by one. | Four JSON values: `AUTH_CONFIG`, `REALTIME_CONFIG`, `STORAGE_CONFIG` (non-secret) and `AUTH_SECRETS`, `STORAGE_SECRETS` (secret), plus `JWT_KEYS` and `API_KEYS`. One typed registry in `core` defines every setting (name, type, default, GoTrue field name, secret or not); control imports it for validation and for the `/v1` field map. v1's single variables stay as the fallback when a JSON value is absent, so plain compose and wave 2's control keep working. `AUTH_CONFIG` is capped at 96 KiB (email templates). Reason: one source of truth, and the template gains seven lines instead of two hundred. |
| D-6 | Owner decision 4: per-project SMTP host and port, Google client id and secret, auth settings. | Checked: wave 2 Task 13 gives the **API** (`PATCH /v1/projects/{ref}/config/auth` with `smtp_host`, `smtp_port`, `smtp_user`, `smtp_admin_email`, `smtp_pass`, `external_google_client_id`, `external_google_secret` and nine auth fields). Wave 2 has **no Studio screen** for them, and `config push` does not send SMTP or Google. Wave 3 therefore owns: the full field map (Task 37, replacing wave 2's `not_supported` answer for the fields core now has) and the Studio forms (Task 41: SMTP, providers, URL configuration). An import keeps stripping `SMTP_HOST` and `SMTP_PORT` (Review Focus 3); the operator sets them in Studio after the import, and REHBER says so. No account is created by anyone. |
| D-7 | Proving twenty OAuth providers, SAML, five SMS senders and two CAPTCHA vendors without accounts. | Unit level: one mock OAuth2/OIDC server in the test tree and stubs for SMS, CAPTCHA and HIBP, reached through test hooks in code, never through an environment variable. E2E: Keycloak for one real OIDC and one real SAML round trip. Server: everything off. `docs/parity/providers.md` states per provider what was proven (engine + quirk test) and what needs the owner's account. |
| D-8 | Spec 8.1: "pinned at the version current when wave 3 starts". | Task 1 pins the newest 2.x release at that day *(verify, upstream)*, exact version in `conformance/package.json`, and vendors the four client sources at the versions that release depends on. The CorteQS functions' `esm.sh/@supabase/supabase-js@2.108.2` specifier keeps resolving to `selfbase-js` through the import-map redirect. |
| D-9 | Exclusions, and the three features spec 8.2 schedules for wave 5 (Web3 sign-in, the OAuth 2.1 server, WebAuthn/passkey factors). | Ruled by the controller: the three are **not cut**. `docs/parity/exclusions.md` has a separate table "scheduled: wave 5" for them, and `coverage.mjs` treats a scheduled method like a pending one that only wave 5 may clear. Excluded for good, with their spec section 3 reason: analytics buckets, vector buckets. Third-party auth is in scope (D-30). Task 1 builds both tables from the pinned client's type surface; nothing else may be added without the controller. |
| D-10 | Ledger: `PUT /auth/v1/admin/users/:id` was parked as "wave 3d parity". | Full `/admin/users` CRUD, `generate_link` and invite are in 3a (Task 14). Reason: `auth.admin.updateUserById` is used by 3a's conformance tests and by Studio's Users screen; only the factor and SSO admin routes need 3d. |
| D-11 | Ledger: "recovery amr lost on refresh"; v2 has refresh tokens and no session row. | `auth.sessions` (GoTrue's columns) and `auth.mfa_amr_claims` hold AAL and AMR; an access token's `aal`, `amr` and `session_id` are read from the session at every issue, so a refresh keeps them. Refresh tokens issued before the upgrade get a session row created at their first refresh. Control's dashboard login uses the same module and must stay green. |
| D-12 | Asymmetric signing keys with PostgREST and `fn`, which verify tokens themselves. | Control holds the keys (private part a project secret) and delivers `JWT_KEYS` to `core`, a JWKS with the HS256 secret and the public keys to `rest` (`PGRST_JWT_SECRET` accepts a JWKS *(verify, upstream)*) and the public JWKS to `fn`. A new project keeps signing with HS256 until an administrator creates and rotates to an asymmetric key; CorteQS is untouched. Rotation recreates `core`, `rest`, `fn`. |
| D-13 | `sb_publishable_…` / `sb_secret_…` keys must work with control down. | Control stores only hashes (`control.api_keys`) and delivers `API_KEYS` (`[{id, type, prefix, sha256}]`) to `core`. The gateway replaces the key with a 60-second role JWT before forwarding to PostgREST and `fn`; auth, storage and realtime accept the key directly. A secret key is refused when the request carries a browser `Origin` header, as upstream *(verify, upstream)*. |
| D-14 | AC-20 moves rate limits into the project database; control imports core's synchronous in-memory `take`. | Project limits use the SQL token bucket. `core/src/auth/ratelimit.ts` keeps exporting the in-memory `take` and `resetRateLimits` with the same signatures for control's dashboard. Reason: control's `session.ts` belongs to wave 2 until R2. |
| D-15 | pgoutput decoder: library or own (spec 13). | `pg-logical-replication` pinned, with its pgoutput plugin, reading publications `supabase_realtime` and `supabase_realtime_messages_publication` from one **temporary** slot (AC-21). Task 18 first proves it against Postgres 17 with our `pg` version; if it fails, the task stops and goes to the controller. |
| D-16 | 8.3 drops the v1 triggers and `selfbase.enable_realtime`; wave 2 D-15 re-arms them after every migration apply. | Wave 3's engine does not need the triggers, so they stay harmless until R2. Task 36 adds `0012` (drop) and removes wave 2's re-arm code in the same commit. |
| D-17 | Which Phoenix serializer versions to accept (spec 13). | Whatever the pinned realtime-js can send: Task 16 reads its source and implements exactly those `vsn` values, text and binary frames *(verify, upstream)*. There is no dual-protocol period (spec 8.3): Task 20 removes the v1 hub and the v1 client in one commit. |
| D-18 | Spec 8.3 lists the storage `s3` backend; spec 11 lists it under wave 4. | 3c builds the backend interface, the `file` backend and a contract test suite any backend must pass. The `s3` backend is wave 4's and only adds an implementation. |
| D-19 | TUS store layout (spec 13). | `@tus/server` with `@tus/file-store` in `<storage>/.tus/`; on completion the file enters the store through the same `finalize()` every upload uses (limits, MIME check, RLS insert, atomic rename). Upload ids are 128-bit random; every request re-checks the caller against the upload's stored owner. Expired uploads are pruned hourly. |
| D-20 | AC-22: one shared imgproxy. Projects have three networks each (`docs/network-isolation.md`), and no tenant container may share a bridge with a shared service. | imgproxy joins each project's `sb-<ref>-ctl` network at a fixed address. `core` calls it there with a signed imgproxy URL whose source is `http://sb-<ref>-core:8080/storage/v1/render/source/<token>` (one minute, signed with a key derived from the project's JWT secret for that purpose only). imgproxy is started with `IMGPROXY_ALLOWED_SOURCES` limited to that URL shape *(verify, upstream)* and with local-file, S3 and other source types off. Core's admin port refuses imgproxy's address. Each project gets its own key and salt pair in imgproxy's key list *(verify, upstream)*; if imgproxy cannot hold a pair per project, one shared pair is used and the bound is the allowed-source rule plus the per-project source token. |
| D-21 | S3 access keys (7.4) and "session-token mode that applies RLS". | Key pairs live in `control.project_secrets` (kind `platform`, names `s3:<access key id>`) and reach `core` in `STORAGE_SECRETS`; a request signed with one acts as `service_role`. Session-token mode: access key = project ref, secret = the anon key, `X-Amz-Security-Token` = the user's JWT, and the request runs under that user's RLS *(verify, upstream)*. |
| D-22 | AC-18's provider table against providers that are not plain OAuth2. | One engine, a table with authorize/token/userinfo URLs, scopes and claim mapping, and overrides only where upstream has them (Apple's signed client secret, Twitter/X *(verify, upstream)* which protocol the pinned server uses, Azure and Keycloak tenant URLs, GitLab and WorkOS base URLs). Google moves onto the engine in Task 29 with its v1 behaviour pinned by the existing tests. |
| D-23 | Auth hooks as Postgres functions: which role runs them. | `core` runs a hook function as `supabase_auth_admin` (`set local role`), so the `grant execute … to supabase_auth_admin` statements in unedited app migrations mean what they mean upstream. HTTPS hooks use the Standard Webhooks signature of v1's SMS hook and go through netguard. |
| D-24 | 8.6 lists auth, storage and realtime screens without depth. | Real forms for everything that is a setting or a row (providers, SMTP and templates, URL configuration, rate limits, hooks, MFA, SSO providers, sessions, bucket settings, S3 keys, realtime settings, API keys, signing keys). "Policies" under Storage and Realtime are the existing Policies screen filtered to `storage.objects` / `realtime.messages`, with templates. Reason: one policy editor. |
| D-25 | The Realtime inspector needs a socket to the project from the operator's browser. | Studio connects to the project's public websocket with a 10-minute role token minted by `POST /admin/realtime/token` (action `project.keys`, audited, roles `anon`, `authenticated` with a chosen `sub`, `service_role`). No new route into the project. |
| D-26 | Wave 1's rotating restore deletes "every restored credential"; this wave adds credential tables. | Task 36 extends the restore job's list with `auth.sessions`, `mfa_factors`, `mfa_challenges`, `mfa_amr_claims`, `flow_state`, `saml_relay_states`, `one_time_tokens` and the rate-limit table, and the counts it verifies. SSO provider rows stay (they are configuration), with their metadata URL re-checked by netguard at use. |
| D-27 | Provisioner line cap (wave 2: 1100; the tree is at 1091 before wave 2's additions). | Task 39 sets the cap to wave 2's final count plus 60 and states the count in its commit. Its only addition is attaching the imgproxy container to a project's control network. |
| D-28 | `core` at micro is capped at 256 MiB and now holds a replication stream, TUS and multipart uploads. | Uploads and downloads are streamed with bounded buffers, the replication queue is bounded per connection, and each sub-wave exit measures idle and loaded memory. Idle above 150 MiB or a conformance run above 220 MiB stops the exit and goes to the controller (changing a size changes the 16 GB budget). |
| D-29 | Model policy (owner). | Opus 5.5 on every task except Task 7 (vendoring, Sonnet), Task 44 (Sonnet) and Task 50 (handoff, Sonnet). Haiku is used for nothing here: no task is both small and free of protocol detail. Every task is reviewed by Opus; a High-risk task also gets Codex. |
| D-30 | Third-party auth (tokens from an external issuer, the client's `accessToken` option) is not in spec 8.2. | In scope by the controller's ruling (the owner's full-parity rule). Task 51: a configured issuer's token is verified against that issuer's keys and exchanged in the gateway for a 60-second project-signed token carrying the same claims, the mechanism of D-13. Issuer kinds and required claims follow upstream *(verify, upstream)*. Its management routes are in Task 38 and its Studio form in Task 42. |
| D-31 | AC-12 names MFA for dashboard logins; no wave listed it. | In scope by the controller's ruling. Task 52 (3d) builds TOTP enrol, verify and recovery for Studio logins in control on core's MFA module; Task 53 (3e) adds the Studio screens and the recovery command. Personal access tokens (`sbp_…`) are not affected by MFA, as upstream. Recovery is an operator action on the host (`cli.ts reset-mfa`, audited), not a set of backup codes: upstream has none, and the host's root already has full power. |
| D-32 | The in-place `BASE_DOMAIN` switch (spec 7.3) was parked in the ledger and is in no plan. | Task 54 (3e) builds and tests it behind `DOMAIN_SWITCH_ENABLED`, default `false`. It is not run on the server in this wave: the owner's domain is undecided, and the wave still requests zero new hostnames. REHBER keeps saying the switch is not to be used until the owner decides. |

## Parallel with wave 2

Wave 2 tasks are named `W2-n`. "Owner" is who may edit the path while both branches are open. Where both must edit, the row says where the conflict is settled.

| Path or module | Wave 2 touches it in | Wave 3 touches it in | Settled by |
|---|---|---|---|
| `db/platform/NNNN-*.sql` | W2-3, 4, 5, 11 (`0004`–`0008`) | Tasks 5, 6 (`0009`–`0011`), 36 (`0012`) | Wave 2 owns `0004`–`0008`. Wave 3 writes only after **R1**, on top of the real files. Applied in order by the runner; a wave 3 image never starts on a database without wave 2's files present. |
| `control/migrations/*.sql` | W2-14 (`0008`), W2-15 (`0009`) | Task 38 (`0010`, `0011`) | Wave 2 owns `0008` and `0009`. Wave 3 writes none before **R2**; Task 36 confirms the numbers on the merged tree. |
| `control/src/project-env.ts`, `project-secrets.ts`, `secrets.ts` | W2-4, 5, 11, 13, 14, 15 | Tasks 37, 38 | Wave 2 owns until **R2**. Wave 3 edits them only in 3e, on the merged file (`buildEnv`, `loadProjectEnv`, `ensureSecrets`, `setConfig` as wave 2 leaves them). |
| `control/src/{app.ts,forward.ts,audit.ts,config.ts,session.ts,server.ts}`, `control/src/jobs/*`, `control/src/routes/{v1.ts,platform-projects.ts,project-config.ts,shared.ts}`, `control/test/{openapi.test.ts,leak.test.ts,stub-core.ts,fake-provisioner.ts}` | W2-13 … W2-16, W2-22 | Tasks 36–40 | Same: wave 2 until **R2**, then wave 3 in 3e. Task 37 replaces wave 2's `config/auth` field table with the registry-driven one. |
| `control/src/{core.ts,core-env.ts}` (control's use of core's auth as a library) | — | Tasks 2, 8 keep every imported path and signature | Wave 3 owns core's side and must not break the imports; the control suite runs in Tasks 2, 8, 10 and at every exit. |
| `control/src/{mfa.ts,routes/platform-mfa.ts}` (new), `control/src/routes/platform-auth.ts`, and one line each in `control/src/{app.ts,session.ts,core.ts}` | W2-15, W2-16 edit `session.ts`; W2-13 … 16 edit `app.ts` | Task 52 (in 3d, before R2) | The one exception to "wave 2 owns control until R2", by the controller's ruling. Task 52 writes new files and `platform-auth.ts` (wave 2 does not touch it); its mount line in `app.ts` and its assurance-level check in `session.ts` are single added lines. A conflict at R2 keeps wave 2's lines and re-applies those two. |
| `control/src/{hosts.ts,reconcile.ts}`, `control/src/cli.ts` | none planned | Tasks 54, 53 | After **R2**. |
| `control/compose.yml`, `control/.env.example` | W2-12, W2-15 (`DB_PORT_RANGE`) | Task 39 (imgproxy service) | Wave 2 until **R2**; Task 39 after. |
| `provisioner/**` | W2-12 | Task 39 | Wave 2 until **R2**; Task 39 after, with its own security addendum and D-27's cap. |
| `template/compose.yml`, `.env.example` | W2-4, 5, 9, 10, 11 | Task 4 (optional `${X:-}` lines on `core` only), Task 36 (`rest` and `fn` JWKS lines) | Before R2 wave 3 adds only optional environment lines to the `core` service, so wave 2's control keeps creating projects. A conflict at R1 or R2 keeps both sides. Anything required or outside `core` waits for Task 36. |
| `template/compose.test.yml`, `compose.build.yml` | W2-4 | Tasks 3, 25 (test services) | Both add services or env; the merge keeps both. |
| `template/sizes.json` | W2-10 (`fn.max_workers`) | — | Wave 2. A size change from D-28 is the controller's, after R2. |
| The db image: `db/Dockerfile`, `db/entrypoint.sh` | W2-2 | none | Wave 2. Wave 3 needs nothing in the image (`wal_level=logical` is already set); if a task finds a need, it stops and asks. |
| `core/src/app.ts`, `config.ts`, `server.ts`, `log.ts` | W2-3, 5, 6, 9, 10, 11 | Tasks 2, 4 (the lines Task 2 names), 9 (gateway key exchange) | Shared, line-disjoint by rule: wave 3 moves no code wave 2 edits and puts every new setting in `core/src/settings/` and `<area>/`. A conflict at R1 or R2 keeps wave 2's lines and re-applies wave 3's registration lines. |
| `core/src/admin/index.ts` | W2-6, 7, 8, 9 (one mount line each) | Task 40 (mount lines) | Task 40 runs after **R2**. |
| `core/src/admin/migrations.ts` | W2-6 (re-arms v1 realtime triggers, wave 2 D-15) | Task 36 (removes the re-arm) | After **R2**, in the commit that adds `0012` (D-16). |
| `core/src/platform/migrate.ts` | W2-11 (`setRolePassword`) | none | Wave 2. |
| `core/src/{auth,realtime,storage}/**`, `core/src/admin/{users.ts,files.ts}`, `core/src/jwt.ts`, `core/src/netguard.ts` | none | 3a–3d, Task 40 | Wave 3. |
| `core/src/netqueue/**`, `core/src/functions/**`, `core/src/admin/{catalog,integrations,typegen,functions}.ts` | W2-3, 7, 8, 9 | none | Wave 2. |
| `core/package.json`, `control/package.json`, root `package-lock.json` | W2-15 and others | Tasks 3, 18, 24, 31, 34 | Wave 1's rule: on a lock conflict take either side, run `npm install` at the root, commit. |
| Root `package.json` (workspaces, version), `scripts/test/workspace.test.mjs` | W2-17 (workspace `cli`, count seven), W2-25 (`2.2.0`) | Task 3 (workspace `conformance`), Task 47 (`2.3.0`) | Conflict at **R2**: both workspaces stay and Task 36 sets the count to eight. The version line is wave 2's until R3. |
| `fn/**` | W2-10 | Task 36 (verify with the public JWKS, accept the gateway's exchanged token) | Wave 2 until **R2**. The client bundle path `fn` imports (`/client/selfbase.deno.mjs`) does not change in Tasks 7 and 20. |
| `client/**` | none | Tasks 7, 20 | Wave 3. |
| `cli/**` | W2-17, 18, 19 | none | Wave 2. `config push` for the new auth fields and `storage` / `sso` commands are wave 5 (spec 7.9). |
| `job/**` | W2-13 (`backup.sh` modes) | Task 36 (`restore.sh` credential list, D-26) | Wave 2 until **R2**. |
| `pooler/**` | W2-11 | none | Wave 2. |
| Studio chain: `studio/src/api.ts`, `project/index.tsx`, `project/parts.tsx`, `project/context.ts`, `project/Settings.tsx`, `i18n/{index,en,tr}.ts`, `styles.css`, `studio/package.json` | W2-20 → 21 → 22 → 23 | Tasks 41 → 42 → 43 → 44 | Strictly after: wave 3's Studio tasks start only at **R2**, when wave 2's chain is on `v2`, and are the last code tasks of the wave. They use wave 2's `Tabs`, `useSubPath` and the longest-path screen match as merged. |
| `studio/src/project/{Users.tsx,Files.tsx}`, `studio/e2e/*` (own files) | none | Tasks 41, 43 | Wave 3. |
| `acceptance/src/{full.test.ts,helpers.ts}`, `test/e2e/helpers.mjs` | W2-24 | Task 46 | After **R2**. Wave 3's e2e proof is its own file (`test/e2e/wave3.test.mjs`). |
| `.github/workflows/{ci.yml,images.yml}` | W2-2, 17, 24 | Task 36 (adds the conformance and Keycloak jobs) | Before R2 wave 3 runs its suites from a new file, `.github/workflows/conformance.yml`, which Task 36 folds into `ci.yml`. |
| `docs/reference/management-api.json`, `control/test/openapi.test.ts` | reads; W2-13, 14 add route checks | Tasks 37, 38 add route checks | After **R2**; the snapshot itself is not re-vendored by either wave. |
| `docs/REHBER.md`, `README.md` | W2-27 | Task 49 | After **R3**: wave 2's sections are on `v2` first; wave 3 appends its own and edits wave 2's only where a statement became wrong (the realtime trigger note, the API-keys page). |
| `docs/handoff/*`, `docs/proofs/*`, `docs/reviews/*`, `docs/parity/*` | `wave-2-*`, `wave2-*` | `wave-3-*`, `wave3-*`, `parity/*` | Disjoint file names. |
| Release version and image tags | `2.2.0` (W2-25) | `2.3.0` (Task 47) | Wave 2 releases and deploys first (**R3**). Project #1 is upgraded `2.2.0` → `2.3.0`; a jump from wave 1's version straight to `2.3.0` is not a supported path of this plan. |
| The server and the test host slot | W2-25, 26 | Tasks 47, 48 | Never at the same time: wave 3's server tasks start after R3, one builder. |

## Dependency map

```
1 (intake, pin, surface) ─► 2 (core modules) ─► 3 (conformance) , 4 (settings) , 7 (vendor clients)
R1 ─► 5 (0009 auth) ─► 6 (0010 storage, 0011 realtime)
3a: 8 ◄─ 2,4,5 ─► 9 ─► 10 ─► 11 ─► 12 ─► 13 ─► 14 ─► 15 (exit)         (one lane: they share auth/ modules)
3b: 16 ◄─ 2,4,6 ─► 17 ; 18 ◄─ 6 ─► 19 (needs 16) ─► 20 (needs 17, 7) ─► 21 (exit)
3c: 22 ◄─ 2,4,6 ─► 23 ─► 24 , 25 , 26 ─► 27 ─► 28 (exit)
3d: 29 ◄─ 15 ─► 30 ─► 31 ─► 32 ─► 33 ─► 34 ─► 51 ─► 35 (exit) ; 52 ◄─ 31 ─► 35
R2 ─► 36 ◄─ 21, 28, 35 ─► 37 ─► 38 ─► 39 , 40 ─► 41 ─► 42 ─► 43 ─► 44 ─► 53 (needs 52) ; 54 ◄─ 36
45 ◄─ 40 ; 46 ◄─ 45, 53, 54 ─► whole-branch gate and review ─► R3 ─► 47 ─► 48 ─► 49, 50
```

---

## Sub-wave 3.0 — Foundation

### Task 1: Intake, version pin and parity surface (gate, read-only on code)

**Model:** Opus 5.5. **Depends on:** wave 1 closed. **Files:** `docs/proofs/wave3-intake.md`, `docs/parity/{surface.md,exclusions.md,upstream.md,providers.md}`, `docs/handoff/wave-3-corteqs.md` (the advance notice only), this plan (the *(verify, upstream)* lines it closes).

- [ ] **Step 1:** Record in `wave3-intake.md`: the head of `v2` the branch is cut from; `core`'s idle memory from `docs/proofs/wave1-exit.md`; the platform and control migration files present on `v2`; whether wave 2's R1 tasks are merged yet.
- [ ] **Step 2:** Pin. Choose the newest `@supabase/supabase-js` 2.x release *(verify, upstream)*; record its version and the versions of auth-js, storage-js, realtime-js, functions-js and postgrest-js it depends on, with their tarball checksums, in `docs/parity/upstream.md`. Record the upstream server sources read for route lists and schemas (auth, storage, realtime) by repository, tag and commit, and the date.
- [ ] **Step 3:** `docs/parity/surface.md`: every public method and option of the pinned client, generated from its `.d.ts` files (a script in the scratchpad; the output is the deliverable), grouped `auth`, `auth.admin`, `auth.mfa`, `storage`, `storage.from()`, `realtime` / `channel`, `functions`, `createClient` options. Each row: method, HTTP route or socket event it uses, the task below that implements it, or `exclusion`.
- [ ] **Step 4:** `docs/parity/exclusions.md`: one row per excluded method with the reason and its source (spec section 3, spec 8.2 tail, or the client's own instability marker quoted with file and line). Start from D-9: two tables, "excluded" (non-goals, with the reason) and "scheduled: wave 5" (Web3 sign-in, the OAuth 2.1 server, WebAuthn/passkey factors — not cut). A method with no task and no valid reason stops the task and goes to the controller.
- [ ] **Step 5:** Close every *(verify, upstream)* of D-12, D-13, D-17, D-20, D-21, D-22 that can be answered by reading source, writing the finding into `upstream.md` and editing the decision's line here. A finding that contradicts a decision stops the wave and goes to the controller.
- [ ] **Step 6:** Advance notice in `docs/handoff/wave-3-corteqs.md`: the realtime protocol changes in this wave, so the app's vendored client must be refreshed when wave 3 deploys; nothing else is asked yet. **Owner step:** the owner takes it to the team now (ledger, 2026-11-24, concern 3).
- [ ] **Step 7:** Commit `docs: wave 3 intake, pinned client and parity surface`.

### Task 2: Core module boundaries

**Model:** Opus 5.5. **Depends on:** Task 1. **Files:** `core/src/modules.ts`, `core/src/{auth,realtime,storage}/index.ts`, `core/src/gateway/index.ts` (the `/rest/v1`, `/functions/v1` forwarders moved out of `app.ts`), `core/src/app.ts` and `core/src/server.ts` (the registration lines only), `core/test/modules.test.ts`.

**Interfaces — Produces:**
```ts
// core/src/modules.ts
export type Module = {
  name: 'auth' | 'realtime' | 'storage' | 'gateway'
  mount: string                                  // '/auth/v1', …
  router: Hono<any>
  start?(server: import('node:http').Server): Promise<void> | void   // sockets, workers
  stop?(): Promise<void>
}
export const modules: Module[]
```
- `app.ts` mounts `modules` in a loop where the three `app.route` lines and the two forwarders are today; `server.ts` calls `start` / `stop` where `attachRealtime` / `stopRealtime` are today. No other line of either file changes (file-ownership map).
- A module imports from the kernel (`config.ts`, `db.ts`, `jwt.ts`, `log.ts`, `ip.ts`, `netguard.ts`, `settings/`) and from its own directory. It never imports another module's files; what another module needs is exported from that module's `index.ts` (today: storage and realtime use `jwt.ts` only).
- Every path and export control imports stays: `auth/index.ts` default export, `auth/sessions.ts` `revokeSession`, `revokeUserSessions`, `auth/users.ts` `findByEmail`, `hashPassword`, `auth/ratelimit.ts` `take`, `resetRateLimits`, `auth/mail.ts` `background`, `smtpOptions`, `jwt.ts` `verify`, `ip.ts`, `db.ts` `closeDb`.

- [ ] **Step 1:** `modules.test.ts`: the four modules are mounted at their paths; a static scan of `core/src/{auth,realtime,storage}/**` finds no import that crosses into another area's directory except through its `index.ts`; every control-imported symbol above resolves and has its current type.
- [ ] **Step 2:** FAIL. **Step 3:** Implement, moving code without changing behaviour. **Step 4:** core, client and control suites PASS unchanged.
- [ ] **Step 5:** Commit `refactor: core areas behind one module interface`.

### Task 3: Conformance workspace and coverage gate

**Model:** Opus 5.5. **Depends on:** Task 2. **Files:** `conformance/{package.json,tsconfig.json,vitest.config.ts,README.md,coverage.mjs}`, `conformance/src/{clients.ts,stack.ts,auth/smoke.test.ts,storage/smoke.test.ts,realtime/smoke.test.ts}`, `conformance/pending.json`, root `package.json` (workspace), `.github/workflows/conformance.yml`, `scripts/test/no-runtime-supabase.test.mjs`.

**Interfaces — Produces:**
- `clients.ts`: `export const clients: { name: 'supabase-js' | 'selfbase-js'; create: typeof createClient }[]` — the pinned package and `client/dist`. `export function each(name: string, fn: (c: Client, kind: string) => void | Promise<void>): void` registers one test per client.
- `stack.ts`: brings up `template/compose.yml` + `compose.build.yml` + `compose.test.yml` once per run (project name `selfbase-conformance`), exposes `url`, `anonKey`, `serviceKey`, `sql(text)` (through the admin port), `mailbox(address)` (from `selfbase.mail_log`), and tears it down.
- A test declares what it covers: `covers('auth.signInWithPassword')` with the names of `docs/parity/surface.md`.
- `coverage.mjs`: reads `surface.md`, `exclusions.md`, the `covers()` calls and `pending.json`; exits 1 for a surface method with no test, no exclusion, no "scheduled" row and no pending entry, for an excluded method that has a test, and for a `pending.json` entry whose method has a test. `pending.json` starts with everything not yet built and must be `[]` at Task 45.
- `scripts/test/no-runtime-supabase.test.mjs`: fails when `@supabase/` appears in any `package.json` outside `conformance/` `devDependencies`, or in the production `node_modules` of the built `core`, `control` and `fn` images.

- [ ] **Step 1:** The three smoke tests, written against what v2 already has (`signUp` + `signInWithPassword`; `upload` + `download`; a channel `subscribe` that is expected to fail with the real client until 3b and is listed in `pending.json`). `coverage.mjs` gets its own unit test with a three-method fixture surface.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** auth and storage smoke PASS with both clients; `node conformance/coverage.mjs` exits 0 with the pending list; the no-runtime test passes.
- [ ] **Step 5:** Commit `test: conformance suite driven by the pinned supabase-js and selfbase-js`.

### Task 4: Settings registry and JSON configuration environment

**Model:** Opus 5.5. **Depends on:** Task 2. **Files:** `core/src/settings/{registry.ts,auth.ts,realtime.ts,storage.ts,load.ts,index.ts}`, `core/src/config.ts` (reads through `load.ts`; existing keys keep their names), `template/compose.yml` and `template/.env.example` (seven optional lines on `core`), `core/test/settings.test.ts`, `scripts/test/template.test.mjs`.

**Interfaces — Produces:**
```ts
// registry.ts
export type Setting = { key: string; type: 'string' | 'int' | 'bool' | 'string[]' | 'json'; default: unknown;
  api?: string;            // field name in the Management API's auth, realtime or storage config
  env?: string;            // v1 variable that still sets it (fallback)
  secret?: true; min?: number; max?: number; enum?: string[] }
export const AUTH: Setting[]; export const REALTIME: Setting[]; export const STORAGE: Setting[]
export function parse(area: Setting[], config: unknown, secrets: unknown, env: NodeJS.ProcessEnv): Record<string, unknown>
```
- Environment (all optional, JSON objects): `AUTH_CONFIG`, `AUTH_SECRETS`, `REALTIME_CONFIG`, `STORAGE_CONFIG`, `STORAGE_SECRETS`, `JWT_KEYS`, `API_KEYS`. Order of precedence per setting: JSON value, then the v1 variable named in `env`, then the default. An unknown key, a wrong type, a value outside `min`/`max`/`enum`, or a secret key inside a non-secret object stops startup with the key's name and never its value.
- The registry is filled by the tasks that add settings; this task enters every setting `core` reads today (the `auth*`, `smtp`, `google`, `storage*` keys of `config.ts`) with its `api` name from `docs/reference/management-api.json`, so wave 2's Task 13 map and this registry agree.
- `export function publicSettings(): object` — what `GET /auth/v1/settings` may show; built from non-secret keys only (Review Focus 7).

- [ ] **Step 1:** `settings.test.ts`: with no JSON value every existing setting equals today's `config`; `AUTH_CONFIG={"site_url":"https://a.test"}` overrides `SITE_URL`; an unknown key, `"password_min_length":"x"` and a secret key placed in `AUTH_CONFIG` each stop the load and the error contains the key and not the value; `publicSettings()` contains no key marked secret (checked over the whole registry, so later tasks cannot regress it); every `api` name exists in the OpenAPI snapshot's auth, realtime or storage config schema. `template.test.mjs`: the stack starts with all seven variables unset.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** core, control and `scripts/test` suites PASS.
- [ ] **Step 5:** Commit `feat: typed settings registry with json configuration values`.

### Task 5: Platform migration `0009` — auth schema

**Model:** Opus 5.5. **Depends on:** R1, Task 2. **Files:** `db/platform/0009-auth-schema.sql`, `core/test/{platform.test.ts,auth-schema.test.ts}`, `docs/parity/upstream.md` (schema source).

**Interfaces — Produces** (column lists follow the upstream auth schema at the pinned date *(verify, upstream)*; ours may have fewer indexes, never different column names or types):
- New tables: `auth.sessions`, `auth.mfa_factors`, `auth.mfa_challenges`, `auth.mfa_amr_claims`, `auth.flow_state`, `auth.sso_providers`, `auth.sso_domains`, `auth.saml_providers`, `auth.saml_relay_states`, `auth.audit_log_entries`. Added columns: `auth.users` (`is_anonymous`, `is_sso_user`, `banned_until`, `phone`, `phone_confirmed_at`, `phone_change*`, `reauthentication_token`, `reauthentication_sent_at`, `deleted_at`, whichever are missing), `auth.identities` (`provider_id`, `email` generated, `last_sign_in_at`), `auth.refresh_tokens` (`session_id` foreign key once sessions are backfilled), `auth.one_time_tokens` (token types for the OTP kinds of Task 12).
- Backfill: one `auth.sessions` row per distinct `session_id` in `auth.refresh_tokens` that has an unrevoked token (`aal1`, AMR method `token_refresh`); idempotent.
- Functions kept current: `auth.uid()`, `auth.role()`, `auth.email()`, `auth.jwt()`.
- Rate limits (AC-20): `create unlogged table selfbase.rate_limits (bucket text, key text, tokens double precision, updated_at timestamptz, primary key (bucket, key))` and `selfbase.take_rate_limit(p_bucket text, p_key text, p_capacity int, p_refill_per_sec double precision) returns boolean` (one statement, row lock, clamps to capacity); `selfbase.prune_rate_limits()`.
- Role `supabase_auth_admin` (NOLOGIN since v1's compat roles) gets usage on `auth` and the rights hook functions need (D-23). Grants on the new tables: none to `anon` or `authenticated`.

- [ ] **Step 1:** Tests: `0009` twice succeeds; on a database with two live refresh-token sessions the backfill makes exactly two session rows and a second run adds none; on control-db's shape (auth schema present, no app tables) it succeeds; `anon` and `authenticated` can select none of the new tables; `take_rate_limit('t','k',3,0)` returns true three times then false, and after `updated_at` is moved back with refill 1/s it returns true again; a column-by-column comparison with the fixture taken from the upstream schema reports no missing column.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** core and control suites PASS (control-db applies `0009` too).
- [ ] **Step 5:** Commit `feat: auth schema for sessions, mfa, sso, flow state, audit log and rate limits`.

### Task 6: Platform migrations `0010` storage schema and `0011` realtime schema

**Model:** Opus 5.5. **Depends on:** Task 5. **Files:** `db/platform/{0010-storage-schema,0011-realtime-schema}.sql`, `core/test/{platform.test.ts,storage-schema.test.ts,realtime-schema.test.ts}`.

**Interfaces — Produces** (*(verify, upstream)* for names and signatures):
- `0010`: `storage.buckets` and `storage.objects` gain the missing upstream columns (`owner_id`, `version`, `user_metadata`, `path_tokens` generated, `last_accessed_at`, bucket `avif_autodetection`, `type`); tables `storage.s3_multipart_uploads`, `storage.s3_multipart_uploads_parts`; functions `storage.foldername(text)`, `storage.filename(text)`, `storage.extension(text)`, `storage.search(…)` and the list-v2 function with upstream's signatures, so policies and RPC calls in unedited app migrations resolve. RLS stays enabled on both tables; existing policies untouched.
- `0011`: schema `realtime`; `realtime.messages` (partitioned by day as upstream, RLS enabled, no policy), `realtime.send(payload jsonb, event text, topic text, private boolean default true)`, `realtime.broadcast_changes(topic_name text, event_name text, operation text, table_name text, table_schema text, new record, old record, level text default 'ROW')`, `realtime.topic() returns text` (reads the setting core sets per check); publication `supabase_realtime_messages_publication` for `realtime.messages`; `selfbase.realtime_maintain()` creating the next three daily partitions and dropping those older than three days. **Additive only**: the v1 triggers, `selfbase.enable_realtime` and publication `supabase_realtime` are not touched (D-16).

- [ ] **Step 1:** Tests: both files twice succeed; a v1 database with a `selfbase_realtime` trigger still has it; `select realtime.send('{"a":1}','e','room:1')` inserts one row into today's partition; `realtime_maintain()` on a database with a five-day-old partition drops it and keeps today's; an `authenticated` role without a policy can neither select nor insert `realtime.messages`; a policy using `storage.foldername(name)` can be created; both files succeed on control-db's shape.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat: storage and realtime schemas`.

### Task 7: Vendor auth-js, storage-js and functions-js; rebuild `selfbase-js` on them

**Model:** Sonnet (mechanical, large; Opus review). **Depends on:** Tasks 1, 3. **Files:** `client/vendor/{auth-js,storage-js,functions-js}/**` (sources + `LICENSE`), `client/vendor/README.md`, `client/src/{SupabaseClient.ts,index.ts,fetch.ts,types.ts}`, `client/src/{auth.ts,storage.ts,functions.ts}` (deleted), `client/build.mjs`, `client/test/*`, `client/README.md`, `client/INVENTORY.md` (the "Not covered" section).

**Interfaces — Produces:** the vendored sources at the versions Task 1 recorded, unmodified except: imports rewritten to relative paths, the client-info header set to `selfbase-js/<version>`, and our `fetch.ts` as the fetch layer. Each change to a vendored file is listed in `client/vendor/README.md` (file, line, why). Output files keep their names (`client/dist/selfbase.mjs`, `selfbase.d.ts`, `selfbase.deno.mjs`). `client/src/realtime.ts` (the v1 protocol) is untouched until Task 20.

- [ ] **Step 1:** Tests: the existing client suites, adjusted only where they reached into deleted internals; `client/test/types.test.ts` asserts that the exported `SupabaseClient`, `Session`, `User`, `AuthError` types are assignable both ways with the pinned package's (a type-only import in the conformance workspace); a scan of `client/dist` for telemetry and analytics endpoints finds nothing; the INVENTORY `tsc` check of the CorteQS app against `dist/selfbase.d.ts` still reports 0 errors (read-only use of the worktree).
- [ ] **Step 2:** FAIL. **Step 3:** Vendor and rewire. **Step 4:** client suite and conformance smoke (both clients) PASS; bundle size recorded in the commit body.
- [ ] **Step 5:** Commit `feat: selfbase-js built on the vendored auth, storage and functions clients`.

## Sub-wave 3a — Auth core

One lane: Tasks 8–14 share `core/src/auth/` and run in sequence. Each adds its settings to `settings/auth.ts`, its routes to its own route file, and its `covers()` tests to `conformance/src/auth/`.

### Task 8: Sessions, AAL and AMR, session policy

**Model:** Opus 5.5. **High-risk.** **Depends on:** Tasks 2, 4, 5. **Files:** `core/src/auth/{sessions.ts,session-policy.ts,claims.ts,routes-core.ts}`, `core/src/jwt.ts` (claim type), `core/src/settings/auth.ts`, `core/test/{sessions.test.ts,auth-core.test.ts}`, `conformance/src/auth/session.test.ts`.

**Interfaces — Produces:**
- `JwtClaims` gains `aal: 'aal1' | 'aal2'`, `amr: { method: string; timestamp: number }[]`, `is_anonymous: boolean`, `iss`, `phone`. `export async function issue(userId: string, sessionId: string): Promise<SessionJson>` builds every access token from the `auth.sessions` row and `auth.mfa_amr_claims` (D-11). `export async function createSession(user, method: AmrMethod, meta: { ip: string; userAgent: string }): Promise<SessionJson>`.
- Settings: `sessions_timebox`, `sessions_inactivity_timeout`, `sessions_single_per_user`, `jwt_exp`, `refresh_token_rotation_enabled`, `security_refresh_token_reuse_interval`.
- `POST /logout?scope=global|local|others` (default `global`), with a user's JWT or, for `auth.admin.signOut`, the service key plus the user's JWT. Every route that requires a user checks the session row: missing, timed out, past its timebox, or the user banned or deleted → 401/403 with upstream's error codes *(verify, upstream)*. Single-session mode ends older sessions at sign-in.
- All revocations (logout, ban, password change, user delete) and refresh rotation take the same per-session row lock, in the same order, so none can interleave (wave 1 S4).

- [ ] **Step 1:** Tests: a recovery sign-in's `amr` survives three refreshes (the ledger's defect); a refresh token from before `0009` (fixture) refreshes once and gains a session row; inactivity 2 s and timebox 3 s end a session at the right moment (fake clock) with the upstream code; single-session mode signs the first device out; a user banned between two requests gets 403 on the second without waiting for token expiry; `scope=others` keeps the caller's session only; **race:** 50 rounds of logout against a concurrent refresh, and of ban against a concurrent refresh, never leave an unrevoked token (Review Focus 1); the control suite's dashboard login, reset and logout pass.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** core, control, conformance `session` PASS.
- [ ] **Step 5 (security review):** Codex + opus on the diff. Attack list: refresh-token reuse inside and outside the reuse interval; a token whose session row was deleted; `session_id` of another user; scope parameter tampering; revocation races; claims taken from the request instead of the row.
- [ ] **Step 6:** Commit `feat: auth sessions with aal, amr and session policy`.

### Task 9: Signing keys, JWKS, and new-style API keys in the gateway

**Model:** Opus 5.5. **High-risk.** **Depends on:** Task 8. **Files:** `core/src/jwt.ts`, `core/src/keys.ts`, `core/src/gateway/{index.ts,apikey.ts}`, `core/src/auth/routes-wellknown.ts`, `core/src/settings/auth.ts`, `template/compose.test.yml` (a JWKS for `rest` in tests), `core/test/{jwt.test.ts,keys.test.ts,gateway.test.ts}`, `conformance/src/auth/claims.test.ts`.

**Interfaces — Produces:**
- `JWT_KEYS`: `[{ kid, alg: 'HS256' | 'ES256' | 'RS256', status: 'in_use' | 'standby' | 'previously_used' | 'revoked', private_jwk?, public_jwk? }]`; absent → one HS256 key from `JWT_SECRET` (today's behaviour). `sign()` uses the `in_use` key and sets `kid`; `verify()` accepts `in_use`, `standby` and `previously_used` keys, selects by `kid` when present, pins the algorithm to the key's own, and refuses `revoked`, an unknown `kid`, `alg: none` and an asymmetric key's public part used as an HMAC secret.
- `GET /auth/v1/.well-known/jwks.json` → public keys of non-revoked asymmetric keys, `Cache-Control: public, max-age=600`.
- `API_KEYS`: `[{ id, type: 'publishable' | 'secret', prefix, sha256 }]`. `export async function resolveApiKey(header: string, origin?: string): Promise<JwtClaims | null>` — a `sb_publishable_…` key maps to role `anon`, `sb_secret_…` to `service_role` (refused with a browser `Origin`, D-13), compared in constant time; legacy JWT keys work as today. The gateway (`/rest/v1`, `/functions/v1`, and `/graphql/v1` once wave 2's route is merged) replaces a new-style `apikey` with a 60-second role JWT; when the request also carries a user's `Authorization` JWT, that one is forwarded untouched. The `auth()` middleware accepts both kinds for auth, storage and realtime.

- [ ] **Step 1:** Tests: with an ES256 `in_use` key and the HS256 key `previously_used`, new tokens verify against the JWKS with `jose` and old HS256 tokens still pass; PostgREST (compose test, JWKS in `PGRST_JWT_SECRET`) accepts both — if it does not, stop (D-12); a token signed HS256 with the EC public key's bytes, `alg: none`, an unknown `kid` and a `revoked` key are each 401; `getClaims()` of both clients verifies an ES256 token offline; a publishable key reads a public table through `/rest/v1` and the request PostgREST receives carries a JWT expiring within 60 s and no `sb_` value; a secret key with `Origin: https://x.test` → 401; a key differing in its last character → 401; a signed-URL token and a flow-state token presented as `apikey` → 401 (Review Focus 2).
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** core and conformance `claims` PASS.
- [ ] **Step 5 (security review):** Codex + opus. Attack list: algorithm confusion, `kid` injection (path or SQL shaped), a JWKS exposing a private member, exchanged-token lifetime and audience, key comparison timing, a secret key through a browser request, header smuggling between `apikey` and `Authorization`.
- [ ] **Step 6:** Commit `feat: asymmetric signing keys, jwks and publishable and secret api keys`.

### Task 10: Database rate limits and the auth audit log

**Model:** Opus 5.5. **High-risk.** **Depends on:** Task 9. **Files:** `core/src/auth/{ratelimit.ts,audit.ts,index.ts}`, `core/src/settings/auth.ts`, `core/test/{ratelimit.test.ts,auth-audit.test.ts}`.

**Interfaces — Produces:**
- `export function limit(bucket: RateBucket): MiddlewareHandler` — calls `selfbase.take_rate_limit` keyed by the trusted client IP (and by user or address where upstream does); settings `rate_limit_email_sent`, `rate_limit_sms_sent`, `rate_limit_verify`, `rate_limit_token_refresh`, `rate_limit_otp`, `rate_limit_anonymous_users` with upstream's defaults and units *(verify, upstream)*; 429 with upstream's body. The database being unreachable fails closed for mail and SMS sends and open for token refresh.
- The in-memory `take` / `resetRateLimits` exports stay, unchanged, for control (D-14).
- `export function auditEvent(action: string, actor: { id?: string; username?: string }, ip: string, traits?: object): void` writes `auth.audit_log_entries` in upstream's payload shape for login, logout, signup, token refresh, recovery, invite, user update and delete, factor and identity events; never a token, password or OTP; rows older than 90 days are pruned by the hourly maintenance tick.

- [ ] **Step 1:** Tests: limits survive a core restart (new process, same database); two core processes against one database share a bucket (the count is exact under 40 concurrent requests); a spoofed `X-Forwarded-For` does not change the key; with the database paused a `/recover` answers 5xx and sends nothing; each listed action writes one audit row whose JSON contains no value from the request's `password`, `token`, `code` or `refresh_token` fields; control's suite passes with the in-memory limiter.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5 (security review):** Codex + opus. Attack list: a bucket key chosen by the client, limiter bypass through path or method variants of one route, table growth from unique keys, secrets in audit rows.
- [ ] **Step 6:** Commit `feat: auth rate limits in the database and the auth audit log`.

### Task 11: PKCE flow

**Model:** Opus 5.5. **High-risk.** **Depends on:** Task 10. **Files:** `core/src/auth/{flow.ts,routes-core.ts,routes-email.ts,routes-oauth.ts,redirect.ts}`, `core/test/pkce.test.ts`, `conformance/src/auth/pkce.test.ts`.

**Interfaces — Produces:** `code_challenge` + `code_challenge_method` (`s256`, `plain`) accepted on `/signup`, `/otp`, `/recover`, `/resend`, `/authorize`, `/user` (email change) and stored in `auth.flow_state`; a verified link or OAuth callback of a PKCE flow redirects with `?code=<auth code>` instead of tokens in the fragment; `POST /token?grant_type=pkce` `{auth_code, code_verifier}` → session, once, within the flow's lifetime (5 minutes *(verify, upstream)*). Implicit flow stays the default and is unchanged. `export async function startFlow(input: FlowInput): Promise<string>`, `export async function exchange(authCode: string, verifier: string): Promise<SessionJson>`.

- [ ] **Step 1:** Tests: `exchangeCodeForSession` of both clients completes sign-up confirm, magic link and recovery with `flowType: 'pkce'`; the same code a second time → 4xx and no session; a wrong verifier → 4xx and the flow row is burnt; a code from flow A with the verifier of flow B fails; an expired flow fails; two concurrent exchanges of one code yield exactly one session; the redirect never contains an access or refresh token in PKCE mode; `redirect_to` outside the allow list falls back to the site URL as today; with no `code_challenge` every existing implicit-flow test passes untouched.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5 (security review):** Codex + opus. Attack list: code replay and race, downgrade from PKCE to implicit by dropping the challenge mid-flow, `plain` method handling, the auth code in logs or `Referer`, open redirect through `redirect_to` encodings.
- [ ] **Step 6:** Commit `feat: pkce flow for email and oauth sign-ins`.

### Task 12: Email OTP codes, verify types, invite, reauthentication, templates, settings endpoint

**Model:** Opus 5.5. **High-risk.** **Depends on:** Task 11. **Files:** `core/src/auth/{otp.ts,routes-email.ts,routes-core.ts,mail.ts,templates.ts,routes-settings.ts}`, `core/src/settings/auth.ts`, `core/test/{otp.test.ts,templates.test.ts}`, `conformance/src/auth/{otp.test.ts,email.test.ts}`.

**Interfaces — Produces:**
- Every auth mail carries a link and a 6-digit code (`mailer_otp_length` 6–10); `POST /verify` and `GET /verify` accept types `signup`, `invite`, `magiclink`, `recovery`, `email_change`, `email` with `token` or `token_hash`; codes are stored hashed, single use, expire with `mailer_otp_exp`, and five wrong attempts burn the code.
- `GET /reauthenticate` sends a nonce; `PUT /user` with a new password requires it when `security_update_password_require_reauthentication` is on, as upstream *(verify, upstream)*. `POST /resend` for `signup`, `email_change`. `POST /invite` (service role); the admin wrapper is Task 14.
- Templates: per-type subject and body settings (`mailer_subjects_*`, `mailer_templates_*_content`) rendered with upstream's variables (`{{ .ConfirmationURL }}`, `{{ .Token }}`, `{{ .TokenHash }}`, `{{ .SiteURL }}`, `{{ .Email }}`, `{{ .NewEmail }}`, `{{ .RedirectTo }}`, `{{ .Data }}`), HTML-escaped; an unknown variable renders empty; a template can read nothing but those variables. The defaults stay v1's texts.
- `GET /auth/v1/settings` → `publicSettings()` in upstream's shape (`external`, `disable_signup`, `mailer_autoconfirm`, `phone_autoconfirm`, `sms_provider`, `saml_enabled`); `GET /auth/v1/health`.

- [ ] **Step 1:** Tests: `verifyOtp` of both clients for each type with the code read from the mailbox helper; the link and the code of one mail are one token (using either burns both); the sixth wrong code fails even when correct; codes of two users never collide in lookup (the hash includes the address); a template `{{ .Token }} <script>{{ .Data.name }}</script>` renders the escaped name; `{{ .Env }}` and `{{ template "x" }}` render nothing; a password change without the nonce → the upstream error, with it → 200 and the other sessions end; `/settings` has no secret (a scan of the response for every stored secret value); the mail interval and rate limit of Task 10 apply to every sending route.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5 (security review):** Codex + opus. Attack list: OTP brute force across types and addresses, a token-hash oracle, template injection, user enumeration through response or timing differences between known and unknown addresses, email-change takeover with secure change on and off.
- [ ] **Step 6:** Commit `feat: email otp codes, verify types, reauthentication and mail templates`.

### Task 13: Anonymous sign-in, password policy, leaked-password check, CAPTCHA

**Model:** Opus 5.5. **High-risk.** **Depends on:** Task 12. **Files:** `core/src/auth/{anonymous.ts,password.ts,captcha.ts,outbound.ts,routes-core.ts}`, `core/src/settings/auth.ts`, `core/test/{anonymous.test.ts,password.test.ts,captcha.test.ts}`, `conformance/src/auth/anonymous.test.ts`.

**Interfaces — Produces:**
- `POST /signup` with no credentials and `external_anonymous_users_enabled` on → an anonymous user (`is_anonymous` column and claim), limited by `rate_limit_anonymous_users`; `updateUser({email})` / `({phone})` and identity linking convert it; anonymous users cannot use recovery.
- Password rules: `password_min_length`, `password_required_characters` (upstream's classes) → 422 `weak_password` with `reasons`. `password_hibp_enabled`: SHA-1 prefix (5 hex) to the fixed endpoint `https://api.pwnedpasswords.com/range/`, padding on, 2 s timeout, through netguard; unreachable → the password is accepted and a warning logged (as upstream *(verify, upstream)*).
- CAPTCHA: `security_captcha_enabled`, `security_captcha_provider` (`hcaptcha`, `turnstile`), secret in `AUTH_SECRETS`; `gotrue_meta_security.captcha_token` checked on sign-up, sign-in, OTP, recovery and anonymous sign-in against the vendor's fixed verify URL; a missing or refused token → 400 `captcha_failed`.
- `outbound.ts`: `export async function outbound(url: string, init: RequestInit, opts: { timeoutMs: number }): Promise<Response>` (netguard + timeout, the one way auth code calls out) and `export function setOutbound(fn: typeof outbound | null): void` (tests only, D-7). Vendor URLs are constants.

- [ ] **Step 1:** Tests: `signInAnonymously` of both clients, then converting with an email keeps the user id and clears `is_anonymous` after confirmation; RLS can tell anonymous users apart (`auth.jwt()->>'is_anonymous'`); the anonymous rate limit holds; each character-class rule refuses and names its reason; the HIBP stub sees only five hex characters and never the password or full hash, and a listed password is refused; the stub timing out lets the sign-up through; with CAPTCHA on, each protected route without a token → 400, with the stub's pass token → 200, and the secret appears in no response or log; none of the three vendor hosts can be changed by any setting (registry scan).
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5 (security review):** Codex + opus. Attack list: anonymous-user flood, privilege carried from an anonymous session into a linked account, CAPTCHA bypass on one route variant, k-anonymity leak, control of an outbound target.
- [ ] **Step 6:** Commit `feat: anonymous sign-in, password policy and captcha`.

### Task 14: Admin API — users CRUD, generate link, invite

**Model:** Opus 5.5. **High-risk.** **Depends on:** Task 13. **Files:** `core/src/auth/{routes-admin.ts,routes-core.ts}`, `core/test/auth-admin.test.ts`, `conformance/src/auth/admin.test.ts`.

**Interfaces — Produces** (service role or secret key only; upstream's shapes *(verify, upstream)*): `GET /admin/users` (page, per_page), `POST /admin/users`, `GET /admin/users/:id`, `PUT /admin/users/:id` (email, phone, password, `email_confirm`, `phone_confirm`, `user_metadata`, `app_metadata`, `ban_duration`, `role`) — closing the ledger's `updateUserById` 404 — `DELETE /admin/users/:id` (`should_soft_delete`), `POST /admin/generate_link` (types `signup`, `invite`, `magiclink`, `recovery`, `email_change_current`, `email_change_new`; returns the link, `hashed_token`, `email_otp`; sends no mail), `POST /invite`. A ban or a password set here ends the user's sessions through Task 8's lock. Factor and SSO admin routes are Tasks 31 and 34.

- [ ] **Step 1:** Tests: every `auth.admin.*` user method of both clients (create, get, list with pagination, update each field, delete hard and soft, invite, generate each link type and complete it with `verifyOtp`); each route with the anon key or a user's JWT → 401/403; a user JWT whose `app_metadata` says `role: service_role` is refused (the role comes from the key); `ban_duration: '1h'` ends the session at once; no route echoes `encrypted_password`; a body naming a column outside the list changes nothing.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5 (security review):** Codex + opus. Attack list: privilege escalation through metadata, mass assignment, link generation with a foreign redirect, reuse of a soft-deleted user's address.
- [ ] **Step 6:** Commit `feat: auth admin api for users, links and invites`.

### Task 15: Sub-wave 3a exit

**Model:** Opus 5.5 (controller-run). **Depends on:** Task 14. **Files:** `docs/proofs/wave3a-exit.md`.

- [ ] **Step 1:** Conformance `auth` (everything `surface.md` does not assign to 3d) green with both clients; `coverage.mjs` exits 0 with 3a's methods removed from `pending.json`; core, client and control suites green; CorteQS app unit tests green against a local stack with `selfbase-js` (read-only use of the worktree).
- [ ] **Step 2:** Layered security gate on the diff since Task 7: `security-audit` skill, `security-reviewer` agent, Codex. Every Critical or Important finding is fixed with a regression test in one fix wave; Minors are listed in the ledger.
- [ ] **Step 3:** Memory: `docker stats --no-stream` for `core` idle and during the conformance run on a micro-sized compose stack; thresholds of D-28.
- [ ] **Step 4:** `wave3a-exit.md` (results, counts, memory; no secret). Commit `docs: wave 3a exit proof`.

## Sub-wave 3b — Realtime

### Task 16: Phoenix protocol and socket layer

**Model:** Opus 5.5. **High-risk.** **Depends on:** Tasks 2, 4, 6. **Files:** `core/src/realtime/{socket.ts,codec.ts,channel.ts,limits.ts,index.ts}`, `core/src/settings/realtime.ts`, `core/test/{realtime-codec.test.ts,realtime-socket.test.ts}`.

**Interfaces — Produces:**
- The new layer serves `/realtime/v1/websocket` for clients that send a `vsn` query parameter; the v1 hub keeps serving its own clients until Task 20. `codec.ts`: `decode(frame: string | Buffer, vsn: string): Message`, `encode(msg: Message, vsn: string): string | Buffer` for exactly the serializer versions of D-17. `Message = { join_ref: string | null; ref: string | null; topic: string; event: string; payload: unknown }`.
- Events: `phx_join` (payload `config: { broadcast: { ack, self }, presence: { key, enabled }, postgres_changes: [...], private }`, `access_token`), `phx_leave`, `heartbeat` on topic `phoenix`, `access_token`, replies `phx_reply` (`ok` / `error` with upstream's reasons), `phx_close`, `phx_error`, `system`. Authentication: `apikey` query or header (legacy or new-style, Task 9) plus the join's `access_token`; a token that expires closes its channels with upstream's message, and a refreshed `access_token` event keeps them.
- `export function registerExtension(name: 'broadcast' | 'presence' | 'postgres_changes', handler: Extension): void` — Tasks 17 and 19 plug in here.
- Limits from settings with upstream's defaults *(verify, upstream)*: `max_channels_per_client`, `max_joins_per_second`, `max_events_per_second`, `max_payload_size_in_kb`, `max_concurrent_users`, `max_presence_events_per_second`; over a limit → the upstream error reply or `system` message, and past a hard bound the socket closes. A connection's outbound queue is bounded.

- [ ] **Step 1:** Tests with raw `ws` frames and with the pinned realtime-js: join, reply, heartbeat, leave, rejoin of the same topic; text and binary frames of each accepted version round-trip; malformed frames (not JSON, wrong arity, a 2 MiB payload, a topic of 10 000 characters, binary with a lying length header) are refused without an exception escaping and memory stays flat over 10 000 of them; one channel above the per-client limit is refused; 1000 joins in a second trip the limit; a token expiring in 2 s closes the channel and an `access_token` event before that keeps it; a join with a token signed by another secret → error reply.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS; the v1 realtime tests still pass.
- [ ] **Step 5 (security review):** Codex + opus. Attack list: the frame parser (length fields, prototype keys in payloads, deep nesting), slow-reader memory growth, limit bypass with many sockets, a token swap to another user, cross-channel reference reuse.
- [ ] **Step 6:** Commit `feat: phoenix channel protocol for realtime`.

### Task 17: Broadcast, presence and private-channel authorization

**Model:** Opus 5.5. **High-risk.** **Depends on:** Task 16. **Files:** `core/src/realtime/{broadcast.ts,presence.ts,authz.ts,routes.ts}`, `core/test/{realtime-broadcast.test.ts,realtime-presence.test.ts,realtime-authz.test.ts}`, `conformance/src/realtime/{broadcast.test.ts,presence.test.ts}`.

**Interfaces — Produces:**
- Broadcast in memory: `self`, `ack`, payload limit; `POST /realtime/v1/api/broadcast` `{messages: [{topic, event, payload, private?}]}` with an API key (upstream's status codes).
- Presence: `track`, `untrack`, `presence_state`, `presence_diff` with upstream's key and metadata shape; a socket's presences leave when it closes; per-channel key limit.
- Private channels: `authz.ts` `export async function authorize(claims: JwtClaims, topic: string): Promise<{ read: boolean; write: boolean; presenceRead: boolean; presenceWrite: boolean }>` — runs as the subscriber's role with its claims and `realtime.topic()` set, probing the RLS policies of `realtime.messages` for `select` and `insert` on the `broadcast` and `presence` extensions, as upstream *(verify, upstream)*; cached per (claims hash, topic) until the token changes. A private join without read permission is refused; a write without permission is dropped with an error reply. A public channel needs no policy; setting `private_only` refuses public joins.

- [ ] **Step 1:** Tests: two clients exchange a broadcast, `self: false` is not echoed, `ack: true` replies; the HTTP route delivers to subscribers and refuses without a key; presence sync, join and leave events arrive in both clients; a private topic with policy `realtime.topic() = 'room:' || auth.uid()` admits its owner and refuses another user and `anon`; a user with a select but no insert policy receives and cannot send; dropping the policy and reconnecting refuses the join; two users with different claims never share a cache entry (the query count proves it); `private_only` refuses a public join.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5 (security review):** Codex + opus. Attack list: topic spoofing (case, Unicode, whitespace, the `realtime:` prefix), a cache keyed too coarsely, a presence payload as an amplifier, the HTTP route with a publishable key sending to private topics.
- [ ] **Step 6:** Commit `feat: realtime broadcast, presence and private channels`.

### Task 18: Logical replication reader

**Model:** Opus 5.5. **Depends on:** Task 6 (parallel with 16, 17). **Files:** `core/src/realtime/{replication.ts,pgoutput.ts}`, `core/package.json` (`pg-logical-replication`), `core/test/realtime-replication.test.ts`.

**Interfaces — Produces:**
```ts
export type Change = { lsn: string; commitTs: number; schema: string; table: string; type: 'INSERT' | 'UPDATE' | 'DELETE';
  relationOid: number; columns: { name: string; typeOid: number; key: boolean }[]; record: Record<string, unknown> | null;
  old: Record<string, unknown> | null }
export function startReplication(onChange: (c: Change) => void, onState: (s: 'streaming' | 'down') => void): { stop(): Promise<void> }
```
- One replication connection as `postgres`, a `TEMPORARY LOGICAL` slot with `pgoutput`, publications `supabase_realtime` and `supabase_realtime_messages_publication`, protocol version 1. Reconnect with backoff (1 s to 30 s) and a new slot each time (AC-21): changes during a gap are lost, and subscribers get a `system` message when the stream returns. Standby status updates acknowledge what was handed to `onChange`.
- Values are converted per type OID to the JSON shape upstream's `postgres_changes` payloads use (numbers, booleans, json, arrays; everything else as text) *(verify, upstream)*. Unchanged TOAST columns are omitted from `record`. A transaction larger than 16 MiB of decoded changes is dropped whole with a `system` overflow message.
- The first step of this task is the D-15 proof.

- [ ] **Step 1:** Tests against real Postgres 17: the D-15 proof (the library opens a temporary slot with our `pg` version and streams an insert); after `startReplication`, `pg_replication_slots` shows one temporary slot, and after `stop()` or a killed core process it shows none; insert, update and delete on a published table arrive in commit order with `old` following `REPLICA IDENTITY` (default → key columns, full → whole row); a table added to the publication while streaming is picked up; a table without a primary key delivers inserts; `pg_terminate_backend` on the walsender → `down`, then `streaming` again within 35 s; with the reader stopped and 200 MB of writes, no WAL is retained for it; a 32 MiB transaction is dropped with the overflow signal and memory stays under the cap; `realtime.messages` inserts arrive as changes.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat: logical replication reader on a temporary slot`.

### Task 19: `postgres_changes` delivery under RLS, and database broadcast

**Model:** Opus 5.5. **High-risk.** **Depends on:** Tasks 16, 18. **Files:** `core/src/realtime/{changes.ts,filters.ts,dbbroadcast.ts}`, `core/test/{realtime-changes.test.ts,realtime-filters.test.ts,realtime-dbbroadcast.test.ts}`, `conformance/src/realtime/changes.test.ts`.

**Interfaces — Produces:**
- Subscriptions from the join's `postgres_changes` list (`event`, `schema`, `table`, `filter`); the reply carries server ids as upstream. Filters `eq, neq, lt, lte, gt, gte, in` parsed by `filters.ts` (`export function parseFilter(s: string): Filter`) and compared with Postgres semantics for the column's type by a parameterised query, never by string building.
- Visibility: for each change and each group of subscribers with identical (role, claims) the row is looked up by primary key as that role with those claims; visible → delivered with `columns`, `record`, `old_record`, `commit_timestamp`, `errors` in upstream's shape. DELETE with RLS enabled on the table sends primary-key columns only. A subscriber whose token expired is skipped and its channel closed. A table without a primary key under RLS is not delivered and the join's reply says why *(verify, upstream)*.
- Database broadcast: changes on `realtime.messages` become broadcast or presence messages to the row's `topic`, through Task 17's authorization for private rows; `realtime.broadcast_changes()` in a trigger therefore reaches subscribers.
- An events-per-second limit per connection; over it the changes are dropped and one `system` message is sent.

- [ ] **Step 1:** Tests: the five CorteQS subscription shapes of `client/INVENTORY.md` (INSERT on a table, with and without `col=eq.value`) deliver through both clients; each filter operator on int, text, uuid, timestamptz and a quoted `in` list; a filter on a column that does not exist is refused at join; a row the subscriber's policy hides is not delivered while another subscriber gets it; an UPDATE that moves a row out of the subscriber's view is not delivered; a policy reading `auth.jwt()->'app_metadata'` distinguishes two users who differ only there, with one check per group; DELETE under RLS carries only the key; a subscriber whose token expired mid-stream gets nothing more; a slow policy (`pg_sleep`) hits the statement timeout and stalls nobody else; a trigger calling `realtime.broadcast_changes` on a private topic reaches the permitted user only; 5000 inserts in a second produce the `system` overflow and no crash.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5 (security review):** Codex + opus. Attack list (Review Focus 4): claim-group collisions, filter injection, visibility checked with stale claims after `access_token`, old-record leakage on UPDATE and DELETE, schema or table names from the client reaching SQL, a published table the role cannot select.
- [ ] **Step 6:** Commit `feat: postgres changes under rls and database broadcast`.

### Task 20: Cutover — v1 hub removed, realtime-js vendored

**Model:** Opus 5.5. **Depends on:** Tasks 7, 17, 19. **Files:** `core/src/realtime/hub.ts` (deleted), `core/src/realtime/index.ts`, `core/test/realtime.test.ts` (rewritten on the protocol), `client/vendor/realtime-js/**`, `client/src/realtime.ts` (deleted), `client/src/SupabaseClient.ts`, `client/test/{realtime.test.ts,fake-server.ts}`, `client/vendor/README.md`, `conformance/pending.json`.

- [ ] **Step 1:** Tests: `selfbase-js` channels pass the realtime conformance files; `removeChannel`, `removeAllChannels`, `realtime.setAuth`, and a reconnect after a core restart that resubscribes by itself; a v1-protocol client (the old frame shape) gets a clean close with a reason and no crash; the Deno bundle connects from the `fn` test fixture.
- [ ] **Step 2:** FAIL. **Step 3:** Remove the hub and its LISTEN connection, vendor realtime-js under Task 7's rules, rewire. The v1 triggers and `selfbase.enable_realtime` stay in the database (D-16). **Step 4:** core, client and conformance `realtime` PASS with both clients.
- [ ] **Step 5:** Commit `feat: realtime served only by the phoenix protocol; selfbase-js on the vendored realtime client`.

### Task 21: Sub-wave 3b exit

**Model:** Opus 5.5 (controller-run). **Depends on:** Task 20. **Files:** `docs/proofs/wave3b-exit.md`.

- [ ] **Step 1:** Conformance `realtime` green with both clients; `pending.json` holds no realtime method; suites green.
- [ ] **Step 2:** Layered security gate on 3b's diff; one fix wave with regression tests.
- [ ] **Step 3:** Memory and load: idle `core` with the replication connection open; 200 sockets with 5 channels each and 500 changes per second for a minute on a micro-sized stack — memory against D-28, no dropped connection, no WAL retained after disconnect.
- [ ] **Step 4:** `wave3b-exit.md`. Commit `docs: wave 3b exit proof`.

## Sub-wave 3c — Storage

### Task 22: Storage backend interface and streamed uploads

**Model:** Opus 5.5. **High-risk.** **Depends on:** Tasks 2, 4, 6. **Files:** `core/src/storage/{backend.ts,backend-file.ts,finalize.ts,objects.ts,paths.ts,index.ts}`, `core/src/settings/storage.ts`, `core/test/{storage-backend.contract.ts,storage-backend-file.test.ts,storage-stream.test.ts,storage.test.ts}`.

**Interfaces — Produces:**
```ts
// backend.ts
export interface StorageBackend {
  put(key: string, body: ReadableStream<Uint8Array>, opts: { maxBytes: number }): Promise<{ size: number; etag: string }>   // temp name, then atomic rename
  get(key: string, range?: { start: number; end?: number }): Promise<{ body: ReadableStream<Uint8Array>; size: number }>
  head(key: string): Promise<{ size: number; etag: string } | null>
  delete(keys: string[]): Promise<void>
  copy(from: string, to: string): Promise<void>
  move(from: string, to: string): Promise<void>
  // multipart, used by TUS completion and the S3 protocol
  partPut(uploadId: string, part: number, body: ReadableStream<Uint8Array>, opts: { maxBytes: number }): Promise<{ size: number; etag: string }>
  partsCompose(uploadId: string, parts: number[], key: string): Promise<{ size: number; etag: string }>
  partsAbort(uploadId: string): Promise<void>
}
export const backend: StorageBackend            // `file` today; the `s3` implementation is wave 4 (D-18)
```
- A key is `<bucket id>/<object uuid>/<version>`, generated by core, never the object's name: names live only in `storage.objects`, so no client string reaches the filesystem. Objects stored by v1 under their names are read through a fallback that resolves the old path with today's `insideBucket` checks; `shortcut: v1 name-shaped paths are read in place, until a copy job moves them`.
- `finalize.ts`: `export async function finalize(claims: JwtClaims | null, bucket: Bucket, name: string, source: { key: string; size: number; etag: string }, meta: ObjectMeta, opts: { upsert: boolean; owner?: string }): Promise<ObjectRow>` — size and MIME limits, the RLS insert or update as the caller, and deletion of the replaced version; the one path every upload kind ends in (plain, signed, TUS, S3).
- Uploads stream to the backend with a counting limit (`STORAGE_MAX_UPLOAD_BYTES`, bucket `file_size_limit`), multipart form and raw body; memory per upload is bounded by the stream's buffer. The backend refuses symlinks and opens files with no-follow semantics (wave 1 R4).
- `storage-backend.contract.ts`: `export function backendContract(make: () => StorageBackend): void` — the suite every backend must pass.

- [ ] **Step 1:** Tests: the contract on the `file` backend (put/get/range/head/delete/copy/move, a part upload composed in a different order than uploaded, abort leaves nothing, a put cut off mid-stream leaves no object and no temp file, a put one byte over `maxBytes` fails and leaves nothing); a 300 MiB upload on a core with a 256 MiB cap succeeds (compose test with `mem_limit`); an object name `../../etc/passwd`, one with a NUL and one of 2000 characters are stored as rows and never touch a path outside the store; a symlink planted in the storage directory is not followed; a v1-layout object still downloads; the RLS insert failing removes the stored bytes; every existing storage test passes.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5 (security review):** Codex + opus. Attack list (Review Focus 5): traversal through any remaining name-shaped path, temp-file races, orphaned bytes after a failed RLS insert, limit bypass with chunked encoding or a lying `Content-Length`, disk exhaustion through aborted uploads.
- [ ] **Step 6:** Commit `feat: storage backend interface with streamed uploads`.

### Task 23: Full object and bucket API, signed URLs and signed uploads

**Model:** Opus 5.5. **High-risk.** **Depends on:** Task 22. **Files:** `core/src/storage/{routes-bucket.ts,routes-object.ts,routes-sign.ts,list.ts,sign.ts,index.ts}`, `core/test/{storage-api.test.ts,storage-sign.test.ts,storage-list.test.ts}`, `conformance/src/storage/{bucket.test.ts,object.test.ts,sign.test.ts,list.test.ts}`.

**Interfaces — Produces** (routes, status codes and error bodies as upstream *(verify, upstream)*):
- Buckets: create (`public`, `file_size_limit`, `allowed_mime_types`), get, list (limit, offset, sort, search), update, delete (refused when not empty), empty.
- Objects: upload and upsert with `cacheControl`, `contentType`, `metadata`, `x-upsert`; `update`; `move` and `copy` (with a destination bucket; both sides checked under the caller's policies; `copy` honours `copyMetadata`); `info`; `exists` (HEAD); `remove`; `download` with `Range`, conditional headers and the `download` file-name parameter; `list` with `limit`, `offset`, `sortBy`, `search`; list v2 (cursor, `with_delimiter`, prefix, sort) through `0010`'s function; `getPublicUrl` (client side) with `download`.
- Signing: `sign.ts` signs with a key derived from the JWT secret per purpose (`HKDF(secret, 'storage-url')`, `'storage-upload'`), so a signed-URL token is not an API token and not an upload token (Review Focus 2). `createSignedUrl`, `createSignedUrls`, `createSignedUploadUrl` (two hours, `x-upsert` bound into the token), `uploadToSignedUrl`. Tokens signed by v1's scheme stay valid until they expire.

- [ ] **Step 1:** Tests: every `storage.*` and `storage.from().*` method of `surface.md` assigned to this task, with both clients; a signed URL for object A does not open object B, another bucket, or the same name after the object was replaced by another owner where upstream refuses; a signed upload token cannot be used to download, nor twice, nor for another path, nor with upsert when it was not asked for; `copy` from a bucket the caller cannot read and `move` into one the caller cannot write are refused with nothing changed; `allowed_mime_types` and `file_size_limit` hold for every upload route; a bucket id with `/`, `..` or 200 characters is refused; list never returns a row the caller's policy hides; `search` and `sortBy` values cannot change the SQL (a column outside the allowed set is refused).
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5 (security review):** Codex + opus. Attack list: token confusion across purposes, signed-URL replay after delete or policy change, cross-bucket copy and move, list injection, content-type and `Content-Disposition` header injection through names, cache poisoning of public objects.
- [ ] **Step 6:** Commit `feat: full storage object and bucket api with signed urls and signed uploads`.

### Task 24: Resumable uploads (TUS)

**Model:** Opus 5.5. **High-risk.** **Depends on:** Task 23. **Files:** `core/src/storage/{tus.ts,index.ts}`, `core/package.json` (`@tus/server`, `@tus/file-store`), `core/src/server.ts` or `storage/index.ts` `start()` (the hourly prune), `core/test/storage-tus.test.ts`, `conformance/src/storage/resumable.test.ts` (`tus-js-client`, test-only).

**Interfaces — Produces:** `/storage/v1/upload/resumable` (creation, creation-with-upload, HEAD, PATCH, DELETE, expiration) per D-19. Metadata `bucketName`, `objectName`, `contentType`, `cacheControl`, `metadata`; `x-upsert`; authentication by the caller's JWT or API key on **every** request, or by a signed upload token (`x-signature`). At creation the caller's right to insert that object is checked with a dry-run under RLS; at completion `finalize()` runs. An upload belongs to the subject that created it; any other caller gets 404. Chunk size and total size are bounded by the same limits as Task 22. Staging lives in `<storage>/.tus/` and is not reachable through any object route.

- [ ] **Step 1:** Tests: `tus-js-client` uploads 20 MiB in 6 MiB chunks, is interrupted, resumes from the reported offset and the object's bytes are identical; the same with the upload-signed token; a second user's PATCH and HEAD on the first user's upload id → 404; an upload whose owner lost the insert right before completion fails at `finalize` and leaves no object; `objectName` of `../x` and bucket names of other shapes are refused at creation; an upload declared larger than the bucket limit is refused at creation, and one that sends more than it declared is cut off; an upload idle past its expiry is pruned with its staging file; `.tus` is not listable or downloadable as a bucket; core restarted mid-upload resumes.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5 (security review):** Codex + opus. Attack list: upload id guessing or leakage through `Location`, ownership checks on each verb, offset races between two PATCHes, staging disk exhaustion, `Upload-Metadata` parsing, completion replay.
- [ ] **Step 6:** Commit `feat: resumable uploads over tus`.

### Task 25: Image transformations through imgproxy

**Model:** Opus 5.5. **High-risk.** **Depends on:** Task 23 (parallel with 24, 26). **Files:** `core/src/storage/{render.ts,imgproxy.ts,routes-render.ts,index.ts}`, `core/src/settings/storage.ts`, `template/compose.test.yml` (an imgproxy service for tests, the image pinned by digest), `core/test/storage-render.test.ts`, `conformance/src/storage/transform.test.ts`.

**Interfaces — Produces:**
- Routes `/render/image/public/*`, `/render/image/authenticated/*`, `/render/image/sign/*`, and the `transform` option of `download`, `getPublicUrl`, `createSignedUrl(s)` (the transform is bound into the signature). Options `width`, `height`, `resize` (`cover`, `contain`, `fill`), `quality`, `format` (`origin`) with upstream's bounds *(verify, upstream)*; anything else → 400.
- `core` authorises exactly as for the untransformed route, then requests `IMGPROXY_URL` with an imgproxy URL signed with the project's key and salt (from `STORAGE_SECRETS`), whose source is `http://sb-<ref>-core:8080/storage/v1/render/source/<token>`. The source token is signed with `HKDF(secret, 'storage-render')`, names one object version, lives 60 seconds, and the route answers only that object. The response is streamed back with the object's cache headers and imgproxy's content type.
- Settings: `image_transformation_enabled`, size and resolution bounds passed to imgproxy per request. imgproxy unreachable, or the feature off → 503 `image transformations are not available`, and the plain routes are unaffected.
- `imgproxy.ts`: `export function imgproxyUrl(source: string, t: Transform): string` (HMAC-SHA256 over salt + path, key and salt hex).

- [ ] **Step 1:** Tests with a real imgproxy container: a 2000-pixel JPEG rendered at `width=200` is 200 pixels wide and smaller in bytes; a private object renders for its owner and is 400/404 for another user and for `anon`; a signed render URL with a changed `width` is refused; the source route refuses a token for another object, an expired token, a signed-URL token and an API key; a source token cannot be used on `/object/…`; an SVG and a non-image are refused as upstream; `width=100000` → 400; with imgproxy stopped the render route answers 503 within 5 s and `/object/public/…` still serves; the log line of a render carries no token.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5 (security review):** Codex + opus. Attack list (Review Focus 6): making imgproxy fetch any URL other than this project's source route, source-token replay, decompression bombs and resolution limits, signature bypass through option ordering or encoding, response header passthrough, the 60-second window after a delete.
- [ ] **Step 6:** Commit `feat: image transformations through imgproxy`.

### Task 26: S3 protocol — signatures, buckets and objects

**Model:** Opus 5.5. **High-risk.** **Depends on:** Task 23. **Files:** `core/src/storage/s3/{sigv4.ts,auth.ts,router.ts,xml.ts,objects.ts,errors.ts}`, `core/src/storage/index.ts`, `core/src/settings/storage.ts`, `core/test/{s3-sigv4.test.ts,s3-objects.test.ts}`, `core/package.json` (`@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner` as devDependencies).

**Interfaces — Produces:**
- `/storage/v1/s3`, path-style addressing. `sigv4.ts`: `export async function verifySigV4(req: Request, lookup: (accessKeyId: string) => Promise<string | null>, now?: Date): Promise<{ accessKeyId: string; payload: 'signed' | 'unsigned' | 'streaming' }>` — header signatures and presigned query signatures, the canonical request built by our own code from the raw URL and headers, signed-headers list enforced (`host` required), clock skew 15 minutes, presigned `X-Amz-Expires` at most 7 days, payload hash checked for signed payloads, `STREAMING-AWS4-HMAC-SHA256-PAYLOAD` chunk signatures verified chunk by chunk, constant-time comparison, region and service fixed.
- `auth.ts` (D-21): an access key from `STORAGE_SECRETS` → `service_role`; session-token mode → the user's claims, every operation under RLS through the same functions as Task 23.
- Operations: `ListBuckets`, `HeadBucket`, `CreateBucket`, `DeleteBucket`, `GetBucketLocation`, `PutObject`, `GetObject` (range, conditional), `HeadObject`, `DeleteObject`, `DeleteObjects`, `CopyObject`; errors as S3 XML with S3's codes. XML is written and read by a small strict writer/parser of our own that accepts no DTD and no entity declarations. Uploads end in `finalize()`.
- `s3_protocol_enabled` setting.

- [ ] **Step 1:** Tests. `s3-sigv4.test.ts`: the AWS-published SigV4 test vectors that apply to S3; a request signed by the AWS SDK verifies; changing one header, the path's case, the query order, a signed header's whitespace, the date beyond the skew, or the payload each fail; a presigned URL works until its expiry and not after; a chunked upload with one altered chunk fails at that chunk and stores nothing; an unknown access key and a correct key with a wrong secret take the same code path. `s3-objects.test.ts` with `@aws-sdk/client-s3`: each operation above round-trips; with session-token mode a user reads only what the policy allows and `ListBuckets` shows what upstream shows; the object written through S3 is readable through `storage.from().download` and the reverse; an XML body with a DOCTYPE or an entity is refused; `DeleteObjects` with 1001 keys is refused.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5 (security review):** Codex + opus. Attack list (Review Focus 5): canonicalisation differences (double encoding, `+`, empty query values, duplicate headers, `Host` vs the proxy's host), signature reuse across paths, unsigned-payload acceptance, session token of another project, XML entity expansion, bucket and key names as SQL or paths.
- [ ] **Step 6:** Commit `feat: s3 protocol with sigv4 for buckets and objects`.

### Task 27: S3 protocol — listing and multipart upload

**Model:** Opus 5.5. **High-risk.** **Depends on:** Task 26. **Files:** `core/src/storage/s3/{list.ts,multipart.ts,router.ts}`, `core/test/{s3-list.test.ts,s3-multipart.test.ts}`, `conformance/src/storage/s3.test.ts`.

**Interfaces — Produces:** `ListObjectsV2` (prefix, delimiter, `max-keys` up to 1000, continuation token that is an opaque signed cursor, `start-after`, `encoding-type=url`), `ListObjects` v1 if the pinned upstream serves it *(verify, upstream)*; `CreateMultipartUpload`, `UploadPart`, `UploadPartCopy`, `CompleteMultipartUpload`, `AbortMultipartUpload`, `ListParts`, `ListMultipartUploads`, on `storage.s3_multipart_uploads` and `_parts` and the backend's part methods. Part size 5 MiB to 5 GiB except the last, at most 10 000 parts, the total bounded by the bucket's limit at each part and at completion; an upload belongs to the key and the subject that created it; uploads older than 24 hours are aborted by the hourly prune.

- [ ] **Step 1:** Tests with the AWS SDK: a 40 MiB object uploaded with `Upload` from `@aws-sdk/lib-storage` in 8 MiB parts reads back identical; parts completed in a different order than uploaded, a missing part, a wrong ETag and a too-small middle part are refused with S3's codes; abort removes every part file; another access key's `UploadPart` on the upload id → `NoSuchUpload`; a continuation token altered by one character is refused; listing 2500 objects in pages of 1000 returns each exactly once with common prefixes under a delimiter; a session-token user's listing hides rows the policy hides; the total-size limit refuses the part that crosses it; an upload abandoned for 25 hours (clock moved) is pruned.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5 (security review):** Codex + opus. Attack list: upload id ownership, part-count and size exhaustion, cursor tampering, completion XML abuse, a race between complete and abort.
- [ ] **Step 6:** Commit `feat: s3 listing and multipart upload`.

### Task 28: Sub-wave 3c exit

**Model:** Opus 5.5 (controller-run). **Depends on:** Tasks 24, 25, 27. **Files:** `docs/proofs/wave3c-exit.md`.

- [ ] **Step 1:** Conformance `storage` green with both clients; `pending.json` holds no storage method; suites green.
- [ ] **Step 2:** Layered security gate on 3c's diff; one fix wave with regression tests.
- [ ] **Step 3:** Memory and disk on a micro-sized stack: four concurrent 200 MiB uploads (plain, TUS, S3 multipart, signed) and twenty concurrent renders — `core` against D-28, imgproxy against its 384 MiB cap, no temp or staging file left afterwards.
- [ ] **Step 4:** `wave3c-exit.md`. Commit `docs: wave 3c exit proof`.

## Sub-wave 3d — Auth extended

One lane, after 3a's exit: Tasks 29–34 share `core/src/auth/`.

### Task 29: OAuth2/OIDC engine and the provider table

**Model:** Opus 5.5. **High-risk.** **Depends on:** Task 15. **Files:** `core/src/auth/oauth/{engine.ts,providers.ts,state.ts,claims.ts}`, `core/src/auth/routes-oauth.ts`, `core/src/settings/auth.ts`, `core/test/{oauth-engine.test.ts,oauth-providers.test.ts,mock-idp.ts}`, `conformance/src/auth/oauth.test.ts`, `docs/parity/providers.md`.

**Interfaces — Produces:**
```ts
// providers.ts
export type Provider = { id: string; kind: 'oauth2' | 'oidc'; authorizeUrl: string; tokenUrl: string; userinfoUrl?: string; jwksUrl?: string;
  issuer?: string; scopes: string[]; pkce: boolean; baseUrlSetting?: string;      // only for self-hosted kinds (D-22)
  map(profile: Record<string, unknown>, idToken?: Record<string, unknown>): { sub: string; email?: string; email_verified?: boolean; name?: string; avatar_url?: string; raw: object }
  override?: Partial<Hooks> }
export const PROVIDERS: Record<string, Provider>
```
- The table covers spec 8.2's list: apple, azure, bitbucket, discord, facebook, figma, github, gitlab, google, kakao, keycloak, linkedin_oidc, notion, slack_oidc, spotify, twitch, twitter, workos, zoom, fly — endpoints, scopes and claim mapping from the pinned upstream *(verify, upstream)*. Settings per provider: `external_<id>_enabled`, `_client_id`, `_secret` (secret), `_url` where the table allows one, `_additional_client_ids`, `_skip_nonce_check`, `_email_optional`.
- `GET /authorize?provider=&redirect_to=&scopes=&code_challenge=…` and `GET|POST /callback`: `state` is a signed, single-use, 10-minute value (`HKDF(secret, 'oauth-state')`) carrying the provider, the redirect, the PKCE flow id and a nonce; the provider leg uses PKCE when the table says so; the token and userinfo calls go through `outbound()`; the session is returned by implicit fragment or PKCE code (Task 11). Sign-up through a provider respects `disable_signup` as upstream.
- Google moves onto the engine; its v1 settings (`GOOGLE_CLIENT_ID`, …) keep working through the registry's `env` fallback.

- [ ] **Step 1:** Tests against `mock-idp.ts` (an OAuth2 and OIDC server with configurable quirks): the full flow for an `oidc` and an `oauth2` provider through both clients (`signInWithOAuth` with `skipBrowserRedirect`, then the redirects followed by the test); every existing Google test of v1 passes unchanged; a table test asserts for all twenty providers that the authorize URL, scopes and the mapped profile of a recorded sample response match the fixture taken from upstream; a callback with a `state` from another browser session, a replayed `state`, an altered `state`, a `state` for provider A on provider B's callback, and a missing `code` are refused; a provider returning an unverified email does not sign into an existing account with that email; a provider `_url` pointing at `http://169.254.169.254` or a private address is refused by netguard; no client secret appears in a redirect, response or log; a disabled provider → the upstream error.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS. `providers.md` lists per provider: table entry checked against upstream, quirk tested or none, needs the owner's account for a live proof.
- [ ] **Step 5 (security review):** Codex + opus. Attack list (Review Focus 3): state CSRF and fixation, mix-up between providers, redirect allow-list bypass, account takeover through unverified or reassigned emails, token endpoint response injection, SSRF through `_url`, secrets in error pages.
- [ ] **Step 6:** Commit `feat: table-driven oauth and oidc sign-in for all providers`.

### Task 30: Provider quirks, ID-token sign-in and identity linking

**Model:** Opus 5.5. **High-risk.** **Depends on:** Task 29. **Files:** `core/src/auth/oauth/{apple.ts,twitter.ts,idtoken.ts,jwks.ts}`, `core/src/auth/{identities.ts,routes-identity.ts}`, `core/src/settings/auth.ts`, `core/test/{oauth-quirks.test.ts,idtoken.test.ts,identities.test.ts}`, `conformance/src/auth/{idtoken.test.ts,identities.test.ts}`.

**Interfaces — Produces:**
- Overrides: Apple (client secret as an ES256 JWT built from the team id, key id and private key; `form_post` callback; name only on first sign-in), Twitter/X (the protocol the pinned upstream uses *(verify, upstream)*), Azure tenant and issuer validation, any other quirk `providers.md` names.
- `POST /token?grant_type=id_token` `{provider, id_token, access_token?, nonce?, client_id?}`: the token is verified against the provider's JWKS (fetched through `outbound()` from the table's fixed `jwksUrl`, or the issuer's discovery document only for kinds with a settings URL; cached 10 minutes; issuer, audience against the client id and `_additional_client_ids`, expiry, and the nonce's hash). `jwks.ts`: `export async function providerKeys(p: Provider): Promise<JWKSet>`.
- Identities: `GET /user/identities/authorize?provider=` (`linkIdentity`), `DELETE /user/identities/:id` (`unlinkIdentity`, refused for the last identity), identities in the user JSON (`getUserIdentities`). Automatic linking to an existing user by a **verified** email as upstream; manual linking behind `security_manual_linking_enabled`.

- [ ] **Step 1:** Tests: Apple's client secret JWT verifies with the test key and has the right claims; `signInWithIdToken` of both clients with a mock issuer; an ID token with a wrong audience, wrong issuer, expired, wrong nonce, signed by a key not in the JWKS, or with `alg: none` is refused; an ID token whose header names a `jku` or `x5u` is verified only against the table's JWKS; linking adds an identity and unlinking the last one is refused; linking an identity that already belongs to another user is refused; automatic linking happens for a verified email and not for an unverified one; manual linking off → the upstream error.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5 (security review):** Codex + opus. Attack list: JWKS source control, audience confusion between a project's client ids, nonce replay, identity hijack by linking, pre-registration account takeover (attacker signs up an unverified email first).
- [ ] **Step 6:** Commit `feat: provider overrides, id-token sign-in and identity linking`.

### Task 31: MFA — TOTP

**Model:** Opus 5.5. **High-risk.** **Depends on:** Task 30. **Files:** `core/src/auth/mfa/{totp.ts,factors.ts,routes-mfa.ts}`, `core/src/auth/{sessions.ts,routes-admin.ts}`, `core/src/settings/auth.ts`, `core/package.json` (`otpauth`), `core/test/mfa-totp.test.ts`, `conformance/src/auth/mfa.test.ts`.

**Interfaces — Produces:** `POST /factors` (enroll: `factor_type: 'totp'`, `friendly_name`, `issuer` → id, secret, `otpauth://` URI, QR as an SVG data URI), `POST /factors/:id/challenge`, `POST /factors/:id/verify` (→ a new session at `aal2` with the `totp` AMR entry; the other sessions of the user are ended as upstream *(verify, upstream)*), `DELETE /factors/:id` (needs `aal2` when a verified factor exists), factors in the user JSON (`listFactors`), `GET|DELETE /admin/users/:id/factors[/:fid]`. TOTP secrets are stored encrypted with a key derived from the JWT secret (`HKDF(secret, 'mfa-secret')`), never returned after enrollment. Settings `mfa_totp_enroll_enabled`, `mfa_totp_verify_enabled`, `mfa_max_enrolled_factors`; verify attempts limited per factor (Task 10); a code is accepted once (the last used time step is stored). Unverified factors are pruned after upstream's interval.

- [ ] **Step 1:** Tests: enroll, challenge, verify with both clients; `getAuthenticatorAssuranceLevel` reports `aal1` → `aal2`, and `aal2` survives a refresh (Task 8); an RLS policy `(auth.jwt()->>'aal') = 'aal2'` hides a row from the `aal1` session and shows it after verification; the same code twice is refused; a code for factor A on factor B's challenge is refused; a challenge of another user is 404; six wrong codes trip the limit; unenrolling the factor at `aal1` is refused; the admin delete removes it and downgrades nothing silently (existing `aal2` sessions end); `select secret from auth.mfa_factors` does not contain the base32 secret; `mfa_max_enrolled_factors` holds; **race:** unenroll against a concurrent refresh leaves no `aal2` token (Review Focus 1).
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5 (security review):** Codex + opus. Attack list: code replay and window width, challenge binding to factor, user and session, brute force across challenges, AAL downgrade and upgrade without verification, factor enrollment by a stolen `aal1` session when a verified factor exists.
- [ ] **Step 6:** Commit `feat: totp multi-factor authentication with aal2 sessions`.

### Task 32: Phone auth, SMS senders and phone factors

**Model:** Opus 5.5. **High-risk.** **Depends on:** Task 31. **Files:** `core/src/auth/sms/{index.ts,twilio.ts,twilio-verify.ts,messagebird.ts,vonage.ts,textlocal.ts,hook.ts}`, `core/src/auth/{routes-phone.ts,mfa/phone.ts,mfa/routes-mfa.ts}`, `core/src/settings/auth.ts`, `core/test/{phone.test.ts,sms-senders.test.ts,mfa-phone.test.ts}`, `conformance/src/auth/phone.test.ts`.

**Interfaces — Produces:**
- `export interface SmsSender { send(to: string, message: string, channel: 'sms' | 'whatsapp', otp: string): Promise<{ messageId?: string }>; verify?(to: string, code: string): Promise<boolean> }` with five senders whose endpoints are constants and whose credentials come from `AUTH_SECRETS` (`sms_twilio_*`, `sms_twilio_verify_*`, `sms_messagebird_*`, `sms_vonage_*`, `sms_textlocal_*`), plus v1's hook sender. Twilio Verify delegates code generation and checking to the vendor.
- Sign-up and sign-in with phone + password, `POST /otp` with `phone` (`channel`), `POST /verify` types `sms`, `phone_change`; `sms_autoconfirm`, `sms_otp_exp`, `sms_otp_length`, `sms_max_frequency`, `sms_template`, `sms_test_otp` (number → fixed code, with `sms_test_otp_valid_until`); phone numbers normalised to E.164.
- Phone MFA factors (`factor_type: 'phone'`): enroll, challenge (sends a code), verify; settings `mfa_phone_enroll_enabled`, `mfa_phone_verify_enabled`, `mfa_phone_otp_length`, `mfa_phone_template`, `mfa_phone_max_frequency`.
- v1's `phone_change` flow through the hook keeps working unchanged (CorteQS uses it).

- [ ] **Step 1:** Tests: phone sign-up and `verifyOtp({type:'sms'})` with both clients using `sms_test_otp`; each sender, through `setOutbound`, sends the request shape recorded from the vendor's public documentation (method, URL, auth header form, body fields) and maps a vendor error to the upstream error; no sender's host can be changed by a setting; the per-number frequency limit and Task 10's SMS limit both hold; a code for number A does not verify number B; `sms_test_otp` stops working after `valid_until`; the CorteQS `updateUser({phone})` + `verifyOtp({type:'phone_change'})` test of v1 passes untouched; a phone factor reaches `aal2`; credentials appear in no response or log.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5 (security review):** Codex + opus. Attack list: SMS pumping (cost abuse) through every sending route, number normalisation collisions, OTP brute force, test-OTP left enabled, template injection into the message, vendor error bodies echoed to the client.
- [ ] **Step 6:** Commit `feat: phone sign-in, sms senders and phone factors`.

### Task 33: Auth hooks

**Model:** Opus 5.5. **High-risk.** **Depends on:** Task 32. **Files:** `core/src/auth/hooks/{index.ts,pg.ts,http.ts}`, call sites in `core/src/auth/{claims.ts,mail.ts,sms/index.ts,mfa/*.ts,routes-core.ts}`, `core/src/settings/auth.ts`, `core/test/{hooks-pg.test.ts,hooks-http.test.ts}`.

**Interfaces — Produces:** six hooks — `custom_access_token`, `send_email`, `send_sms`, `mfa_verification_attempt`, `password_verification_attempt`, `before_user_created` — each with settings `hook_<name>_enabled`, `hook_<name>_uri`, `hook_<name>_secrets` (secret). `export async function runHook<I, O>(name: HookName, input: I): Promise<O | null>`:
- `pg-functions://postgres/<schema>/<function>`: called as `supabase_auth_admin` (D-23) with one `jsonb` argument, statement timeout 2 s, in its own transaction; schema and function are identifiers checked against the catalog, never interpolated raw.
- `https://…`: POST with the Standard Webhooks headers, 5 s timeout, through `outbound()`, up to three attempts as upstream *(verify, upstream)*; the response is size-limited (20 KiB).
- Input and output shapes per hook as upstream. `custom_access_token` output is validated: required claims present, `role`, `aal`, `session_id`, `sub`, `exp` cannot be removed, and the result must still verify as a token of this project. A hook error fails the operation with upstream's error; `send_email` / `send_sms` hooks replace the built-in sender.

- [ ] **Step 1:** Tests: each hook as a Postgres function and as an HTTPS stub receives the documented input and its output takes effect (a claim added, a sign-up rejected with the hook's message, an MFA attempt rejected, a mail delivered by the hook and not by SMTP); a function the role cannot execute fails closed with the upstream error; a hook that sleeps 5 s times out; a `custom_access_token` hook that removes `sub`, sets `role` to `service_role` or returns 1 MiB is refused; an HTTPS hook URL resolving to a private address is refused; the webhook signature verifies with the Standard Webhooks reference check and a replayed timestamp is the receiver's concern, documented; the hook secret appears nowhere; the URI `pg-functions://postgres/public/x"; drop table y; --` is refused at startup.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5 (security review):** Codex + opus. Attack list (Review Focus 3): claims escalation through the token hook, SQL injection through the URI, SSRF and DNS rebinding on HTTPS hooks, hook failure modes that fail open, payloads carrying secrets (password hook must not receive the password).
- [ ] **Step 6:** Commit `feat: auth hooks as postgres functions or signed https calls`.

### Task 34: SSO with SAML 2.0

**Model:** Opus 5.5. **High-risk.** **Depends on:** Task 33. **Files:** `core/src/auth/sso/{saml.ts,providers.ts,metadata.ts,routes-sso.ts,routes-admin-sso.ts}`, `core/src/settings/auth.ts`, `core/package.json` (`@node-saml/node-saml`), `core/test/{saml.test.ts,sso-admin.test.ts,fixtures/saml/**}`, `conformance/src/auth/sso.test.ts`.

**Interfaces — Produces:**
- `saml_enabled`; the SP signing key in `AUTH_SECRETS` (`saml_private_key`), generated by control in Task 37, by `scripts/gen-keys` for plain compose.
- `GET /sso/saml/metadata` (SP metadata, `?download=true`), `POST /sso/saml/acs`, `POST /sso` (`signInWithSSO`: `provider_id` or `domain`, `redirect_to`, `skip_http_redirect`, PKCE) → the IdP redirect with a relay state stored in `auth.saml_relay_states` (single use, 10 minutes).
- Admin (service role): `GET|POST /admin/sso/providers`, `GET|PUT|DELETE /admin/sso/providers/:id` with `metadata_xml` or `metadata_url` (fetched through `outbound()`, size-limited, re-fetched on upstream's schedule), `domains`, `attribute_mapping`.
- Assertion handling by `@node-saml/node-saml` only (AC-19): signature required on the assertion or the response, audience = our entity id, destination and recipient = our ACS URL, `InResponseTo` = the stored request id, `NotBefore` / `NotOnOrAfter` with 60 s skew, one-time use of assertion ids within their validity. Users created by SSO are `is_sso_user` and are never linked to a non-SSO account by email, as upstream.

- [ ] **Step 1:** Tests with fixture IdP keys and assertions built in the test: a valid response signs the user in through both clients (the redirect followed by the test) with attributes mapped; an unsigned response, a signature over the wrong element (wrapping), a response for another audience or destination, an expired or not-yet-valid assertion, a replayed assertion id, a response without a matching relay state, and one signed by another provider's key are each refused; IdP-initiated responses follow upstream's rule *(verify, upstream)*; metadata XML with a DOCTYPE or entity is refused; a `metadata_url` to a private address is refused; a domain claimed by one provider cannot be added to another; an SSO user with the email of an existing password user stays a separate user; provider CRUD with the anon key → 401.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5 (security review):** Codex + opus. Attack list (Review Focus 2, 3): XML signature wrapping, comment injection in `NameID`, XXE, replay, relay-state open redirect, cross-provider confusion, account merging by email, metadata refresh as SSRF.
- [ ] **Step 6:** Commit `feat: sso with saml 2.0`.

### Task 51: Third-party auth — tokens from external issuers

**Model:** Opus 5.5. **High-risk.** **Depends on:** Task 34. **Files:** `core/src/auth/thirdparty/{issuers.ts,verify.ts}`, `core/src/gateway/{index.ts,apikey.ts}`, `core/src/jwt.ts` (the `auth()` middleware), `core/src/settings/auth.ts`, `core/test/{thirdparty.test.ts,gateway.test.ts}`, `conformance/src/auth/thirdparty.test.ts`.

**Interfaces — Produces (D-30):**
- Setting `third_party_issuers`: `[{ id, type, oidc_issuer_url?, jwks_url?, custom_jwks? }]` with upstream's kinds *(verify, upstream)*; at most ten; flagged `outbound: true` in the registry.
- `export async function verifyThirdParty(token: string): Promise<JwtClaims | null>` — only for a token whose `iss` equals a configured issuer exactly: keys from that issuer's discovery document or JWKS URL through `outbound()` (netguard, 5 s, 1 MiB, cached 10 minutes, refetched once on an unknown `kid`), asymmetric algorithms only, `exp` required, and the `role` claim rule of upstream *(verify, upstream)*. A token of the project's own keys never takes this path, and a third-party token is never accepted as an API key.
- The gateway exchanges a verified third-party token for a 60-second project-signed token carrying the same claims before forwarding to PostgREST and `fn`; storage and realtime accept the verified claims directly; realtime re-checks at every `access_token` event. `/auth/v1` user routes (`getUser`, `updateUser`, MFA) answer upstream's error for such a token, since there is no `auth.users` row.

- [ ] **Step 1:** Tests against the mock issuer of Task 29: `createClient(url, key, { accessToken })` of both clients reads a table under a policy on `auth.jwt()->>'sub'`, uploads to storage and joins a private channel; a token with an unconfigured `iss`, a wrong signature, `alg: HS256` signed with the issuer's public key, `alg: none`, no `exp`, or a missing `role` where upstream requires it is refused; an issuer whose JWKS URL resolves to a private address is refused; a `role: service_role` claim follows upstream's rule and never yields more than it does there; a key rotation at the issuer is picked up after one refetch and not by a refetch per request (the stub counts calls); PostgREST receives a project-signed token and never the external one; the project's own tokens are unaffected with the feature on and off.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5 (security review):** Codex + opus. Attack list (Review Focus 2, 3): issuer confusion (prefix or case matches, two issuers sharing keys), role escalation through external claims, JWKS source control and refetch as a denial of service, exchanged-token lifetime, an external token on admin routes.
- [ ] **Step 6:** Commit `feat: third-party auth with external token issuers`.

### Task 52: Dashboard MFA in control (TOTP enrol, verify, recovery)

**Model:** Opus 5.5. **High-risk.** **Depends on:** Task 31 (parallel with 32–34, 51). **Files:** `control/src/{mfa.ts,core.ts}`, `control/src/routes/{platform-mfa.ts,platform-auth.ts}`, `control/src/{app.ts,session.ts}` (one line each, file-ownership map), `control/test/{mfa.test.ts,session.test.ts,leak.test.ts}`.

**Interfaces — Produces (D-31):**
- `control/src/core.ts` also exports core's MFA functions (enroll, challenge, verify, unenroll) from `selfbase-core/src/auth/mfa/factors.ts`; control calls them in-process against control-db, where `0009` already created the tables.
- Routes (session cookie): `GET /platform/auth/mfa/factors`, `POST /platform/auth/mfa/factors` (enroll → secret and `otpauth://` URI, once), `POST …/factors/:id/verify` `{code}` (completes enrolment, or raises the current session to `aal2`), `DELETE …/factors/:id` (needs `aal2` and the current password).
- Session rule in `session.ts`: a user with a verified factor whose session is `aal1` may call only the MFA verify route, `GET /platform/me` (which reports `mfa_required: true`) and logout; everything else under `/platform` answers 403 `mfa_required`. A user without a factor is unaffected. Personal access tokens are unaffected. A password reset through the recovery mail does not remove the factor.
- Recovery: `export async function resetMfa(db: Db, email: string, actor: string): Promise<number>` — deletes the user's factors, ends all of that user's sessions, writes an audit row; returns the number removed. The command that calls it is Task 53's.
- Verify attempts are rate limited per factor and per IP with control's limiter; a code is accepted once.

- [ ] **Step 1:** Tests (real control-db): enrol and verify, then a fresh password sign-in gets 403 `mfa_required` on `/platform/projects` and 200 after verifying; the cookie of the `aal1` session cannot read a project, forward an admin call or create an access token; an existing `sbp_` token still works; a used code is refused the second time and six wrong codes trip the limit; removing the factor at `aal1` or without the password is refused; `resetMfa` removes the factors, signs the user out everywhere and leaves an audit row naming the actor; the enrolment secret appears in exactly one response and in no audit row, job row or log line; a session raised to `aal2` stays `aal2` across a refresh (Task 8) and a recovery-mail session is `aal1`; with no factor enrolled every existing control test passes untouched.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** control and core suites PASS.
- [ ] **Step 5 (security review):** Codex + opus. Attack list (Review Focus 1): a `/platform` or `/v1` path the assurance check misses (path variants, the admin forward, websockets if any), enrolment by a stolen `aal1` session when a factor exists, password reset as an MFA bypass, the invite and accept-invitation flows, races between `resetMfa` and a refresh.
- [ ] **Step 6:** Commit `feat: totp for dashboard logins with an operator reset`.

### Task 35: Sub-wave 3d exit

**Model:** Opus 5.5 (controller-run). **Depends on:** Tasks 51, 52. **Files:** `docs/proofs/wave3d-exit.md`, `conformance/src/idp/{keycloak.test.ts,realm.json}`, `.github/workflows/conformance.yml` (a job with a Keycloak service container).

- [ ] **Step 1:** Keycloak proof (CI job only, image pinned by digest): the `keycloak` OIDC provider and one SAML provider configured from `realm.json` complete a real browser-less sign-in each (the test drives Keycloak's login form over HTTP). No account outside the test container is involved.
- [ ] **Step 2:** Conformance `auth` complete with both clients; `pending.json` holds no auth method; `docs/parity/providers.md` final; the control suite with Task 52's dashboard MFA green.
- [ ] **Step 3:** Layered security gate on 3d's diff; one fix wave with regression tests.
- [ ] **Step 4:** Memory of `core` idle with every auth feature enabled (D-28). `wave3d-exit.md`. Commit `docs: wave 3d exit proof`.

## Sub-wave 3e — Platform integration and Studio

Starts at R2. From here wave 3 edits the files wave 2 owned.

### Task 36: R2 integration

**Model:** Opus 5.5. **High-risk.** **Depends on:** R2, Tasks 21, 28, 35. **Files:** `db/platform/0012-realtime-drop-v1-triggers.sql`, `core/src/admin/migrations.ts` (wave 2's re-arm removed), `template/{compose.yml,.env.example,compose.build.yml}` (`rest`, `fn`), `fn/{main.ts,config.ts}`, `fn/test/main.test.ts`, `job/restore.sh`, `job/test/job.test.sh`, `scripts/test/{workspace.test.mjs,template.test.mjs}`, root `package.json`, `.github/workflows/{ci.yml,conformance.yml}` (the latter folded in and deleted), `core/test/{platform.test.ts,migrations.test.ts}`, `docs/proofs/wave3-r2.md`.

- [ ] **Step 1:** Merge `v2` into `v2-wave3`. Resolve per the file-ownership map; record in `wave3-r2.md` every conflicted file and which rule settled it, wave 2's final platform and control migration numbers, and the provisioner's line count. Task 38's control migration numbers (`0010`, `0011`, D-4) are confirmed against the merged tree here; if wave 2 ended on another number, this step says which two follow it. All suites of both waves green before any further step.
- [ ] **Step 2 (tests first):** `0012` drops every `selfbase_realtime` trigger, `selfbase.enable_realtime` and the v1 notify function, twice without error, on a database that has user tables with the trigger and on control-db's shape; after it a wave 2 migration apply (`PUT /admin/migrations/:version`) adding a table to `supabase_realtime` succeeds and that table's changes reach a subscriber; `rest` started with a JWKS in `PGRST_JWT_SECRET` accepts HS256 and ES256 tokens (template default: the plain secret, so plain compose is unchanged); `fn` with `verify_jwt` accepts an ES256 user token and the gateway's exchanged token, and still refuses a token signed by another key; a rotating restore of a backup holding sessions, factors, flow states, relay states, one-time tokens and rate-limit rows ends with all of them empty and its count check passing (D-26); the workspace test counts eight.
- [ ] **Step 3:** FAIL. **Step 4:** Implement. **Step 5:** every suite, wave 1's and wave 2's e2e and the conformance run PASS in `ci.yml`.
- [ ] **Step 6 (security review):** Codex + opus on this task's diff and on the merge resolution. Attack list (Review Focus 8): a credential table missed by the restore list, `fn` accepting a token `core` would refuse, a `rest` JWKS that contains private material, wave 2 routes that now bypass the new session check.
- [ ] **Step 7:** Commit `feat: wave 2 and wave 3 integrated; v1 realtime triggers dropped`.

### Task 37: Control — configuration delivery and the config API

**Model:** Opus 5.5. **High-risk.** **Depends on:** Task 36. **Files:** `control/src/{project-env.ts,project-secrets.ts,secrets.ts,settings.ts}`, `control/src/routes/project-config.ts`, `control/src/{forward.ts,audit.ts}`, `control/src/routes/platform-transfer.ts`, `control/src/{envfile.ts,manifest.ts}`, `control/test/{project-env.test.ts,project-config.test.ts,leak.test.ts,openapi.test.ts,transfer.test.ts}`.

**Interfaces — Produces:**
- `control/src/settings.ts` imports core's registry (`selfbase-core/src/settings/registry.ts`). `buildEnv` emits `AUTH_CONFIG`, `REALTIME_CONFIG`, `STORAGE_CONFIG` from `project_config` sections `auth`, `realtime`, `storage`, and `AUTH_SECRETS`, `STORAGE_SECRETS` from `project_secrets` rows named `auth:<key>` / `storage:<key>`. v1-named values already stored (wave 1 imports, wave 2's Task 13 writes) keep working: they are emitted as their own variables and the registry's `env` fallback reads them; a write through the new API moves that setting into the section JSON and deletes the old key in the same transaction. Total `AUTH_CONFIG` above 96 KiB → 400 `config_too_large`.
- `ensureSecrets` backfill gains what a project needs generated: the SAML SP key, the imgproxy key and salt.
- `GET|PATCH /v1/projects/:ref/config/auth` (`v1-get-auth-service-config`, `v1-update-auth-service-config`): every field of the response schema that the registry maps (`api`), others `null`; a PATCH of an unmapped field → 400 `not_supported` (wave 2 D-7's rule, now with a short list recorded in `docs/parity/exclusions.md`); secret fields write-only and read as `null`. `GET|PATCH /v1/projects/:ref/config/realtime` (`v1-get-realtime-config`, `v1-update-realtime-config`), `POST …/config/realtime/shutdown` (`v1-shutdown-realtime`: recreates `core`). `config/storage`: `features.imageTransformation`, `features.s3Protocol`, `fileSizeLimit`. Each write validates with the registry, then `setConfig` + one `project.apply` recreating `core` (wave 2's `project_busy` rule).
- Export and import: the new secrets travel in the manifest under the passphrase like the existing ones; every setting whose registry entry is an outbound URL is stripped on import (`envfile.ts` default-strip, extended by registry flag `outbound: true`), and the import report names what was stripped.

- [ ] **Step 1:** Tests: a PATCH of `external_github_enabled`, `external_github_client_id`, `external_github_secret` stores the first two in config and the third encrypted, the fake provisioner's next `ensure` carries them in `AUTH_CONFIG` / `AUTH_SECRETS`, and GET returns the secret as `null`; the leak sweep (wave 1's, extended to every secret-marked registry key) finds no secret value in any response, `audit_log`, `jobs`, `job_events` or log line after writes, a failed write and a failed apply; a v1-named `SMTP_HOST` written by wave 2's route is still delivered, and a PATCH of `smtp_host` moves it; a 100 KiB template → 400 and nothing stored; an import of a manifest with `external_keycloak_url`, `hook_send_email_uri` and `smtp_host` creates the project without them and lists the three names; `openapi.test.ts` covers the new routes; a read-only member → 403 on every PATCH; `SMTP_PORT` set through the API reaches core (the owner's background case).
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** control suite PASS.
- [ ] **Step 5 (security review):** Codex + opus. Attack list (Review Focus 7, 8): secret echo on any path including validation errors, config keys that shadow secrets, prototype keys in section JSON, oversized or deeply nested config, an import that keeps an endpoint, a member role reaching provider secrets.
- [ ] **Step 6:** Commit `feat: control delivers auth, realtime and storage configuration and serves the config api`.

### Task 38: Control — signing keys, API keys, S3 keys, SSO providers

**Model:** Opus 5.5. **High-risk.** **Depends on:** Task 37. **Files:** `control/migrations/0010-signing-and-api-keys.sql`, `control/migrations/0011-storage-s3-keys.sql`, `control/src/{signing-keys.ts,api-keys.ts}`, `control/src/routes/{keys.ts,sso.ts,v1.ts}`, `control/src/{project-env.ts,forward.ts,audit.ts}`, `control/src/routes/platform-transfer.ts`, `control/test/{signing-keys.test.ts,api-keys.test.ts,s3-keys.test.ts,sso.test.ts,openapi.test.ts,leak.test.ts}`.

**Interfaces — Produces:**
- Signing keys (`v1-get-project-signing-keys`, `v1-create-project-signing-key`, `v1-get-project-signing-key`, `v1-update-project-signing-key`, `v1-remove-project-signing-key`, and the two `…/legacy` operations): a table `control.signing_keys (project_id, id, algorithm, status, public_jwk, created_at, updated_at)` with the private JWK in `project_secrets` (`jwt:<id>`). Statuses and transitions as upstream (`standby` → `in_use` → `previously_used` → `revoked`), exactly one `in_use`. `buildEnv` emits `JWT_KEYS` for `core`, the verification JWKS for `rest` and the public JWKS for `fn`; a status change is one `project.apply` recreating the three. The legacy HS256 secret is key zero and cannot be removed while a legacy API key is active.
- API keys (`v1-get-project-api-keys`, `v1-create-project-api-key`, `v1-get-project-api-key`, `v1-update-project-api-key`, `v1-delete-project-api-key`, `v1-get-project-legacy-api-keys`, `v1-update-project-legacy-api-keys`): `sb_publishable_…` / `sb_secret_…` in upstream's format *(verify, upstream)*, hash and prefix in `control.api_keys`, the value shown once at creation (and on `?reveal=true` for secret keys only if upstream allows it; otherwise never again). `buildEnv` emits `API_KEYS`. Disabling the legacy keys makes `core` refuse them.
- S3 access keys: `GET|POST /platform/projects/:ref/storage/s3-keys`, `DELETE …/:id` (`project.keys`); the secret shown once; delivered in `STORAGE_SECRETS`.
- Third-party auth (D-30): `v1-list-project-tpa-integrations`, `v1-create-project-tpa-integration`, `v1-get-project-tpa-integration`, `v1-delete-project-tpa-integration` store the issuers in config section `auth` (key `third_party_issuers`, validated by the registry) and apply; the issuer URL is checked by netguard's rule at write time and again by core at fetch time, and is stripped on import like every outbound setting.
- SSO providers: the five `…/config/auth/sso/providers` operations forward to core's admin SSO routes with the service role, shapes per the OpenAPI snapshot.
- Import: a manifest's signing keys follow wave 1's JWT rule (fingerprint refusal when a live project holds the same key, `rotate_keys` generates fresh ones); API-key hashes and S3 keys are never carried into a rotated import.

- [ ] **Step 1:** Tests: create an ES256 key (standby), promote it, and the next `ensure` carries it `in_use` with HS256 `previously_used` in all three services' env; two `in_use` keys cannot exist (concurrent promote); revoking the `in_use` key is refused; a private JWK is in no response, audit row, job payload or log; creating a secret API key returns the value once and the stored row holds only a hash; a deleted key is absent from the next `API_KEYS`; legacy keys disabled → the fake core env says so; S3 key create/list/delete with the secret shown once; a third-party issuer created through the route appears in the next `AUTH_CONFIG`, one with a private-address URL is refused, and an import drops it and names it; SSO CRUD reaches the stub core and a developer without `project.manage` gets 403; an import of an export whose signing key is in use by a live project is refused with `keys_in_use`, and with `rotate_keys` the project gets new keys and no API or S3 key of the source; `openapi.test.ts` covers every operation named above.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** control suite PASS.
- [ ] **Step 5 (security review):** Codex + opus. Attack list (Review Focus 2, 7, 8): private key exposure, key-status races, a revoked key still delivered, API-key hash comparison and enumeration by prefix, cross-project key ids in routes, shared keys after import.
- [ ] **Step 6:** Commit `feat: signing keys, api keys, s3 keys and sso providers through the management api`.

### Task 39: Shared imgproxy in the control stack

**Model:** Opus 5.5. **High-risk.** **Depends on:** Task 38 (parallel with 40). **Files:** `control/compose.yml`, `control/.env.example`, `provisioner/src/{ops.ts,settings.ts,spec.ts}`, `provisioner/test/{ops.test.ts,refusal.test.ts}`, `control/src/{project-env.ts,admission.ts,imgproxy.ts}`, `core/src/admin/auth.ts` (peer check), `core/test/admin-peer.test.ts`, `control/test/{project-env.test.ts,admission.test.ts}`, `docs/reviews/wave3-imgproxy-security.md`, `docs/network-isolation.md`.

**Interfaces — Produces (D-20):**
- `selfbase-imgproxy` in `control/compose.yml`: image pinned by digest, `mem_limit: 384m`, no published port, no Traefik label, read-only root, `IMGPROXY_ALLOWED_SOURCES` set to the render-source shape, local filesystem and cloud sources off, `IMGPROXY_MAX_SRC_RESOLUTION`, `IMGPROXY_WORKERS`, download timeout 10 s, signature required. Its keys come from a file control writes on a shared volume when projects change, then imgproxy is restarted through the provisioner — or one shared pair when Task 1 found imgproxy cannot hold a pair per project (D-20's fallback, stated in the review document).
- Provisioner: `NodeSettings += { imgproxyContainer: string | null }`; `ensure` connects that container to `sb-<ref>-ctl` at the fixed address `base+20` and disconnects it on remove, exactly as it does the control container; nothing else. Line count stated; cap per D-27.
- `buildEnv` sets `IMGPROXY_URL=http://selfbase-imgproxy:8080` and the project's key and salt in `STORAGE_SECRETS`. Admission counts imgproxy's cap in the shared stack.
- Core's admin port refuses the imgproxy address (the peer check allows control's address only).
- `docs/reviews/wave3-imgproxy-security.md`: what a tenant, a compromised `core` and a compromised imgproxy can each reach, with the test that pins each bound.

- [ ] **Step 1:** Tests (real Docker): after `ensure`, imgproxy is on the project's `-ctl` network and on no tenant network; `fn`, `rest`, `db` and `pooler` of the project cannot open a connection to it; from imgproxy, `core:8081` answers 403 and another project's `sb-<other>-core:8080/storage/v1/render/source/x` is refused by the allowed-source rule when requested with the first project's key (or, with one shared pair, is refused by the other project's source-token check); an imgproxy URL with source `http://169.254.169.254/`, `local:///etc/passwd` or `http://selfbase-control:8080/` is refused; removing the project disconnects imgproxy; with imgproxy stopped, project create and every non-render route still work; the wave 1 and wave 2 refusal tests hold.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** provisioner, control, core and e2e PASS; line count in the commit body.
- [ ] **Step 5 (security review):** Codex + opus (Review Focus 6), on the diff and the review document: cross-project fetch, name hijack of `sb-<ref>-core` or `selfbase-imgproxy` from a shared network (wave 1 C1), imgproxy as an SSRF relay, the key file's permissions, restart storms.
- [ ] **Step 6:** Commit `feat: shared imgproxy on each project's control network`.

### Task 40: Core admin API and control forwards for the Studio screens

**Model:** Opus 5.5. **High-risk.** **Depends on:** Task 38 (parallel with 39). **Files:** `core/src/admin/{auth-admin.ts,storage-admin.ts,realtime-admin.ts,index.ts,users.ts,files.ts}`, `control/src/forward.ts`, `control/src/routes/platform-projects.ts`, `core/test/{admin-auth.test.ts,admin-storage.test.ts,admin-realtime.test.ts}`, `control/test/forward.test.ts`.

**Interfaces — Produces (on `adminApp`):**

| Route | Result / body | Control action |
|---|---|---|
| `GET /admin/users/:id`, `PATCH`, `POST /admin/users`, `POST /admin/users/:id/{ban,unban,logout,recovery-link}` | the Task 14 operations for Studio; a recovery link is returned once | `project.write`; the link → `project.keys`, audited |
| `GET /admin/users/:id/{sessions,factors,identities}`, `DELETE …/sessions/:sid`, `DELETE …/factors/:fid` | rows without secrets | read / `project.write` |
| `GET /admin/auth/audit?limit=&before=&action=&actor=` | `auth.audit_log_entries`, newest first, at most 200 | read |
| `POST /admin/auth/templates/preview` | `{type, subject, content}` → rendered HTML with sample values | `project.manage` |
| `POST /admin/auth/smtp-test` | `{to}` → sends one test mail with the stored SMTP settings; the SMTP error class, never the password | `project.manage` |
| `GET /admin/auth/hooks/functions` | functions `supabase_auth_admin` may execute, for the hook picker | read |
| `GET|POST|PATCH|DELETE /admin/buckets[/:id]`, `POST /admin/buckets/:id/empty` | bucket settings (public, size limit, MIME list) | `project.write` |
| `GET /admin/files/:bucket?prefix=&cursor=`, `POST /admin/files/:bucket/{move,copy,sign}`, `DELETE` | object operations as the operator (service role), signed URL with a chosen expiry | `project.write` |
| `GET /admin/realtime/stats` | connections, channels, events per second, replication state | read |
| `POST /admin/realtime/token` | `{role, sub?}` → a 10-minute token (D-25) | `project.keys`, audited |

- [ ] **Step 1:** Tests: each route returns its shape and no secret column (`encrypted_password`, factor secret, token hashes); the realtime token verifies, expires in 10 minutes, carries the asked role and nothing else, and is refused for roles outside the three; `forward.test.ts`: a read-only member reads the audit log and sessions and cannot ban, mint a token, send the SMTP test or get a recovery link; the audit rows for token minting and recovery links name the user id and never the token or link; the SMTP test with a host resolving to a private address is refused by netguard and says so without echoing settings.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** core and control PASS.
- [ ] **Step 5 (security review):** Codex + opus. Attack list: minted-token scope and lifetime, role checks per forward path including path variants, recovery-link exposure, SMTP test as a port scanner, template preview as an HTML injection into Studio's origin.
- [ ] **Step 6:** Commit `feat: admin api for the auth, storage and realtime screens`.

### Task 41: Studio — Auth I: users, providers, SMTP and templates, URL configuration

**Model:** Opus 5.5. **Depends on:** Tasks 39, 40. **Files:** `studio/src/api.ts`, `studio/src/project/{index.tsx,Auth.tsx,Users.tsx}`, `studio/src/project/auth/{Users,UserDrawer,Providers,Smtp,Templates,UrlConfig}.tsx`, `studio/src/i18n/{en.ts,tr.ts}`, `studio/src/styles.css`, `studio/e2e/{auth-users.spec.ts,auth-providers.spec.ts,auth-email.spec.ts,fixtures/auth-*.json}`, `docs/screens/v2/auth-*.png`.

**Interfaces — Consumes:** wave 2's `Tabs`, `useSubPath`, the longest-path screen match. **Produces:**
- The `auth/users` screen entry becomes `auth` with tabs (users, providers, email, url, and Task 42's). `api.ts`: `platform.authConfig(ref)`, `platform.setAuthConfig(ref, patch)`, `projectAdmin(ref).user(id)`, `.userSessions(id)`, `.userFactors(id)`, `.banUser(id, on)`, `.signOutUser(id)`, `.recoveryLink(id)`, `.createUser(body)`, `.previewTemplate(body)`, `.smtpTest(to)`.
- Users: the list gains search and provider and state filters; a drawer with identities, sessions (end one, end all), factors (remove), ban and unban, a one-time recovery link (`project.keys`), delete. Create user (email, password, auto-confirm).
- Providers: email, phone, anonymous and the twenty OAuth providers as rows with state **Not connected / Connected / Disabled**. A row opens a form: enable, client id, secret (write-only; shows "stored" when set), the fields that provider's registry entries define, and the callback URL to copy. A provider that needs a third-party account says so and links the REHBER section; nothing here creates one (owner).
- Email: SMTP host, port, user, sender address, password (write-only), minimum interval; "send test mail"; a template editor per mail type (subject, HTML body, variable list, preview through the admin route, reset to default).
- URL configuration: site URL and the redirect allow list (add, remove, wildcard rules explained).
- Every write goes through `PATCH config/auth`, shows that the auth service restarts for a few seconds, and batches the form's fields into one apply (spec risk table).
- Catalogue keys under `nav.auth`, `auth.*`.

- [ ] **Step 1:** Playwright: the users drawer shows fixture sessions and ending one sends the DELETE; ban asks for confirmation; the recovery link button is absent without `project.keys`; saving the GitHub provider sends one PATCH with the three fields, then the secret input is empty and the page contains "stored" and not the secret; the Google row of a project with a v1 client id shows Connected; SMTP save sends `smtp_host`, `smtp_port`, `smtp_user`, `smtp_admin_email`, `smtp_pass` in one PATCH and the test-mail button shows the server's error class on failure; the template preview renders in a sandboxed frame; a 100 KiB template shows the server's `config_too_large` message; a read-only member sees every form disabled; `tr` locale shows no English key text; `en.ts` and `tr.ts` key sets match; axe finds no violation on the providers tab.
- [ ] **Step 2:** FAIL. **Step 3:** Implement; run the `turkce-dogal` skill over the new `tr.ts` entries and apply its corrections. **Step 4:** PASS; `npm run build` in `studio`; screenshots (dark and light).
- [ ] **Step 5:** Commit `feat: Studio auth users, providers, email and url configuration`.

### Task 42: Studio — Auth II: sessions, rate limits, hooks, MFA, SSO, sign-in security, audit log

**Model:** Opus 5.5. **Depends on:** Task 41. **Files:** `studio/src/project/auth/{Sessions,RateLimits,Hooks,Mfa,Sso,Security,AuditLog}.tsx`, `studio/src/project/Auth.tsx`, `studio/src/api.ts`, `studio/src/i18n/{en.ts,tr.ts}`, `studio/e2e/{auth-settings.spec.ts,auth-sso.spec.ts,fixtures/auth2-*.json}`, `docs/screens/v2/auth2-*.png`.

**Interfaces — Produces:** tabs sessions (timebox, inactivity timeout, single session, refresh reuse interval, token lifetime), rate limits (each bucket with its unit and default), hooks (six rows: off / Postgres function chosen from the admin picker / HTTPS URL with a write-only secret and a generate button), MFA (TOTP and phone enroll and verify switches, maximum factors), SSO (SAML on/off, SP metadata URL and download, provider list with create from metadata URL or XML, domains, attribute mapping, delete), third-party auth (issuer list, add by issuer URL or JWKS URL, remove; D-30), security (password length and required characters, leaked-password check, CAPTCHA provider with write-only secret, anonymous sign-ins, manual linking), audit log (filter by action and actor, paging). `api.ts`: `platform.ssoProviders(ref)` and its CRUD, `projectAdmin(ref).authAudit(q)`, `.hookFunctions()`. Keys under `auth.*`.

- [ ] **Step 1:** Playwright: each tab loads the fixture config and saves only changed fields in one PATCH; a hook set to a Postgres function sends `hook_custom_access_token_uri` as `pg-functions://postgres/public/<name>`; the HTTPS hook secret is write-only; creating an SSO provider from XML sends `metadata_xml` and `domains`, the list shows it, delete asks first; the CAPTCHA and SMS sections show Not connected until a secret is stored; the audit log pages with `before`; read-only members see disabled forms; `tr` check; key sets match.
- [ ] **Step 2:** FAIL. **Step 3:** Implement; `turkce-dogal` over the new `tr.ts` entries. **Step 4:** PASS; build; screenshots.
- [ ] **Step 5:** Commit `feat: Studio auth sessions, rate limits, hooks, mfa, sso, security and audit log`.

### Task 43: Studio — Storage: files, bucket settings, policies, S3 keys

**Model:** Opus 5.5. **Depends on:** Task 42. **Files:** `studio/src/project/{Storage.tsx,Files.tsx,Policies.tsx}`, `studio/src/project/storage/{Files,BucketSettings,Policies,S3Keys,Settings}.tsx`, `studio/src/lib/tus.ts`, `studio/src/api.ts`, `studio/src/project/index.tsx`, `studio/src/i18n/{en.ts,tr.ts}`, `studio/e2e/{storage.spec.ts,fixtures/storage-*.json}`, `studio/src/lib/tus.test.ts`, `docs/screens/v2/storage-*.png`.

**Interfaces — Produces:**
- The `storage` screen gets tabs files, policies, S3 keys, settings. Files: folders, cursor paging, search, upload with progress (files above 6 MiB through `lib/tus.ts`, a small TUS client of our own over `fetch`: create, PATCH in chunks, resume from HEAD after an error — `shortcut: no parallel chunks, until uploads above 1 GiB matter`), move, copy, rename, delete, a signed URL with a chosen expiry, an image preview through the render route when transformations are on. Bucket create and settings (public, size limit, allowed MIME types), empty and delete with typed confirmation.
- Policies: the existing policy editor filtered to `storage.objects` and `storage.buckets`, with four templates (public read of one bucket, owner-only, folder per user, authenticated upload) (D-24).
- S3 keys: endpoint and region to copy, key list, create (secret shown once), delete; hidden without `project.keys`.
- Settings: global file size limit, image transformations and S3 protocol switches (`config/storage`).
- Keys under `nav.storage`, `stor.*`.

- [ ] **Step 1:** Tests. `tus.test.ts` against a stub: a 20 MiB blob goes in four PATCHes, a failed third PATCH resumes at the HEAD offset, abort sends DELETE. Playwright: upload of a small file uses the plain route and a large one the resumable route; move and copy send the two paths; the signed-URL dialog shows a URL and copies it; a new S3 key's secret is shown once and absent after reload; a policy template lands in the editor prefilled for `storage.objects`; bucket delete needs the typed name; `tr` check; key sets match.
- [ ] **Step 2:** FAIL. **Step 3:** Implement; `turkce-dogal` over the new `tr.ts` entries. **Step 4:** PASS; build; screenshots.
- [ ] **Step 5:** Commit `feat: Studio storage files, bucket settings, policies and s3 keys`.

### Task 44: Studio — Realtime inspector, settings and policies; API keys and signing keys

**Model:** Sonnet (screens on patterns set by Tasks 41–43; Opus review). **Depends on:** Task 43. **Files:** `studio/src/project/{Realtime.tsx,Settings.tsx}`, `studio/src/project/realtime/{Inspector,Settings,Policies}.tsx`, `studio/src/project/settings/{ApiKeys,SigningKeys}.tsx`, `studio/src/lib/phoenix.ts`, `studio/src/api.ts`, `studio/src/project/index.tsx`, `studio/src/i18n/{en.ts,tr.ts}`, `studio/e2e/{realtime.spec.ts,keys.spec.ts,fixtures/realtime-*.json}`, `studio/src/lib/phoenix.test.ts`, `docs/screens/v2/{realtime,keys}-*.png`.

**Interfaces — Produces:**
- `SCREENS` entry `{ path: 'realtime', label: 'nav.realtime', group: 'nav.groupApp', icon: 'broadcast', Screen: Realtime, data: true }`; tabs inspector, policies, settings. Inspector: choose a role (anon, a user by id, service role — the token comes from `POST …/admin/realtime/token`, `project.keys`), join a channel (public or private; optional `postgres_changes` schema, table, filter; presence key), a live list of messages by kind with pause and clear (capped at 500 rows), a form that sends a broadcast. `lib/phoenix.ts` is a minimal client for the inspector only (join, heartbeat, push, receive), built on the same frame shapes as Task 16 — the vendored realtime-js is not bundled into Studio.
- Settings: the limits of `config/realtime`, private-only switch, a "restart realtime" button (`v1-shutdown-realtime`). Policies: the policy editor filtered to `realtime.messages` with two templates.
- Settings screen gains "API keys" (legacy keys with a disable switch, publishable and secret keys: create, name, delete, value shown once) and "JWT signing keys" (list with status, create standby, rotate, revoke, with the warning that rotation restarts the API for a few seconds and the JWKS URL to copy).
- Keys under `nav.realtime`, `rt.*`, `keys.*`.

- [ ] **Step 1:** Tests. `phoenix.test.ts`: frames built and parsed match the fixtures recorded from Task 16's codec tests. Playwright with a stub socket: joining shows the `ok` reply, an incoming broadcast and a `postgres_changes` row appear, sending a broadcast emits the right frame, the list stops at 500; without `project.keys` the inspector explains why it cannot connect; creating a secret key shows it once; rotating a signing key asks for confirmation and sends the status PATCH; `tr` check; key sets match.
- [ ] **Step 2:** FAIL. **Step 3:** Implement; `turkce-dogal` over the new `tr.ts` entries. **Step 4:** PASS; build; screenshots.
- [ ] **Step 5:** Commit `feat: Studio realtime inspector, api keys and signing keys`.

### Task 53: Studio — dashboard MFA screens and the recovery command

**Model:** Opus 5.5. **Depends on:** Tasks 44, 52. **Files:** `studio/src/{App.tsx,auth.tsx,SignInPanel.tsx,api.ts}`, `studio/src/account/Security.tsx`, `studio/src/i18n/{en.ts,tr.ts}`, `control/src/cli.ts`, `control/test/cli.test.ts`, `studio/e2e/{account-mfa.spec.ts,fixtures/mfa-*.json}`, `docs/screens/v2/account-mfa-*.png`.

**Interfaces — Produces:**
- Sign-in: when `GET /platform/me` reports `mfa_required`, the panel shows a six-digit code step (autofocus, paste, submit on the sixth digit, an error line with `aria-live`), with a note that an operator of the server can reset the second factor. Account → Security: state (off / on since), "set up" with the QR code, the secret as text and a verification field, and "remove" asking for the current password and a code.
- `control/src/cli.ts reset-mfa <email>`: run on the host inside the control container, calls `resetMfa` with actor `cli`, prints the number of factors removed and nothing else.
- Catalogue keys under `account.*`, `signin.mfa*`.

- [ ] **Step 1:** Tests. `cli.test.ts`: `reset-mfa` for a user with a factor removes it and writes the audit row; for an unknown address it exits 1 without saying whether the address exists. Playwright: with `mfa_required` the code step appears and a correct code lands on the projects page, a wrong one shows the server's message and keeps focus in the field; setting up shows the QR and the secret once and, after verification, the "on" state; removing sends the password and the code; the secret is not in the DOM after leaving the page; `tr` locale shows no English key text; key sets match; axe finds no violation on the code step.
- [ ] **Step 2:** FAIL. **Step 3:** Implement; `turkce-dogal` over the new `tr.ts` entries. **Step 4:** PASS; build; screenshots.
- [ ] **Step 5:** Commit `feat: Studio second factor at sign-in and in account security`.

### Task 54: In-place `BASE_DOMAIN` switch — built, tested, switched off

**Model:** Opus 5.5. **High-risk.** **Depends on:** Task 36 (parallel with 37–44). **Files:** `control/src/{hosts.ts,reconcile.ts,config.ts,domain-switch.ts}`, `control/src/jobs/project.ts` (the hosts passed to `ensure`), `control/.env.example`, `control/test/{domain-switch.test.ts,hosts.test.ts,reconcile.test.ts}`, `test/e2e/domain-switch.test.mjs`, `docs/proofs/wave3-domain-switch.md`.

**Interfaces — Produces (D-32, spec 7.3 "switching to the real domain later is configuration"):**
- Settings `DOMAIN_SWITCH_ENABLED` (default `false`) and `DOMAIN_SWITCH_PER_MINUTE` (default 3). With the switch off, control behaves exactly as today when `BASE_DOMAIN` differs from the stored hosts: it refuses to route and says so (REHBER's current statement stays true).
- With it on and a changed `BASE_DOMAIN`: `export async function planDomainSwitch(db: Db): Promise<{ project: string; from: string; to: string }[]>` and `export async function switchProject(db: Db, projectId: string): Promise<void>` — in one transaction the project's `default` domain row becomes `legacy` (bound to the same organization, wave 1 S2's rule) and a new `default` row `<ref>.<new base>` is inserted; the next apply recreates `core` with both hosts in its router rule and `PUBLIC_URL` on the new host. Reconcile switches at most `DOMAIN_SWITCH_PER_MINUTE` projects per minute, oldest first, skipping a project with a job running, and is idempotent: a restart in the middle resumes, and a project already switched is left alone.
- New hosts made by a switch count against `MAX_NEW_HOSTS_PER_WEEK` unless the new base domain's cap setting is lifted, as spec 7.3 says for a real domain; a switch that would exceed the cap stops there and reports how many remain. Studio's own host and the paused-project catch-all follow `BASE_DOMAIN` at once.
- Not changed by the switch and listed in the proof document for REHBER: OAuth callback URLs at provider consoles, webhook senders, apps built with the old URL (which keep working through the legacy alias), the SAML entity id (stays on the host it was issued for until an administrator changes it).

- [ ] **Step 1:** Tests (real control-db, fake provisioner): with the switch off and a changed base domain nothing is written and routing answers as today; with it on, three projects are switched in two reconcile passes at a rate of two per minute, each `ensure` receives the new host first and the old one as an alias, and `PUBLIC_URL` is the new host; a restart between the two passes switches each project exactly once; a legacy host is not claimable by another organization afterwards; the weekly cap stops the switch at the right project and a second run after the cap is raised finishes it; a project paused during the switch is switched when resumed; setting the base domain back with the switch on makes the old host `default` again without a third host. `test/e2e/domain-switch.test.mjs` (own-Traefik mode on `*.localhost`, as wave 1's CC-6 proof): two projects serve on the old and the new host after the switch, an app token and a stored signed URL made before the switch still work on the old host, and a mail link made after it points at the new host.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** control and e2e PASS. `wave3-domain-switch.md` records the results and states that the switch was **not** run on the server and requested no hostname.
- [ ] **Step 5 (security review):** Codex + opus. Attack list: a host of one organization becoming claimable by another during or after the switch (wave 1 Codex C-2), two routers claiming one host, a half-switched project serving links on a host it no longer answers, the cap bypassed by repeated switches, the switch triggered by anything but the operator's environment.
- [ ] **Step 6:** Commit `feat: in-place base domain switch behind a setting that is off`.

## Sub-wave 3f — Proof, release and exit

### Task 45: Conformance completion and the CorteQS app proof (local)

**Model:** Opus 5.5. **Depends on:** Task 40. **Files:** `conformance/pending.json` (empty), `docs/parity/{surface.md,exclusions.md}` (final), `docs/proofs/wave3-conformance.md`; in the CorteQS worktree, local commits only.

- [ ] **Step 1:** `pending.json` is `[]`; `coverage.mjs` exits 0: every method of `surface.md` has a test that passes with both clients or an exclusions row with a reason. The exclusions list is read line by line against D-9's rule; an entry without a valid reason becomes a task or goes to the controller.
- [ ] **Step 2:** CorteQS (spec 11, CC-5): on the local worktree `D:\Dev\corteqsemir-wt\selfbase`, refresh the vendored client to this wave's `selfbase-js` build (a local commit on `selfbase/client-swap`; no push, no PR). Run the app's unit tests against a local project stack twice: with `selfbase-js` (the alias as built) and with the real pinned `@supabase/supabase-js` pointed at the same stack (an alias override in a scratch config outside both repositories). Record pass counts and every difference.
- [ ] **Step 3:** The five realtime call sites and the phone-change flow of `client/INVENTORY.md` are exercised by a scratch script against the local stack with both clients; results recorded.
- [ ] **Step 4:** `wave3-conformance.md` (pinned version, counts per area and client, exclusions count, the CorteQS results). Commit `docs: conformance complete and the CorteQS app proof`.

### Task 46: End-to-end proof in CI and acceptance suite additions

**Model:** Opus 5.5. **Depends on:** Tasks 45, 53, 54. **Files:** `test/e2e/{wave3.test.mjs,helpers.mjs,README.md}`, `acceptance/src/{full.test.ts,helpers.ts,conformance.ts}`, `acceptance/README.md`, `acceptance/package.json`, `.github/workflows/ci.yml`.

- [ ] **Step 1:** `test/e2e/wave3.test.mjs`, through the control stack built locally with the real provisioner, one project created through `/v1`: PATCH `config/auth` enabling anonymous sign-ins and a mock provider → the project's `/auth/v1/settings` reflects it after the apply; create an ES256 signing key, rotate, and a fresh sign-in's token verifies against the project's JWKS while a token from before the rotation still works; create a publishable and a secret key and read a table with each through the public URL; a realtime subscriber on the public URL receives an insert made through `/rest/v1`; a 20 MiB resumable upload, an S3 `PutObject` with a created S3 key, and a rendered image through the shared imgproxy; a second project cannot render the first project's private object with its own keys; **with the control stack stopped** sign-in, refresh, realtime delivery, upload and download still work and a render answers 503.
- [ ] **Step 2:** FAIL before the merge of Tasks 36–44 / PASS on the branch. Added to the `e2e` job.
- [ ] **Step 3:** Acceptance suite (CC-5: "from wave 3 it includes the conformance tests that drive the real `@supabase/supabase-js`"): `acceptance` gains a `conformance` mode that runs the conformance files against any project URL with its keys (the suite's stack helper replaced by the given URL; tests needing the admin port or the mailbox use `/platform` forwards with an access token, or are skipped in `live` mode, which stays read-only). `full` mode adds: anonymous sign-in, PKCE exchange, a broadcast round trip, a `postgres_changes` insert, a signed upload and a list v2 call.
- [ ] **Step 4:** All suites, the e2e job and acceptance `full` + `conformance` against the local e2e stack green.
- [ ] **Step 5:** Commit `test: wave 3 end-to-end proof and conformance in the acceptance suite`.

### Task 47: Release, deploy, upgrade projects (server)

**Model:** Opus 5.5. **Depends on:** R3, Task 46, a clean whole-branch security gate and final review. **Files:** root `package.json` (2.3.0), `docs/proofs/wave3-deploy.md`. One builder over SSH; nothing else runs on the server meanwhile.

**Depends on wave 2 deploy:** the release procedure as `docs/proofs/wave2-deploy.md` records it, `2.2.0` running, project #1 on `2.2.0` with platform `0004`–`0008`. If any of these differs, stop and report.

- [ ] **Step 1 (Owner step):** push `v2-wave3`, merge to `v2`, tag `v2.3.0`. CI green, images in the registry (the same set as wave 2; imgproxy is a public image pinned by digest and pulled on the host by name beforehand, as wave 1 D-1's local-first rule).
- [ ] **Step 2:** On the server: the before-listing to `/opt/selfbase/proofs/wave3-before.txt`; pull the `2.3.0` images and imgproxy; `docker compose up -d` the control stack (adds `selfbase-imgproxy`); control, provisioner and imgproxy healthy; memory of the shared stack against its budget; `current_template_version` set to `2.3.0`.
- [ ] **Step 3:** Create a throw-away project on the test host (`pool: test`; zero new certificates); acceptance `full` and `conformance` against it. Keep it for Task 48.
- [ ] **Step 4 (Owner step — project #1's API restarts for a few seconds and open realtime sockets reconnect):** take a backup of project #1, then upgrade it. Verify: platform ledger holds `0009`–`0012`; existing sessions still refresh (one known test account signs in before and refreshes after); `select count(*) from auth.sessions` is at least the number of live sessions before; no `selfbase_realtime` trigger remains; acceptance `live` passes; Google sign-in's `/authorize` redirect is unchanged from before the upgrade (URL compared, no sign-in performed); every provider, SMS sender and CAPTCHA is off. Rollback if a check fails: there is no downgrade in place — the `2.2.0` core refuses to start on a database whose ledger holds `0009`–`0012` (`applyMigrations`: a ledger version with no file), and `0012` removed the triggers its realtime needs. The rollback is `current_template_version` back to `2.2.0` **and** a restore of the backup taken above into the project; writes made since that backup are lost (Owner decision, asked for at that moment).
- [ ] **Step 5:** `docs/proofs/wave3-deploy.md`: versions, commands, results; no IP, hostname or secret. Commit `docs: wave 3 deploy proof`.

### Task 48: Server proof and wave exit

**Model:** Opus 5.5. **Depends on:** Task 47. **Files:** `docs/proofs/wave3-exit.md`.

All writes go to the throw-away project, never to project #1.

- [ ] **Step 1:** Spec 11 "proves", on the server: the unmodified pinned `@supabase/supabase-js` passes the conformance suite against the throw-away project (count recorded); `selfbase-js` likewise.
- [ ] **Step 2:** The CorteQS app's tests from the local worktree, pointed at the throw-away project where a test needs a backend, with both clients (CC-5 part 2); counts recorded.
- [ ] **Step 3:** With the control stack stopped for two minutes (our own containers only): sign-in, refresh, a realtime insert and a download on the throw-away project still work; a render answers 503; started again, everything is healthy.
- [ ] **Step 4:** Wave exit as spec 11: memory of the control stack (now with imgproxy) and of one idle micro project per service against D-28; the after-listing of everything not ours diffed against `wave3-before.txt` (expected: identical); new hostnames requested in this wave (expected: 0); published ports (expected: unchanged); `pg_replication_slots` on project #1 shows at most one temporary slot. Delete the throw-away project. `wave3-exit.md` (counts only). Commit `docs: wave 3 exit proof`.

### Task 49: REHBER (Turkish) and README

**Model:** Opus 5.5. **Depends on:** Task 48. **Files:** `docs/REHBER.md`, `README.md`, `docs/auth-settings.md`, `docs/screens/v2/*` (references).

- [ ] **Step 1:** Add to `docs/REHBER.md`, in Turkish, checked with the `turkce-dogal` skill, one section each: auth settings in Studio and what restarts when they are saved; SMTP for a project (where host and port are set, why an import leaves them empty, the test mail); connecting a sign-in provider — the callback URL, where the client id and secret go, and that each provider, SMS sender and CAPTCHA is ready but off until the owner connects an account (the list from `docs/parity/providers.md`); MFA, SSO/SAML and hooks; third-party auth (trusting an external issuer); MFA for Studio logins, including the host command that resets it for a locked-out operator; the domain switch (built, switched off, not to be used until the owner decides the domain); API keys and JWT signing keys, including rotation order and what CorteQS's legacy keys need; realtime (publications replace the old triggers, private channels and their policies, the inspector, limits, that changes during a reconnect are not replayed); storage (resumable uploads, signed uploads, S3 access with an example client configuration using placeholders, image transformations and what happens when the control stack is down); "after an upgrade" for this wave (Task 47 Step 4's checks and the rollback note); known differences from Supabase added in this wave and the exclusions list by name.
- [ ] **Step 2:** Correct wave 2's statements this wave made wrong (the realtime trigger note, the API keys page). Every command in the new sections is run once as written. `README.md` (English) gains the parity statement (pinned version, conformance, link to the exclusions) and the wave 3 status. `docs/auth-settings.md` is replaced by a table generated from the registry.
- [ ] **Step 3:** Commit `docs: operator guide for wave 3`.

### Task 50: CorteQS handoff document

**Model:** Sonnet (Opus review). **Depends on:** Task 48 (parallel with 49). **Files:** `docs/handoff/wave-3-corteqs.md`.

- [ ] **Step 1:** Complete the document Task 1 started, for the CorteQS team (nothing is pushed to their repository): what changed for the app — the vendored client must be the wave 3 build (the local commit on `selfbase/client-swap`, named by its subject), the realtime protocol is now the standard one and needs no app code change, tables need no `id` column and no trigger; what they can now use and did not have (PKCE, OTP codes, MFA, anonymous sign-in, broadcast and presence, signed and resumable uploads, image transformations); what stays as it was (keys, Google sign-in, the phone-change hook); the results of Tasks 45 and 48 with both clients; how to verify on their side (the app's own tests against the project URL); the exclusions list; that the Node scripts under their `scripts/` that import the real package can now be pointed at the project unchanged.
- [ ] **Step 2:** Commit `docs: wave 3 handoff for the CorteQS team`. **Owner step:** the owner takes it to the team.

---

## Self-review (done while writing)

- **Spec coverage (section 11, wave 3; 8.1–8.3; 8.6):** conformance suite and exclusions — Tasks 1, 3, 45, 46. Full `selfbase-js` on vendored sources (AC-17) — 7, 20. Auth table of 8.2: PKCE 11; anonymous 13; OTP codes, invite, reauthentication 12, 14; OAuth providers and ID token 29, 30; identity linking 30; MFA 31, 32; phone 32; SSO/SAML 34; hooks 33; JWT keys and API keys 9, 38; security settings 8, 13; admin API 14, 31, 34; rate limits 10; third-party auth 51, 38, 42 (D-30); tail — scheduled for wave 5, not cut (D-9). Dashboard MFA (AC-12) — 52, 53. Spec 7.3's domain switch — 54 (built, off). Realtime of 8.3: protocol 16; logical replication 18; RLS and filters 19; broadcast, presence, HTTP and database broadcast 17, 19; private channels 17; limits 16, 37. Storage of 8.3: object API 23; resumable 24; transformations 25, 39; S3 26, 27; backend interface 22 (D-18). Studio 8.6 auth, storage, realtime rows and "API keys and JWT signing keys" — 41–44. "Proves" — 45 (local), 46 (CI), 48 (server). Wave exit items — 47–50.
- **Ledger items closed:** `PUT /auth/v1/admin/users/:id` — 14; amr lost on refresh — 8; MFA — 31, 32; SAML — 34; other OAuth providers — 29, 30; per-task security review — every High-risk task; sub-wave gates — 15, 21, 28, 35; core memory at each exit — D-28; early notice to the CorteQS team — Task 1.
- **Not in this wave, on purpose:** the storage `s3` backend implementation (D-18, wave 4); Web3, OAuth 2.1 server, WebAuthn (scheduled: wave 5, D-9); running the domain switch on the server (D-32, the owner's domain is undecided); CLI `storage` / `sso` commands and `config push` for the new fields (spec 7.9, wave 5); reports and charts for auth, storage, realtime (8.6, wave 5).
- **Task count:** 54 — 3.0: 7 (1–7); 3a: 8 (8–15); 3b: 6 (16–21); 3c: 7 (22–28); 3d: 9 (29–35, 51, 52); 3e: 11 (36–44, 53, 54); 3f: 6 (45–50).
- **High-risk tasks with a security review step (30):** 8–14, 16, 17, 19, 22–27, 29–34, 36–40, 51, 52, 54. Without one: documentation, schema-only, vendoring, the replication reader (its consumer, Task 19, is reviewed), Studio screens and proofs — all still task-reviewed.
- **Type consistency:** `Module` (2, 16, 22); `Setting` / `parse` / `publicSettings` (4, 12, 37); `issue` / `createSession` (8, 11, 29, 31, 34); `verify` / `JWT_KEYS` (9, 36, 38); `resolveApiKey` / `API_KEYS` (9, 16, 38); `outbound` / `setOutbound` (13, 29, 30, 32, 33, 34); `registerExtension` (16, 17, 19); `Change` (18, 19); `StorageBackend` / `finalize` (22, 23, 24, 26, 27); purpose-derived signing keys (9, 23, 25, 29, 31); `runHook` (33 and its call sites); fixed imgproxy address (25, 39); `verifyThirdParty` (51, 9's exchange, 38); `resetMfa` (52, 53); core's MFA functions used by control (31, 52).

## Controller rulings (2026-11-25)

The planner's open items, as ruled by the controller. Each is applied above.

| # | Item | Ruling | Applied in |
|---|---|---|---|
| O-1 | Control migration numbers | The wave 2 plan now uses `0008-functions-created-at` and `0009-external-db` (wave 1's fix waves took `0004`–`0007`). Wave 3's two control migrations are `0010` and `0011`. | D-4, Global Constraints, file-ownership map, Tasks 36, 38 |
| O-2 | R1 carries wave 2 commits before wave 2's whole-branch review | Accepted. R1 merges wave 2's task-reviewed migration chain into `v2-wave3`. | D-2, Execution |
| O-3 | Web3, OAuth 2.1 server, WebAuthn | They stay in wave 5 as the spec schedules them and are marked "scheduled: wave 5" in the exclusions document, not "excluded". They are not cut. | D-9, Global Constraints, Tasks 1, 3 |
| O-4 | Third-party auth (external issuers, the `accessToken` option) | In scope under the owner's full-parity rule: a High-risk task in 3d with the inline Codex + opus step. | D-30, Task 51; routes in Task 38, Studio in Task 42 |
| O-5 | MFA for Studio (dashboard) logins, AC-12 | In scope: a High-risk task in 3d (TOTP enrol, verify and recovery in control); its Studio screen in 3e after R2. | D-31, Tasks 52, 53, file-ownership map |
| O-6 | In-place `BASE_DOMAIN` switch | A task in 3e: built, tested and switched off. Nothing changes on the server; the owner's domain is undecided. | D-32, Task 54 |
| O-7 | Local sub-wave exits | Accepted. Sub-waves exit locally and wave 3 is deployed once (Task 47), which meets "each wave deployed". | D-1 |
| O-8 | The micro size | No change to the capacity table now. If D-28's measurement exceeds the cap at an exit, the exit stops and the controller asks the owner. | D-28, Tasks 15, 21, 28, 35 |
| O-9 | imgproxy keys per project | Accepted, with the fallback to one shared pair. | D-20, Task 39 |
| O-10 | Rollback by downgrade | The wave 2 plan's rollback now restores the backup into a new project. Task 47 keeps its restore-based rollback. | Task 47 |
