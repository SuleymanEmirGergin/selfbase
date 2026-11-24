# Wave 1: exit record (Task 22)

Date: 2026-11-24, 07:29 to 07:40 UTC, server clock (checked against an HTTP `Date` header: same second). Release
v2.1.1 (`04db233`). `<BASE>` = `<ip>.sslip.io`, `<ref>` = project #1's ref, `<v1-resource>` = the v1 Coolify resource
id. The real names stay on the server.

No access token was available to the builder for this task, and none was minted. The control API was therefore not
called. Control-db was read directly and read-only (`docker exec selfbase-control-db psql -U postgres`). Where a step
needs the API, it is marked **needs owner token**.

## Step 1: acceptance

**Part 1: needs owner token.** The acceptance suite requires `SELFBASE_ACCESS_TOKEN` in both modes
(`acceptance/src/helpers.ts`: the management cases and the SQL reads go through `/platform`). Creating a fresh `test`
project needs the API too.

- The fresh project would not have cost a certificate. The `test` slot `sb-test.<BASE>` is free
  (`host_slots.project_id` null, first issued 2026-11-23 22:52 UTC), and `allocateHost` takes a free slot before it
  makes a new host. The fallback (`full` on project #1) needs the same token, so neither run was made.
- The result is cited from Task 21, on the same release (`wave1-cutover.md`, Step 4): `full` 12 passed, 0 failed,
  and `live` 7 passed, 2 skipped (no public object, no login variables). The run time is shown by `control.jobs`:
  the `full` suite's `project.pause` and `project.restore` jobs on project #1 ran at 06:53:12 and 06:53:19 UTC.
- Since then, project #1 changed in one way: the legacy domain was added at 07:03, and its `project.apply` job
  recreated core. Step 5 of `wave1-cutover.md` checked it afterwards: the v1 anon key gives 200 on the legacy host's
  `/rest/v1/`, and the default host was checked with `/health` 200 only.

Token-free checks today, 07:31 to 07:37 UTC:

| Check | Result |
|---|---|
| `https://<ref>.<BASE>/health`, `https://selfbase-corteqs.<BASE>/health`, `https://selfbase.<BASE>/health` | 200 each, certificate verified |
| `/admin/ready` and `/panel/` on both project hosts | 404 |
| `sb-<ref>-{core,db,fn,pooler,rest}` | all `healthy` |
| Project #1 in control-db | `corteqs`, small, `ACTIVE_HEALTHY`, template 2.1.1, created 2026-11-24 06:51:17 UTC |
| Row counts in project #1's database | `auth.users` 0, `auth.identities` 0, `auth.refresh_tokens` 0, `auth.one_time_tokens` 0, `storage.buckets` 0, `storage.objects` 0, `public.spatial_ref_sys` 8500: the same as after the import |
| `selfbase.platform_migrations` | 0001-bootstrap, 0002-guards-2026-11-22, 0003-admin-audit-actor |

**Part 2: the CorteQS unit tests.** They passed in Task 21: 690 files, 7183 tests, exit 0
(`wave1-cutover.md`, Step 6). Nothing has changed in that worktree since, so they were not re-run (controller ruling).

## Step 2: measurements

`docker stats --no-stream`, three samples at 07:32:36, 07:33:38 and 07:34:40 UTC, memory in MiB. The limit is the
container's `HostConfig.Memory`. Every container below runs with `CgroupParent=selfbase.slice`.

### Control stack (cap 928 + 384 MiB)

| Container | Limit | Sample 1 | Sample 2 | Sample 3 |
|---|---|---|---|---|
| selfbase-control | 384 | 64.0 | 64.0 | 64.0 |
| selfbase-control-db | 384 | 37.6 | 37.6 | 37.6 |
| selfbase-provisioner | 128 | 58.7 | 58.7 | 58.7 |
| selfbase-socket-proxy | 32 | 8.2 | 8.2 | 8.2 |
| **sum of the four (cap 928)** | 928 | **168.5** | **168.4** | **168.5** |
| selfbase-logs (cap 384) | 384 | 17.2 | 17.4 | 17.3 |
| **sum of the five (cap 1312)** | 1312 | **185.7** | **185.9** | **185.8** |

The stack was idle: the three samples show no variation beyond 0.2 MiB, and CPU stayed under 0.25 % for each
control-stack container. The provisioner, at 58.7 of 128 MiB (46 %), has the tightest ratio in the stack. Watch it
under create load in wave 2.

### Idle micro project: deferred to the first wave 2 server deploy

The template cap is **1184 MiB** = db 512 + rest 128 + core 256 + fn 256 + pooler 32 (spec 7.2, sizes). No value has
been measured on this server yet. The measurement needs a fresh micro project, and creating one needs an access token,
so it is deferred to the first wave 2 server deploy. The only related number on record is Task 20's `selfbase.slice`
`MemoryCurrent`: 282 MB with the idle stack and 641 MB with one micro project. That covers the whole slice, not each
service.

### Project #1 (small, cap 2336 MiB)

| Container | Limit | Sample 1 | Sample 2 | Sample 3 |
|---|---|---|---|---|
| sb-`<ref>`-db | 1024 | 49.8 | 49.8 | 43.3 |
| sb-`<ref>`-core | 512 | 64.7 | 64.8 | 64.8 |
| sb-`<ref>`-fn | 512 | 14.1 | 14.1 | 14.1 |
| sb-`<ref>`-rest | 256 | 42.9 | 41.8 | 41.9 |
| sb-`<ref>`-pooler | 32 | 1.7 | 1.7 | 1.7 |
| **sum** | 2336 | **173.2** | **172.2** | **165.8** |

`selfbase.slice`: `MemoryMax=17179869184` (16 GiB), `MemoryCurrent` 620 MB, `active`.

### `/platform/capacity`

This is not the endpoint's output, because the endpoint needs a token. It is the same computation as
`control/src/admission.ts` `capacity()` and `hosts.ts` `newHostsThisWeek()`, from the tables they read: `control.nodes`,
`control.projects`, `control.host_slots`, `control.settings` and `control.issued_hosts`. The settings are control's
defaults: `SHARED_RESERVED_MB`, `JOB_SLOT_MB` and `OVERCOMMIT` are unset in the control container, and
`MAX_NEW_HOSTS_PER_WEEK=3`.

| Field | Value |
|---|---|
| `budget_mb` | 16384 |
| `reserved_mb` | 2720 |
| `job_slot_mb` | 512 |
| `used_mb` | 2336 (one small project running) |
| `free_mb` | 10816 (16384 × 1.0 − 2720 − 512 − 2336) |
| `projects` | `corteqs`, small, `cap_mb` 2336, `ACTIVE_HEALTHY`, memory use about 166 to 173 MiB (docker stats above) |
| `new_hosts_this_week` | 3 |
| `max_new_hosts_per_week` | 3 |

### Disk

`docker system df -v`, the `sb-*` and `selfbase-*` volume rows:

| Volume | Size |
|---|---|
| selfbase-control-pgdata | 106.8 MB |
| selfbase-logs | 126.7 kB |
| sb-`<ref>`-pgdata | 108.3 MB |
| sb-`<ref>`-denocache | 340.1 kB |
| sb-`<ref>`-storage | 0 B |
| sb-`<ref>`-functions | 0 B |

`/opt/selfbase/backups`: 875749 bytes (`du -sb`). That is the control backup below plus the v1 import dump.

## Step 3: first scheduled backup

**Control: proven.** The daily schedule (`control/src/schedule.ts`) enqueued `control.backup` at 2026-11-24
03:15:00.004 UTC. The job `succeeded` at 03:15:02.83. Its events are `backup` succeeded, then `backup: size 457058
bytes`, `backup: wrote control/20261124-031500`, and `backed_up {"location":"control/20261124-031500"}`. The
provisioner log shows `POST /projects/control/jobs` and two `GET /projects/control/jobs/backup` at that time.

- `/opt/selfbase/backups/control/20261124-031500/` holds `MANIFEST`, `db.dump` (454084 B) and `globals.sql` (2812 B),
  all root 0600 in a 0700 directory.
- Each MANIFEST line was re-checked: the size and sha256 match for both files.
- Studio lists only project backups (`GET /projects/:ref/backups`, from `control.backups`), so a control backup has no
  Studio row by design. The job row is its record.

**Project #1: pending, first run 2026-11-25 03:15 UTC.** Project #1 was created at 06:51 UTC, after that night's run.

- `control.backups` has no row for it.
- `/opt/selfbase/backups/<ref>/` does not exist yet.
- No manual backup was taken.
- The only backup tied to project #1 is its import source: `import/default/v1-20261123-233458`, v1's own dump from
  Task 21. It sits in the organization's drop area and is not a project backup row.

## Step 4: after listing

`/opt/selfbase/proofs/after.txt`, taken at 2026-11-24T07:32:22Z with the three commands of `wave1-before.md` (filter
`^(sb-|selfbase-)`), in the same layout as `before.txt` (root, 0600). It has 12 containers, 6 networks and 14 volumes,
sha256 `da83d8e72c82c56f9f61fba8941cf417d7d82952286b30c520efdfd1503d24d6`. Before (2026-11-22): 17, 6 and 14.

`diff before.txt after.txt`, line by line:

| Diff line | Explanation |
|---|---|
| `1c1` header | the title and timestamp of each listing |
| `< backup-<v1-resource>-20261122T065708` | v1 container, removed by the owner-approved stop (Owner step G) |
| `< core-<v1-resource>-20261122T065708` | the same |
| `< db-<v1-resource>-20261122T065708` | the same |
| `< fn-<v1-resource>-20261122T065708` | the same |
| `< rest-<v1-resource>-20261122T065708` | the same |
| `< <v1-resource>` (network) | v1 network, removed by the same stop |
| one `<` line and one `>` line (a container name) | one container of another Coolify project was renamed by its own redeploy on 2026-11-23 (same image, not ours) |
| `> selfbase` (network) | our own control network, named by `control/compose.yml`. Task 1's filter does not exclude a bare `selfbase` (Task 20 concern 3). |

So the difference is exactly the five v1 containers and the v1 network, plus the two explained lines. All 14 volumes
are the same names, including the v1 resource's four named volumes
`<v1-resource>_{backups,denocache,pgdata,storage}` and its one anonymous volume.

Compared with Task 21's after listing (`list.sh task22-after` against `task21-after`), nothing has changed:

- Names: the same sha256 `7dc9eb5c…b6f2fe`.
- The ids and states of all 12 foreign containers are identical.
- `coolify-proxy` has the same id, `StartedAt` 2026-07-03T12:05:14Z and `RestartCount` 0, also the same as Task 20's
  before listing.
- The `/etc/docker/daemon.json` checksum matches Task 20's before listing.

## Step 5: certificates

The hosts this wave issued are exactly the three expected: **3 of 3**, none beyond the cap.

| Host | Counted by | First issued (control-db) | Served certificate |
|---|---|---|---|
| `selfbase.<BASE>` | `settings.control_host_first_issued_at` | 2026-11-23 22:51:23 | Let's Encrypt YR1, notBefore 2026-11-23 21:53 |
| `sb-test.<BASE>` | `host_slots`, pool `test`, free | 2026-11-23 22:52:45 | Let's Encrypt YR2, notBefore 2026-11-23 21:54 |
| `<ref>.<BASE>` | `host_slots`, pool `project`, project #1 | 2026-11-24 06:51:17 | Let's Encrypt YR2, notBefore 2026-11-24 05:53 |

- Let's Encrypt backdates notBefore by about an hour, so all three were issued inside the wave's window.
- `control.issued_hosts` (custom hosts) has 0 rows. `new_hosts_this_week` = 3 = `MAX_NEW_HOSTS_PER_WEEK`.
- The legacy host `selfbase-corteqs.<BASE>` serves its v1 certificate, notBefore 2026-11-22 05:30, older than Task 1's
  before listing. Task 21 showed it is the same serial as before the cutover.
- Proxy log: `docker logs --since 2026-11-23T22:40:00Z coolify-proxy` has **0 lines**. Traefik runs at its default
  ERROR level, which does not log a successful issuance. So the log shows no ACME error and no rate-limit for any host
  since Task 20 began, but it has no issuance lines to list.
- This task asked for no hostname. It created no project and added no domain.

## Step 6: the spec's wave 1 "Proves" list

| Proves | Status | Evidence |
|---|---|---|
| A project is created from Studio in under two minutes without Coolify | **Proven, with one caveat.** The time was measured on the `/platform` create call that Studio's form makes, not on a Studio click. | `wave1-deploy.md` "Measured": 82.8 s to `ACTIVE_HEALTHY` with a new certificate, 22.3 s on a reused host. `wave1-own-traefik.md` "Observed": 82.0 s and 82.7 s with no Coolify on the machine, and Studio opened the project. |
| Two projects cannot reach each other | **Proven for the DB and admin ports.** Each core is also on the shared proxy network, because its router needs it. So a core's name resolves there, unlike in the local e2e case. Its admin port answers 403 there, and its `:8080` answers across projects. That port serves only what the public host already serves. Parked as a wave 2 item. | `wave1-cutover.md` "Isolation (Task 17 case 2)". Task 17 e2e case 2 (`test/e2e/stack.test.mjs`). |
| With the control stack stopped, every project still serves | **Proven** | `wave1-deploy.md` "Checks", Step 7: 29 of 29 probes answered 200 over 60 s, with no container recreated afterwards. |
| The provisioner refuses anything outside the template | **Proven**, by review and tests. R-1 to R-6 are open and owned. | `docs/reviews/wave1-provisioner-security.md` "Findings and verdicts" and "Not fixed: for the controller" |
| CorteQS runs as project #1 | **Proven, with limits.** The acceptance results are cited from Task 21, same release. `live` skipped 2 cases: login (no login variables) and a public object (none exists). The data is empty: `auth.users` 0, `storage.objects` 0, only `spatial_ref_sys`, so no real user-data path ran. The CorteQS app itself was not run against #1; only its unit tests are cited. | `wave1-cutover.md` Steps 3 to 6. This file, Step 1: health on both hosts, counts unchanged. |
| The whole wave requested at most `MAX_NEW_HOSTS_PER_WEEK` new certificates | **Proven: 3 of 3.** The count rests on control-db and the certificates' dates, not on proxy issuance lines (the proxy log has none at ERROR level). There is zero margin until the 7-day window rolls: the first slot frees on 2026-11-30 22:51 UTC. | This file, Step 5 |
| Own-Traefik mode (CC-6) | **Proven locally**, with its "not proven" list: public ACME, 80/443 on a Linux host with a firewall, the systemd slice, behaviour next to another proxy | `wave1-own-traefik.md` "Observed" and "Not proven there" |

## Open at the exit

- Needs an owner token: the acceptance suite (`live` on project #1, `full` on a fresh `test` project) and the
  `/platform/capacity` call itself.
- The idle micro project per-service measurement against its 1184 MiB cap is deferred to the first wave 2 server
  deploy.
- The provisioner sits at 46 % of its cap at idle; watch it in wave 2.
- Project #1's first scheduled backup: 2026-11-25 03:15 UTC, to be checked then.
- The v1 resource `<v1-resource>` stays stopped with its volumes until the owner deletes it.
