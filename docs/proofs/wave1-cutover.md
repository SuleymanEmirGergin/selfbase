# Wave 1: CorteQS cutover record (Task 21)

Date: 2026-11-23 23:31 to 2026-11-24 07:07 UTC, server clock. Release v2.1.1 (`04db233`). `<BASE>` = `<ip>.sslip.io`. `<v1-resource>` = the Coolify
resource id of the v1 install (spec 15.1). The real names stay on the server.

## Before listing

Taken 2026-11-23 23:31 UTC with `/opt/selfbase/proofs/list.sh task21-before` (the `wave1-before.md` commands; the
filter now also leaves out our bare `selfbase` network, Task 20 concern 3).

- 17 containers, 6 networks, 14 volumes, sha256 `225ca3d0ad0fecb2e2a7f41c8e79c522979bb0d1a5deb4c2bf310e44e49769a0`,
  the same as Task 20's before listing; ids and states of all 17 identical to Task 20's after listing.
- `coolify-proxy`: same id, `StartedAt` and `RestartCount 0` as Task 20. `daemon.json` checksum unchanged.
- The five v1 containers `{core,rest,db,fn,backup}-<v1-resource>-20261122T065708`: running.

## Phase 0: release 2.1.1

- `/opt/selfbase/src`: `git fetch --tags`, `git checkout v2.1.1` -> `04db233`, clean tree.
- The eight images built as before (`proofs/build-v.sh 2.1.1`, the 2.1.0 `build.sh` with the version as an argument,
  repository root as context). The 2.1.0 images stay in place for rollback.
- `.env`: only `TEMPLATE_VERSION` changed (`2.1.0` -> `2.1.1`; a diff against the copy taken first shows one changed
  line). `docker compose -p selfbase -f control/compose.yml --env-file .env up -d`: returned in 17 s; `/health` 200 over
  HTTPS 22 s after the start. control, control-db and provisioner run `:2.1.1`; logs and socket-proxy are pinned
  third-party images and were not recreated. control-db kept its data (one owner, three `REMOVED` throw-away projects,
  zero access tokens, organization `default`).

| Image | 2.1.1 id |
|---|---|
| db | `sha256:61029a9d5dba80c3feaf343652744b4fd99d43bbd0f01e419fbb214dd27534a6` |
| core | `sha256:6237772d1970baf8a8a0f66b86b8a48cbe88f26d7734d36a979a43891e5209ce` |
| fn | `sha256:efaa747c0b7509d703fd4779f05beb123e88cf2b1e0294a75aff19a8592aabd6` |
| rest | `sha256:2750389e0dc6a094105beb139bcb83293e86d1a9a55a59f0ad9ab2ad29d40399` |
| pooler | `sha256:9108ad6096ff9612eef4243dafd745348b557f16b881bdbce3f806e0b7a7fae5` |
| job | `sha256:72d13b3271f7332b0cc7e80df65492081573842c3c40e6546c489bb18ea45599` |
| control | `sha256:ea06b2d2f8a1e5cae4b54ab97e89084009918833ae34cccf25e3b66e2f6497a8` |
| provisioner | `sha256:f37480e792afaf8821d3c083bf059989ddf6d0170e14d6227883308fd9f968a2` |

## Step 1: v1 backup (Owner step F, approved)

One container, `selfbase-v1-backup`, `--rm`, from the v1 backup image `<v1-resource>_backup:<commit>`, on network
`<v1-resource>`, with `<v1-resource>_storage` mounted read-only and `/opt/selfbase/backups/import/default` as
`/backups`, running v1's own `bash /scripts/backup.sh`. `PGPASSWORD` came from the v1 backup container's environment in
the same shell line and was never shown. Took 1 s.

- Written as `<ts>` = `20261123-233458`, then renamed to `import/default/v1-20261123-233458` (the drop area of
  organization `default`). Root-owned, 0700/0600.
- MANIFEST: `db.dump` 415535 B, `globals.sql` 2812 B, `storage.tar.gz` 99 B; each size and sha256 re-checked: ok.
- Storage archive: no files (the v1 storage volume is empty).

## Dump restore proof (addendum)

A throw-away database `selfbase-t21dry-db` (the `selfbase-db:2.1.1` image with the project command line) on a
throw-away network, prepared as core prepares a project database (`db/platform/0001..0003` of v2.1.1, each in one
transaction), then `restore.sh` of `selfbase-job:2.1.1` with `RESTORE_DIR=import/default/v1-20261123-233458`
(backups read-only, storage on a tmpfs):

```
restore: import/default/v1-20261123-233458 verified
restore: a v1 database: the platform ledger is dropped, core adopts it at its next start
restore: database restored (cron jobs as in the backup)
restore: storage restored
```

Row counts after the restore (the v1 database is empty, as expected): `auth.users` 0, `auth.identities` 0,
`auth.refresh_tokens` 0, `auth.one_time_tokens` 0, `storage.buckets` 0, `storage.objects` 0; the only public table is
PostGIS's `spatial_ref_sys` (8500, reference data). Two earlier tries on a bare image database (no pg_cron, then the
image's own PostGIS extensions) failed before any change; a project database never looks like that. The container, network and its two
anonymous volumes were removed; a listing afterwards equals the before listing.

## Legacy hostname allowed

`LEGACY_HOSTNAMES=selfbase-corteqs.<BASE>` appended to `/opt/selfbase/.env` (the key was absent; nothing else
changed), control recreated with `up -d` (healthy in 8 s), the variable present in the control container. No domain
was added yet. The legacy host still answers 200 from v1 with its existing certificate; its serial was recorded on
the server for the step 5 comparison and is not published here.

## Step 2: env file and access token

- The owner created a personal access token in Studio and left it in a root 0600 file. Its shape was checked without
  printing it, it was read into the environment of one tmux shell on the server (the only place it lives) and the file
  was shredded. Every API call reads it from that environment and sends it as a header on stdin, never on a command
  line. (A first file held a copy of the master key instead; control refused it, it was shredded and the shell was
  killed.)
- `(umask 077; docker inspect ... <v1 core container> > /opt/selfbase/v1.env)`: mode 600 root, 61 keys, checked by
  name only (`cut -d= -f1`).

## Step 3: import (certificate 3 of 3)

`docker run --rm --user 0:0 -e SELFBASE_ACCESS_TOKEN -v /opt/selfbase/v1.env:/v1.env:ro selfbase-control:2.1.1 node
/app/scripts/import-project.mjs --url https://selfbase.<BASE> --org default --name corteqs --size small --backup-dir
import/default/v1-20261123-233458 --env-file /v1.env`. The control image runs as `node`, which cannot read a root 0600
file, hence `--user 0:0`. 06:51:17 to 06:51:53 UTC: **36 s**, exit 0. Then `v1.env` was shredded (confirmed gone).

- Project #1: ref `<ref>`, name `corteqs`, size small, pool `project`.
- Job steps: allocate, secrets, ensure, healthy, stop, restore, restored, start, started, warm, coming_up,
  certificate, activate. Restore output: verified, the v1 ledger dropped, database and storage restored.
- `ignored` (24): nine `COOLIFY_*` keys, `CORE_PORT`, `DB_HOST`, `FN_URL`, `NODE_ENV`, `NODE_VERSION`,
  `PANEL_ADMIN_EMAIL`, `PANEL_ADMIN_PASSWORD_HASH`, `PATH`, `PGRST_URL`, `POSTGRES_PASSWORD`, `PUBLIC_URL`,
  `SOURCE_COMMIT`, `STORAGE_DIR`, `TRUST_PROXY`, `YARN_VERSION`. The expected `POSTGRES_PASSWORD`, `PANEL_*`,
  `PUBLIC_URL` and `TRUST_PROXY` are all there.
- `unknown` (8, not imported; controller ruling: they stay out): `HOST`, `SERVICE_FQDN_CORE`,
  `SERVICE_NAME_{BACKUP,CORE,DB,FN,REST}`, `SERVICE_URL_CORE`. These are Coolify's own variables and the bind address,
  checked by comparison before the import.
- Certificate: Let's Encrypt `YR2`, SAN `<ref>.<BASE>`, not after 2027-02-22, issued on the first attempt within the
  36 s. `new_hosts_this_week`: 2 before the import, **3 of 3** after.

## Step 4: verification on `<ref>.<BASE>`

| Check | Result |
|---|---|
| Containers | core, db, fn, pooler, rest of `sb-<ref>`: all healthy |
| `/health` over HTTPS | 200, certificate verified |
| v1 `ANON_KEY` (from the v1 env, never shown) on `/rest/v1/` | 200 |
| Keys in control vs the v1 env | anon equal, service_role equal (compared, not shown) |
| `GET /platform/projects/<ref>` | `ACTIVE_HEALTHY`, template 2.1.1, certificate ok, `smtp_configured: false` |
| Row counts vs the v1 dump | equal: `auth.users` 0, `auth.identities` 0, `auth.refresh_tokens` 0, `auth.one_time_tokens` 0, `storage.buckets` 0, `storage.objects` 0, `public.spatial_ref_sys` 8500 |
| File download | not possible: v1 has no storage object (`storage.objects` 0, the storage archive is empty) |
| `selfbase.platform_migrations` | 0001-bootstrap, 0002-guards-2026-11-22, 0003-admin-audit-actor = every file of `db/platform` at v2.1.1 |
| Acceptance `full` (v1 has no `SMTP_HOST`, so `full` rather than `live`) | **12 passed, 0 failed** in 24.1 s; cleanup left nothing |
| Acceptance `live`, run after it | 7 passed, 0 failed, 2 skipped (no public object; no login variables) |
| Row counts after both runs | unchanged |

The acceptance suite ran from the v2.1.1 checkout in a throw-away `node:24.22.2-slim` container on network
`selfbase`. The keys and the token were passed by name from the environment, with no file.

### Isolation (Task 17 case 2) between a throw-away `test` project T and project #1

T (`t21-iso`, micro, `test` pool) took the existing `sb-test.<BASE>` slot: `ACTIVE_HEALTHY` in 25 s, no new
certificate (`new_hosts_this_week` stayed 3). Probes only; nothing was changed on project #1.

| Probe | T -> #1 | #1 -> T |
|---|---|---|
| Resolve the other `sb-<ref>-db` | `EAI_AGAIN` (no) | `EAI_AGAIN` (no) |
| TCP to the other `db:5432` (its `sb-<ref>` address) | timeout | timeout |
| TCP to the other `core:8080` and `:8081` (its `sb-<ref>` address) | timeout | timeout |
| Resolve the other `sb-<ref>-core` | resolves | resolves |
| The other's anon key on this host's `/rest/v1/` | 401 | 401 |
| Subnets | #1 `10.207.0.96/27`, T `10.207.0.128/27` | |

Every core is also on the proxy network `coolify`, because the router needs it, so a core's name resolves there. Over
that network, from T's core (second throw-away project `t21-iso2`): #1's `:8081/admin/ready` answers **403** (the peer
is outside #1's /27), and `:8080/health` answers 200, which is the public API that `<ref>.<BASE>` exposes anyway. The
local e2e case expects the core name not to resolve. On the shared proxy network it does, by design, and the admin
port refuses. Each throw-away project (`t21-iso`, `t21-iso2`, `t21-iso3`) was deleted in about 3 s, with no container,
network or volume left. The `test` slot is free, and #1 stayed `ACTIVE_HEALTHY`.

## Before Owner step G

Listing `task21-preG`: the 17, 6 and 14 foreign names, the container ids and states, `coolify-proxy` and
`daemon.json` are all unchanged from the before listing. The five v1 containers are running, and the legacy host
answers 200 from v1. Project #1 has only its default domain.

## Owner step G (approved): v1 stopped

The controller stopped the v1 resource in the Coolify UI around 07:00 UTC, with "Run Docker Cleanup" unticked. The
resource was **not deleted**. Checked at 07:03 UTC:
- The five v1 containers are gone (a Coolify stop removes them), and so is the v1 network `<v1-resource>`.
- All four named volumes remain: `<v1-resource>_{backups,denocache,pgdata,storage}`. So does the backup
  container's one anonymous volume (its postgres data directory).
- No image was pruned: all 16 selfbase images (`2.1.0` and `2.1.1`) are present.
- `https://selfbase-corteqs.<BASE>/health` answered 503 (Coolify's catch-all, no router for the host).

## Step 5: the v1 hostname moves to project #1

`POST /platform/projects/<ref>/domains {"hostname":"selfbase-corteqs.<BASE>","kind":"legacy"}` (the call Studio's
Ayarlar -> Alan adlari makes) at 07:03:32 UTC, with the owner's token from the shell environment. The `project.apply`
job recreated core in 1 s.

| Check | Result |
|---|---|
| `https://selfbase-corteqs.<BASE>/health` | 200 after 11 s, certificate verified |
| Certificate | the same certificate serial before and after (compared on the server, not published) |
| `new_hosts_this_week` | 3 before, **3 after** |
| The v1 anon key (= control's anon key of #1) on the legacy `/rest/v1/` | 200 |
| `<ref>.<BASE>/health` | 200 |
| Domains of #1 | `<ref>.<BASE>` (default), `selfbase-corteqs.<BASE>` (legacy) |
| Routers claiming the legacy host | only project #1's two core routers (`Host(<ref>.<BASE>) \|\| Host(selfbase-corteqs.<BASE>)`) |

## Step 6: CorteQS unit tests

`npm run test` (`vitest run`) in the CorteQS app worktree on the Windows machine, unchanged, reading its own
`.env.local` (which points at the legacy host). The builder did not open that file and edited no file. **690 test
files, 7183 tests passed**, exit 0, in 387.7 s. `git status` there shows no change afterwards. The app worktree has
no `docs/app-swap-report.md` and no earlier recorded result, so this run is recorded without a comparison
(controller ruling).

## Step 7: rollback, on paper

Until the owner deletes the v1 resource, the rollback is:
1. In Studio -> project #1 -> Ayarlar -> Alan adlari, remove `selfbase-corteqs.<BASE>`. Project #1's router then
   claims only `<ref>.<BASE>`.
2. In Coolify, start the v1 resource `<v1-resource>`. Its volumes were never touched; the listing above shows all of
   them still in place.

Anything written to project #1 after the cutover is not carried back to v1: v1 comes back with its database and
storage as they were when it stopped. The v1 resource is deleted only when the owner says so.

## After listing

Taken at 07:07 UTC with `/opt/selfbase/proofs/list.sh task21-after`: 12 containers, 5 networks, 14 volumes, sha256
`7dc9eb5c6d78c991e05588539717db8c03c21fa62a734264474b231299b6f2fe`. The diff
against the before listing is exactly the v1 resource's stop: its five containers
`{backup,core,db,fn,rest}-<v1-resource>-20261122T065708` and its network `<v1-resource>` are gone, both removed by
Coolify's stop. All 14 volumes, the v1 ones among them, are still there. The other 12 containers keep their ids and
states. `coolify-proxy` has the same id, `StartedAt` and `RestartCount 0`. The `daemon.json` checksum is unchanged.

## Token and leftovers

- `GET /platform/access-tokens`: **1** token, the owner's Task 21 token. It was kept, as instructed; the owner
  deletes it in Studio. The tmux shell that held it was killed, and the helper output files were deleted.
- `/opt/selfbase/v1.env` and the token file are gone.
- On the server, under `/opt/selfbase`: the v1 backup `backups/import/default/v1-20261123-233458`, the pre-2.1.1
  `.env` copy in `secrets/` (it holds no secret), and the helper scripts and listings in `proofs/`.
