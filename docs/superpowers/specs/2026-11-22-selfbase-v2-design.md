# selfbase v2 — multi-project platform with Supabase parity (design)

Date: 2026-11-22 · Status: awaiting owner approval · Builds on: `2026-11-22-selfbase-design.md` (v1)

Reader: a planner who writes task-by-task implementation plans from this file and has not seen the
conversation behind it. Decisions the owner made are stated as facts. Decisions made in this document
are marked **Architect's call (AC-n)** with a one-line reason; decisions made by the controller of the
build are marked **Controller's call (CC-n)**. Both can be corrected before planning.
Items marked *(verify)* were not checked against the server or an upstream project. Those about the
server are resolved in **the first task of wave 1** ("server facts", section 11), which records the
real values in this file; those about upstream projects are checked by the first task that depends on
them.

## 1. Intent and why

v1 gave CorteQS one small Supabase replacement per app: Postgres 17 + PostgREST + `core` (auth, storage,
realtime, admin API, gateway) + `fn` (Deno) + a five-screen panel + `selfbase-js`. It covers what CorteQS
calls today and nothing more.

The owner's goal for v2: "Tamamen bir Supabase oluşturmak istiyoruz, eksik kısım olmayacak." v2 is a
complete Supabase equivalent for the team: one dashboard, many projects, the full client surface, a CLI,
a management API, backups with point-in-time restore, high availability, branching. The only accepted
difference from Supabase is maturity. The v1 reasons still hold: control and portability (the owner will
move it to his own server and must understand it), low resource cost, no dependency on the Supabase
company or its services.

## 2. Goals

1. **Multi-project.** One dashboard ("Studio") with organizations, projects, members and roles,
   per-project keys. A project is created from the dashboard or the CLI in under two minutes.
2. **One isolated stack per project**, created by a control plane that talks to Docker directly and
   routes with Traefik labels. Coolify is not involved in projects.
3. **Client parity.** An app written against `@supabase/supabase-js` runs unchanged: every method of the
   pinned supabase-js version works (auth, PostgREST, storage, realtime, functions, GraphQL).
4. **Tooling parity.** A `selfbase` CLI that mirrors the supabase CLI commands the team uses, and a
   control-plane HTTP API shaped like Supabase's Management API.
5. **Feature parity** for every gap listed in section 8: realtime broadcast/presence/logical replication,
   full auth, full storage, GraphQL, queues, cron, webhooks, vault, pooler, logs, advisors, Studio screens.
6. **HA and PITR as working code**, tested on the one server; a second server and an external S3 are a
   configuration change later.
7. **Branching**: preview projects cloned from a parent project.
8. **Operable by the owner.** `docs/REHBER.md` (Turkish) is extended in every wave; nothing is installed
   by a step the guide does not explain.

## 3. Non-goals

- Making the real `supabase` CLI work in v2. The API is shaped for it; section 7.9 lists what the later
  step needs.
- Things that only exist because Supabase is a company or a cloud: billing, usage invoices, support
  tickets, marketplace/OAuth apps for third parties, multi-region placement, SOC2/HIPAA switches.
- Studio's AI assistant (needs a paid external LLM), analytics buckets (Iceberg) and vector buckets
  (alpha at Supabase), foreign data wrappers UI (`wrappers`), log drains to third parties.
- A GitHub App for branching. Branches are created by the CLI, which a CI job can call.
- API-level read-replica endpoints and geo load balancing. A read-only pooled connection string is
  provided when a replica exists (8.9).
- Supabase's exact privilege model for the `postgres` role. As in v1, `postgres` is the superuser.
- Postgres major-version upgrades. v2 pins Postgres 17.
- Horizontal scaling of `core`, `rest` or `fn` inside one project. One of each per project.

## 4. Anti-goals (failure even if it works)

- A runtime dependency on Supabase services: no `supabase/*` service image (GoTrue, storage-api,
  realtime, supavisor, edge-runtime, studio, postgres-meta, logflare, kong) and no `@supabase/*` package
  installed at runtime. Allowed: open-source code **copied into the repo or compiled into our own image**
  with its license file — MIT client libraries (as postgrest-js in v1) and Postgres extensions
  (pg_graphql, Apache-2.0). `@supabase/supabase-js` is allowed as a **test-only** devDependency (the
  conformance oracle, 8.1).
- Affecting other teams on the shared server: touching their containers, volumes or networks, restarting
  or reconfiguring `coolify-proxy`, changing Docker daemon settings, exhausting RAM or disk.
- A control-plane compromise that becomes host root (section 7.5).
- A project that stops when the control plane is down. Projects must keep serving with the control
  plane, the dashboard and every shared service stopped (image transforms and log search excepted).
- Secrets printed, logged, committed or stored unencrypted in the control-plane database.
- A copy (branch, restore, import) that can send requests to the production project's URLs or use its
  third-party credentials.
- Features Supabase does not have.

## 5. Constraints

- **Server (measured):** shared Coolify host, 32 GB RAM (~28 GB free), 8 cores, 449 GB free disk, no
  swap. Budget for everything selfbase: **16 GB RAM**. Other teams' apps run there.
- **Proxy:** `coolify-proxy` (Traefik) owns ports 80/443. We may join its Docker network and label our
  own containers. We never restart or reconfigure it and never write into Coolify's directories.
- **Docker socket** is root-equivalent; access is minimised (7.5).
- **Approved by the owner (the server's owner asked for this platform):** mounting `docker.sock` into
  the socket proxy, a host directory for backups, a log listener on `127.0.0.1`, creating our containers
  under `cgroup-parent=selfbase.slice`, and the 16 GB budget.
- **Builders have SSH/root on the server** and run wave proofs and cutover steps themselves
  (`docker inspect coolify-proxy`, killing a primary, v1 `backup.sh`). **Shared-host rule:** a builder
  touches only `sb-*` / `selfbase-*` containers, networks and volumes and selfbase's own paths. Anything
  else — other teams' resources, restarting or reconfiguring `coolify-proxy`, Docker daemon
  configuration, host-wide settings (including `systemctl set-property`), stopping the v1 Coolify
  resource — needs an explicit owner OK first, asked for at the moment it is needed. Read-only
  inspection of shared objects (`docker inspect`, `docker network ls`) is allowed.
- **Domain:** projects stay on `<ip>.sslip.io` for now; a real wildcard domain comes later and must be a
  configuration change (7.3).
- **No second server.** Proofs that need "another machine" run on the owner's Windows machine with
  Docker Desktop (section 11 says what that does not prove).
- **Secrets:** generated by the control plane, stored encrypted (7.4). Operators enter third-party
  secrets (SMTP, OAuth) in the dashboard or CLI; they are never echoed back.
- **Licences:** OSI-licensed components only.
- **Builders:** Opus subagents implement, each task reviewed separately. Each wave is complete, deployed
  to the server and tested before the next starts.
- **Existing deployment:** the CorteQS v1 install (a Coolify compose resource, public at
  `selfbase-corteqs.<host>.sslip.io`, database currently empty) must keep working until it has become
  project #1 (section 10).
- **Team rules** from v1 still apply to the app repository (no push/PR without team approval, migration
  files are never edited, `scripts/ops/*` is never run).

## 6. Approaches considered

### 6.1 Multi-project model

| Option | What | For | Against | Decision |
|---|---|---|---|---|
| **A. Stack per project** | Each project gets its own Postgres + PostgREST + core + fn (today's stack as template) | Hard isolation (memory caps, crashes, extensions, Postgres settings, restore and clone are per project); v1 code is reused as is; a project can move to another server alone | ~1.2 GB cap per project; more containers | **Chosen (owner)** |
| B. Shared Postgres, database per project | One Postgres cluster, one database + role set per project, shared core | Cheapest RAM | Roles, `pg_cron`, replication slots, WAL, PITR and extensions are cluster-wide: one project's restore or bad query hits all; core must become multi-tenant | Rejected |
| C. Shared everything, schema per tenant | One database, tenant column/schema | Cheapest | Not Supabase semantics (`public` schema, `auth.users`, RLS as written); migrations of apps would need rewriting | Rejected |

### 6.2 Provisioning

| Option | For | Against | Decision |
|---|---|---|---|
| **Docker Engine API + Traefik labels** | Works with or without Coolify; the owner can move to a plain server; sub-minute create; exact control of limits, networks, labels | We own a provisioner and its security | **Chosen (owner)** |
| Coolify API (each project a Coolify resource) | No socket access of our own | Ties the platform to Coolify and its API changes; slow git-based deploys; v1 already hit Coolify quirks (mangled `$` in env, empty relative bind mounts); projects clutter the team's Coolify | Rejected |

## 7. Architecture

### 7.1 Overview

```
                    Internet
                       │ 80/443
        ┌──────────────┴───────────────┐
        │ Traefik (coolify-proxy, or   │   routes by Host from labels on OUR containers
        │ our own on a plain server)   │
        └──┬───────────────────────┬───┘
           │ selfbase.<BASE>       │ <ref>.<BASE>
┌──────────┴───────────┐   ┌───────┴───────────────────────────────┐
│ CONTROL STACK (one)  │   │ PROJECT STACK (one per project)       │
│ control  Studio + API│──▶│ core :8080 public  :8081 admin        │
│ control-db Postgres  │   │ rest   PostgREST                      │
│ provisioner ─▶ socket│   │ fn     Deno function host             │
│   -proxy ─▶ docker   │   │ db     Postgres 17 (+ replica if HA)  │
│ imgproxy  (shared)   │   │ pooler PgBouncer                      │
│ logs  VictoriaLogs   │   │ dbproxy HAProxy (HA only)             │
│ metrics VictoriaMetr.│   │ volumes: pgdata, storage, functions,  │
│ s3    Garage  (w4)   │   │          denocache                    │
│ dcs   etcd    (w4)   │   └───────────────────────────────────────┘
└──────────────────────┘
```

- **Control stack**: one compose file (`control/compose.yml`), deployable as a Coolify resource or with
  plain `docker compose`. It is the only thing an operator installs.
- **Project stacks** are created, upgraded, paused and removed by the control plane. They do not appear
  in Coolify.
- **Naming:** every object we create is named `sb-<ref>-<service>` (containers, volumes) or `sb-<ref>`
  (network) and labelled `selfbase.managed=true`, `selfbase.project=<ref>`. Control-stack containers are
  named `selfbase-<service>`.
- **Project ref:** 20 random lowercase letters, like Supabase. **AC-1:** refs and personal access tokens
  use Supabase's exact formats (`^[a-z]{20}$`, `sbp_` + 40 hex) from day one — the real CLI validates
  both, and changing identifiers later is a migration.

**AC-2: the repo becomes one npm-workspaces monorepo** — `core/`, `control/`, `provisioner/`, `cli/`,
`client/`, `studio/` (today's `panel/`), `fn/`, `db/`, `template/`. Reason: control reuses core's auth
module and the CLI reuses the type generator; one version number for all images.

**CC-1 (was AC-3): images are built by GitHub Actions in the existing private GitHub repository and
pulled from private GHCR, tagged with the release version.** Reason: the control plane must not build
images (no build API behind the socket proxy), and Coolify's periodic image prune deletes local images
of paused projects. The owner enters the GHCR pull credential once (Coolify registry settings, or
`docker login` on a plain server); the provisioner pulls with the daemon's stored credential and never
sees the token. The local developer stack (`selfbase start`) and CI **build images locally** from the
repository and need no registry token. Each project row pins a `template_version`; upgrading a project
= recreate its containers on the new tag.

### 7.2 Project template

**AC-4: the template stays a compose file (`template/compose.yml`, today's `compose.yml` evolved); the
provisioner interprets a strict subset of it and refuses unknown keys.** Reason: one source of truth
that plain `docker compose` also runs — for local development (`selfbase start`), CI and tests.

Changes to the v1 stack:

| Service | Change in v2 |
|---|---|
| `db` | Same image plus extensions (8.4), WAL-G and Patroni binaries (8.8). `SELFBASE_HA=off` runs plain Postgres exactly as v1. Platform schemas are versioned (below). |
| `rest` | Unchanged. Schemas exposed and max rows come from project config. |
| `core` | Admin API moves to a second port `:8081` that has no Traefik labels (**AC-5:** the superuser SQL API must not be reachable from the internet; v1 exposed it behind one password). `/panel` is removed. Everything in 8.1–8.3 lands here. |
| `fn` | Functions come from a `functions` volume written by deploys (8.5), not from a host path. Host-path mount remains for local development. |
| `pooler` | New: PgBouncer, transaction mode (8.9). |
| `backup` | Removed as a per-project daemon. Backups are jobs started by the control plane (8.8). **AC-6:** a sleeping 512 MB-capped container per project is waste; one job slot for the whole server. |
| `dbproxy` | New, HA projects only: HAProxy that owns the network alias `db` (8.8). |

**Platform migrations (AC-7).** `db/bootstrap/*.sql` becomes migration `0001` of a versioned set
(`db/platform/NNNN-name.sql`) that `core` applies at start, recorded in `selfbase.platform_migrations`,
under an advisory lock. Reason: every wave adds tables to *existing* projects (MFA factors, realtime
messages, …); v1's hand-run `db/upgrade/*.sql` does not scale to many projects. A v1 database is
recognised and stamped as `0001` + the 2026-11-22 upgrade.

**Sizes** (hard `mem_limit` per container, MiB; Postgres settings follow the size):

| Size | db | rest | core | fn | pooler | Total | Postgres |
|---|---|---|---|---|---|---|---|
| micro (default, branches) | 512 | 128 | 256 | 256 | 32 | **1184** | shared_buffers 128 MB, max_connections 60 |
| small (CorteQS) | 1024 | 256 | 512 | 512 | 32 | **2336** | 256 MB, 100 |
| medium | 2048 | 256 | 512 | 1024 | 32 | **3872** | 512 MB, 150 |

HA adds a replica (same cap as `db`) and `dbproxy` (32). v1 measured ~230 MiB real use for an idle
stack with CorteQS data, so micro has headroom.

**Config delivery (AC-8):** project configuration (auth settings, SMTP, providers, limits) is stored in
control-db and delivered as container environment when the provisioner creates the container; a config
change recreates the affected container (core: ~3 s, clients reconnect). Reason: a project must start
and run with the control plane down, so it cannot fetch config at boot; this is also how v1 and plain
compose work.

### 7.3 Routing, domains, TLS

- Hostnames: `<ref>.<BASE_DOMAIN>` for a project's API, `selfbase.<BASE_DOMAIN>` for Studio and the
  management API. `BASE_DOMAIN` is a setting, today `<ip>.sslip.io` (owner's decision). See
  "Certificates on sslip.io" below.
- **On the Coolify server (`PROXY_MODE=coolify`):** the provisioner attaches each project's `core`
  container to the proxy network and sets labels:

  ```
  traefik.enable=true
  traefik.docker.network=<PROXY_NETWORK>                       # "coolify" (verify)
  traefik.http.routers.sb-<ref>.rule=Host(`<ref>.<BASE>`) [|| Host(`<custom>`)]
  traefik.http.routers.sb-<ref>.entrypoints=<PROXY_ENTRYPOINT_HTTPS>   # "https" (verify)
  traefik.http.routers.sb-<ref>.tls.certresolver=<PROXY_CERTRESOLVER>  # "letsencrypt" (verify)
  traefik.http.services.sb-<ref>.loadbalancer.server.port=8080
  + an http router with a redirect-to-https middleware named sb-<ref>-redirect
  ```

  The three names are settings with Coolify's defaults; the install step reads them from
  `docker inspect coolify-proxy` (read-only) and the guide shows how. Router, service and middleware
  names are always prefixed `sb-<ref>` so they cannot collide with Coolify's.
- **If its owner restarts or recreates `coolify-proxy`:** Traefik rebuilds its routes from container
  labels when it starts, so our routes return without any action; requests fail for the seconds it is
  down; certificates persist in Coolify's ACME storage. Our containers stay members of the proxy
  network, and a network with attached containers cannot be removed. The control plane's reconcile loop
  (7.6) re-attaches a container if it is ever found detached.
- **On a server without Coolify (`PROXY_MODE=own`):** the control compose starts `traefik:v3` (compose
  profile `proxy`) on 80/443 with the Docker provider constrained to `selfbase.managed=true`, reading
  Docker through its **own read-only socket proxy** (GET on containers, networks, events, version only),
  ACME HTTP-01. Same labels.
- TLS certificates are per host via HTTP-01 (a wildcard certificate needs DNS-01, i.e. proxy
  configuration we may not change on Coolify).
- **Certificates on sslip.io.** `sslip.io` is **not on the Public Suffix List** (checked against
  publicsuffix.org on 2026-11-22). For Let's Encrypt the registered domain is therefore `sslip.io`
  itself, and the "new certificates per registered domain per week" limit (50 by default; whether
  sslip.io has a raised limit is unknown *(verify in the server-facts task: issue nothing, read
  Traefik's ACME log and crt.sh)*) is shared with every sslip.io user in the world — including the
  other teams' Coolify apps on this IP, whose new deployments draw on the same quota and the same ACME
  account in `coolify-proxy`. Issuance can fail for reasons outside our control, and every certificate
  we request is one another team cannot get that week. Design consequences (**AC-33**, reason: keep
  our issuance near zero while on sslip.io):
  1. **A hostname is issued once and reused.** Traefik keeps a certificate per host in its ACME store
     and renews it (renewals of an unchanged host do not count against the weekly limit). So hostnames
     are treated as a scarce resource: `project_domains` rows of a deleted project go back to a free
     list (`host_slots`) and the next project or branch takes a freed host before a new one is made.
     The CorteQS legacy host already has its certificate.
  2. **Cap on new hostnames:** setting `MAX_NEW_HOSTS_PER_WEEK` (default 3 on sslip.io). Creating a
     project that would need a new host beyond the cap is refused with a clear message; reusing a slot
     is always allowed.
  3. **Branches use a fixed pool** of `BRANCH_HOST_SLOTS` hosts (default 2 on sslip.io) and are refused
     when the pool is in use (8.10). Throw-away projects in wave proofs use one fixed test host.
  4. **A project whose certificate is not issued yet** is shown as `certificate pending` in Studio (the
     control plane probes its own URL); it is not reported healthy.
  5. One certificate with many names was considered and rejected: every added project changes the name
     set and forces a *new* certificate, which is more issuance, not less.
  6. Path-based routing under one host (`…/p/<ref>/`, zero certificates per project) was considered and
     rejected for now: a second routing mode to build and test, and all projects would share one web
     origin. It is the fallback if the limits block us in practice before the real domain arrives.
- **Switching to the real domain later is configuration:** set `BASE_DOMAIN` (and
  `MAX_NEW_HOSTS_PER_WEEK`, `BRANCH_HOST_SLOTS` to their real-domain defaults); the reconcile loop
  recreates each `core` with the new default host **and keeps the old sslip.io host as a `legacy`
  alias** in the same router rule, so existing app builds, stored file URLs and e-mailed links keep
  working; certificates for the new hosts are issued as containers come up (staggered, a few per
  minute). What is not automatic and goes in the guide: OAuth provider consoles and webhook senders
  must be given the new callback URLs, and apps are rebuilt with the new URL when convenient.
- **Custom domains** per project = an extra `Host()` in the rule; applying it recreates `core`.
- **Paused projects:** the control container carries a low-priority catch-all router for
  `HostRegexp` of the base domain that answers `540 project paused` (Supabase's status), so a paused
  project does not look like a network failure.
- **Networks (AC-9):** each project has its own bridge network `sb-<ref>` with an **explicit /27 subnet**
  cut from a configured private range (`PROJECT_SUBNET_POOL`, default `10.207.0.0/16`). Shared services
  (control, imgproxy, s3, dcs) are *connected into* each project network; project containers never share
  a network with another project. Reason: Docker's default address pools allow only ~31 networks per
  host, shared with Coolify (which creates one per resource), and we may not change daemon settings;
  explicit subnets do not consume the pools. Only `core` is additionally on the proxy network.

### 7.4 Secrets

- **Generated by the control plane** at project creation: Postgres superuser and `authenticator`
  passwords, JWT secret and signing keys, legacy `anon`/`service_role` keys, publishable/secret API keys,
  admin-port token, replication and pooler passwords, vault key, S3 access keys.
- **Stored** in control-db table `project_secrets` as AES-256-GCM ciphertext: random 96-bit nonce per
  value, additional authenticated data = `<project ref>:<secret name>` (a row cannot be swapped onto
  another project), `key_version` column for rotation.
- **Key:** `SELFBASE_MASTER_KEY` (32 random bytes, base64), created once by `scripts/gen-keys` at
  install, given to the `control` container only, as environment (Coolify env with "Literal" on, or a
  0600 env file). It is never written to control-db or its backups. **AC-10:** direct AES-GCM under one
  master key, no per-project data keys — a few hundred values; re-encrypting all of them on rotation is
  one short transaction. Losing the key loses every stored secret: the guide tells the owner to keep a
  copy offline.
- **Delivered** to project containers as environment at creation (as v1). They are visible to anyone
  with Docker access on the host; that is the same trust boundary as v1 and Coolify.
- **Shown** once where Supabase shows them (API keys page reveals on click through an audited endpoint);
  never in logs, job payloads, audit rows or error messages. Job payloads carry secret *names*.
- **Vault (per project):** `vault.secrets` is encrypted with a per-project key that Postgres reads from a
  file outside the data directory (written by the db entrypoint from env), so database dumps and WAL
  hold ciphertext only. This removes the v1 plaintext shortcut.

### 7.5 Docker access

Two layers. The first is the security boundary; the second limits the damage of a bug in the first.

1. **`provisioner`** — a small internal service, the only component that speaks the Docker API. It has
   no route in Traefik and listens only on the control stack's private network; `control` authenticates
   to it with a shared token. **AC-11: it exposes typed, high-level operations, never a container
   spec:** `ensureProject(ref, templateVersion, size, options)`, `start/stop/remove(ref)`,
   `recreate(ref, service)`, `runJob(ref, jobType, args)` (job types are a fixed enum: backup, restore,
   clone, basebackup, volume-copy, migra-diff), `logs/stats/inspect(ref, service)`, `attachProxy(ref)`.
   It builds every container spec itself from the template and the size table. Reason: a path allow-list
   alone cannot stop `POST /containers/create` with `Privileged`, host PID or a bind mount of `/` — any
   of which is host root. With typed operations a compromised `control` (the internet-facing part) can
   only do what the template allows, to objects named `sb-*`.
   The provisioner never sets `Privileged`, `CapAdd`, host namespaces, devices, or bind mounts (named
   volumes only, plus the fixed host directory for backups if configured).
2. **`socket-proxy`** — `wollomatic/socket-proxy` (rejected: Tecnativa's, which allows by API section and
   cannot scope by name). It is the only container that mounts `/var/run/docker.sock` (read-only mount),
   and it accepts only these method + path patterns from the provisioner's address:
   - `GET /_ping`, `/version`, `/info`
   - `GET /containers/json`, `GET|POST|DELETE /containers/sb-…` (inspect, start, stop, kill, restart,
     wait, logs, stats, remove), `POST /containers/create`
   - `GET|POST|DELETE /volumes/sb-…`, `POST /volumes/create`
   - `GET|POST|DELETE /networks/sb-…`, `POST /networks/create`,
     `POST /networks/<PROXY_NETWORK>/connect|disconnect`
   - `POST /images/create` (pull) for our registry path, `GET /images/…/json`
   - Nothing else: no `exec`, `build`, `commit`, `swarm`, `plugins`, `secrets`, `system/prune`, no
     container, volume or network not named `sb-…`.

   The provisioner always addresses objects by name, which is what makes the name patterns effective.
   No `exec` is needed: one-off work runs as job containers, and `core`'s admin port does in-database work.

Residual risk, stated plainly: a bug in the provisioner's spec builder is still root-equivalent. It is
kept small (target < 1000 lines), has no dependency beyond Node's standard library (plain `fetch` to the
proxy), and gets its own security review task in wave 1.

### 7.6 Control plane

`control` is a Node/Hono service: Studio static files at `/`, the management API at `/v1/*`,
Studio-only endpoints at `/platform/*`.

- **Dashboard accounts** live in control-db's `auth` schema and are handled by core's auth module,
  imported as a library (**AC-12:** dashboard login, password reset, MFA and sessions are the same
  problem core already solves; Supabase's dashboard also runs on its own auth server).
- **Desired state and reconcile.** control-db holds the desired state of every project. A reconcile loop
  (every 30 s and after each change) compares it with what the provisioner reports and converges:
  missing container → create, wrong template version → recreate, detached from proxy network →
  re-attach, should be paused → stop. All long operations (create, upgrade, backup, restore, clone,
  import) are rows in `jobs` with idempotent steps, resumed after a control restart.
- **Admission and limits.** Creating, resuming or resizing a project is refused when
  `shared-stack caps + sum of caps of running projects + job slot > MEMORY_BUDGET × OVERCOMMIT`.
  **CC-2 (was AC-13): `OVERCOMMIT` is 1.0, no overcommit** — the host has no swap and belongs to other
  teams too; a kernel OOM kill there is worse than a refused project. Enforcement is by the kernel:
  every container has `mem_limit` (= `memory.max`), `memswap_limit` equal to it, `cpus`, `pids_limit`.
  Second wall: all selfbase containers are created with `cgroup-parent=selfbase.slice`, and a builder
  runs `systemctl set-property selfbase.slice MemoryMax=16G` once over SSH **after the owner's OK**
  (shared-host rule, section 5). It needs the systemd cgroup driver *(verify in server facts)*; if the
  host uses another driver the slice is skipped and the guide says so.
- **Budget and capacity (16 GB):**

  | Shared stack | Cap MiB |
  |---|---|
  | control 384, control-db 384, provisioner 128, socket-proxy 32 | 928 |
  | imgproxy 384, logs 384, metrics 384 | 1152 |
  | s3 (Garage) 384, dcs (etcd) 256 — from wave 4 | 640 |
  | one job slot (backup/restore/clone run one at a time) | 512 |
  | **Total** | **3232** |

  Left for projects: 13 152 MiB → **11 running micro projects**, or CorteQS as small + HA (3392 MiB)
  plus **8 micro**. Paused projects cost disk only. `OVERCOMMIT` stays a setting, but v2 ships and is
  tested at 1.0.
- **Disk.** Docker volumes have no quota. The control plane samples volume sizes hourly; each project has
  a soft disk limit; at 100 % the project database is set read-only (`default_transaction_read_only`),
  as Supabase does, and the dashboard says why.
- **Per-project admin API.** `control` reaches `core:8081` over the project network with the project's
  admin token. Studio never talks to a project's admin port directly; it calls
  `/platform/projects/<ref>/…`, which authorises the user's role and forwards.
- **Local mode.** `control` can run with auth off and one statically configured project
  (`SELFBASE_LOCAL=1`), bound to 127.0.0.1. `selfbase start` uses this to give developers Studio locally.
  Studio has one code path.

### 7.7 Studio

**AC-14: Studio is our own React app (today's `panel/`), not Supabase Studio.** Supabase Studio is
bound to Supabase's private `/platform` API, postgres-meta and `@supabase/*` packages — adopting it
means implementing those too and violates the anti-goal. The look follows the Supabase dashboard
(organization → project → left navigation) as v1 did. Screens are listed in 8.6.

### 7.8 Management-API-shaped API

- **Rule for planners:** a snapshot of Supabase's published OpenAPI document is vendored at
  `docs/reference/management-api.json`. Every `/v1` route we add must name the `operationId` it
  implements and match its path, method, request and response field names. Fields we cannot fill are
  returned with neutral values (`region: <node name>`), not dropped. Anything with no Supabase
  equivalent goes under `/platform`, never under `/v1`.
- **Auth:** `Authorization: Bearer sbp_…` personal access tokens (stored hashed, shown once); a token
  acts with its user's roles. Studio uses a session cookie on `/platform`.
- **Route groups (all under `/v1`):** `organizations`, `organizations/{slug}/members`; `projects`
  (list, create, get, delete), `projects/{ref}/pause|restore|health|upgrade`;
  `projects/{ref}/api-keys`; `projects/{ref}/config/auth` (+ `signing-keys`, `sso/providers`),
  `postgrest`, `config/database/postgres`, `config/database/pooler`, `config/storage`,
  `config/realtime`; `projects/{ref}/secrets`; `projects/{ref}/functions` (list, get, body, deploy,
  delete); `projects/{ref}/database/query`, `database/migrations`, `database/backups`
  (+ `restore-pitr`); `projects/{ref}/types/typescript`; `projects/{ref}/branches`, `branches/{id}`
  (get, update, delete, push, merge, reset, diff); `projects/{ref}/advisors/security|performance`;
  `projects/{ref}/analytics/endpoints/logs.all`; `projects/{ref}/custom-hostname`;
  `projects/{ref}/ssl-enforcement`; `projects/{ref}/readonly`; `projects/{ref}/read-replicas`;
  `snippets`.
- Where Supabase models a capability as a billing add-on (compute size, PITR), we expose it as a plain
  project setting under `/platform` and do not imitate `/billing`.

### 7.9 CLI

**AC-15: `selfbase` is a TypeScript CLI in the monorepo, shipped as one bundled file (`npx selfbase`),
and it works over the management API only — it never needs a database port.** Reason: same language as
the rest, shares the type generator and config parser; no open Postgres port is required on the shared
server.

- It reads the **existing `supabase/` directory unchanged** (`config.toml`, `migrations/`, `functions/`,
  `seed.sql`), so app repositories do not change. Its own state lives in `.selfbase/` (git-ignored).
  The migrations directory is configurable (CorteQS keeps applied files under
  `supabase/migrations/applied/`).
- **Migration history** is Supabase's table `supabase_migrations.schema_migrations
  (version, name, statements)`. v1's `scripts/sync.mjs` history is converted to it by a platform
  migration and `sync.mjs` is retired in favour of `selfbase db push` (which keeps sync's behaviour:
  apply in order, stop at the first failing migration, never edit files, never run `scripts/ops/*`).
- **Commands, core set (wave 2):** `login`, `logout`, `init`, `link`, `unlink`, `projects
  list|create|delete|api-keys`, `orgs list`, `start`, `stop`, `status`, `migration new|list|up|repair`,
  `db push|pull|diff|reset|dump`, `functions new|serve|deploy|delete|list|download`,
  `secrets set|list|unset`, `gen types typescript`, `config push`.
  **Later waves:** `branches …`, `backups list|restore` (wave 4); `migration squash`, `db lint`,
  `inspect db`, `test db` (pgTAP), `storage ls|cp|rm`, `sso`, `domains`, `snippets`, `postgres-config`
  (wave 5).
- `start`/`stop`/`db reset`/`functions serve`/`migration up` use a **local stack**: the template compose
  file plus `control` in local mode, run with the developer's Docker, images built locally (CC-1).
- Server-side operations exist as control-plane API actions first; the CLI is a client of them. In
  particular `projects import`/`export` are `/platform` jobs with a Studio form in wave 1 (section 10),
  and the CLI commands of wave 2 only wrap them.
- `db diff` and `db pull` compare schemas with **migra** in a one-shot container (the supabase CLI's
  default engine; rejected: Stripe's pg-schema-diff, which does not cover policies, functions and views
  the same way). Against a linked project the diff runs server-side as a provisioner job.
- `gen types typescript` output must be byte-compatible in shape with Supabase's `Database` type. The
  generator is our own code in `core` (admin port), since postgres-meta is excluded.

**What pointing the real `supabase` CLI at selfbase needs later (not in v2):**
1. A CLI profile that sets the API URL, dashboard URL and project host to ours (the CLI has had custom
   profiles since 2025 *(verify the mechanism at that time)*).
2. Already satisfied by v2: `sbp_` token format, 20-letter refs, `<ref>.<host>` project hosts, `/v1`
   paths and shapes, `supabase_migrations.schema_migrations`, source-upload function deploys.
3. Direct database access: the real CLI's `db` commands connect to Postgres with the database password
   — the project's external database port (8.9) must be enabled, and the roles the CLI expects
   (`supabase_admin`, `cli_login_postgres`, …) must exist with compatible rights.
4. Service version endpoints the CLI queries on `link` (auth health, storage version, PostgREST root).
5. The `/v1` operations the CLI calls that v2 did not need for its own CLI (found by running the CLI's
   test suite against us) — an extension list, not a redesign.
6. Not solvable by us: `supabase start` runs Supabase's own images locally and bundling with
   edge-runtime; teams would keep `selfbase start` for local work.

## 8. Design per area

### 8.1 Client compatibility

v1 wrote `selfbase-js` against the methods CorteQS calls and invented its own realtime protocol.
"App code unchanged, nothing missing" cannot be reached that way.

**AC-16: the server becomes wire-compatible with Supabase's HTTP and WebSocket protocols, and that is
proven by running the real `@supabase/supabase-js` (pinned, devDependency, tests only) against a project
stack in CI — the conformance suite.** Reason: an objective, automatable definition of parity; it also
makes other Supabase clients and the later real-CLI step work.

**AC-17: `selfbase-js` reaches the full surface by vendoring the MIT sources of auth-js, storage-js,
realtime-js and functions-js at the pinned version** (as postgrest-js in v1), with our fetch layer and
no telemetry. Reason: rewriting ~10k lines of client that must behave identically is waste; a copy has
no runtime dependency on the company. Apps keep using the build alias from v1.

**Parity reference:** supabase-js pinned at the version current when wave 3 starts (v1 used 2.108.2),
plus the route lists of GoTrue, storage-api and realtime at the same date. Every public method of the
pinned client either passes a conformance test or is on a written exclusions list with a reason
(non-goals in section 3). Deviations from Supabase behaviour that v1 chose on purpose (REHBER 8.5:
re-signup with a different password, PDF handling, function response CSP) stay and are listed there.

### 8.2 Auth (in `core`, GoTrue-compatible routes under `/auth/v1`)

Present in v1: password sign-up/in, email confirm, recovery, magic link (link only), email change,
Google OAuth (implicit flow), phone change through a send-SMS hook (off), refresh rotation, admin
list/delete, in-memory rate limits.

Added in v2 — all are Supabase features:

| Area | Design |
|---|---|
| PKCE | `auth.flow_state`; `code_challenge` on authorize/signup/otp/recover; `POST /token?grant_type=pkce`. Implicit stays. |
| Anonymous sign-in | `POST /signup` with no credentials, `is_anonymous` claim and column; converting by `updateUser` / link identity. |
| Email OTP codes | 6-digit code next to the link (`{{ .Token }}` in templates), `verifyOtp` types `email`, `signup`, `recovery`, `invite`, `email_change`, `magiclink`; invite; reauthentication nonce. |
| OAuth providers | **AC-18: one generic OAuth2/OIDC engine driven by a provider table** (authorize/token/userinfo URLs, scopes, claim mapping) covering Supabase's list — Apple, Azure, Bitbucket, Discord, Facebook, Figma, GitHub, GitLab, Google, Kakao, Keycloak, LinkedIn (OIDC), Notion, Slack (OIDC), Spotify, Twitch, Twitter/X, WorkOS, Zoom, Fly — with per-provider quirks as small overrides (Apple's signed client secret, Twitter's PKCE). Reason: twenty hand-written providers are twenty places for bugs. `signInWithIdToken` verifies an OIDC ID token against the provider's JWKS. |
| Identity linking | `linkIdentity`, `unlinkIdentity`, `getUserIdentities`; automatic linking by verified email as GoTrue does; manual linking behind a setting. |
| MFA | TOTP and phone factors: `auth.mfa_factors`, `mfa_challenges`, `mfa_amr_claims`; enroll/challenge/verify/unenroll; `aal` and `amr` claims; admin factor delete. |
| Phone auth | Sign-up/in with phone + OTP; SMS through built-in senders (Twilio, Twilio Verify, MessageBird, Vonage, Textlocal) or the v1 send-SMS hook. |
| SSO / SAML 2.0 | `auth.sso_providers`, `sso_domains`, `saml_providers`, `saml_relay_states`; SP metadata and ACS endpoints; `signInWithSSO`. Uses `@node-saml/node-saml` for XML signature validation (**AC-19:** never hand-write XML-DSig; this is the standard Node library). |
| Auth hooks | Custom access token, send email, send SMS, MFA verification attempt, password verification attempt, before user created — each as a Postgres function or an HTTPS endpoint (Standard Webhooks signature, as v1's SMS hook). |
| JWT and keys | Asymmetric signing keys (ES256/RS256) with rotation, JWKS at `/auth/v1/.well-known/jwks.json`, `getClaims`; HS256 legacy secret stays (CorteQS). New-style `sb_publishable_…` / `sb_secret_…` API keys: `core` (the gateway) resolves them to a short-lived role JWT before forwarding to PostgREST. |
| Security settings | Password strength rules, leaked-password check (HIBP k-anonymity), CAPTCHA verification (hCaptcha, Turnstile), session timebox / inactivity timeout / single session, ban takes effect on the next request (session check), `auth.audit_log_entries`. |
| Admin API | Full `/admin/users` CRUD, `generate_link`, invite, factors, SSO providers. |
| Rate limits | Counters move to an unlogged table in the project database (token bucket in one SQL function); limits are project config. **AC-20:** survives the container recreation that every config change causes; one core per project makes Redis pointless. |
| Tail (wave 5) | Web3 sign-in (Solana, Ethereum), OAuth 2.1 server, WebAuthn/passkey factors — only if the pinned supabase-js exposes them as stable at that time. |

### 8.3 Realtime and Storage

**Realtime** (`/realtime/v1/websocket`):

- **Protocol:** Phoenix channels as realtime-js speaks them (join with `config`, `phx_reply`,
  heartbeat, `access_token`, `postgres_changes`, `broadcast`, `presence_state`/`presence_diff`,
  `system`). v1's own protocol is removed; there is no dual-protocol period because the only client of
  it (the unmerged CorteQS branch) updates its vendored client in the same wave.
- **postgres_changes via logical replication.** `core` opens one replication connection per project with
  the `pgoutput` plugin on publication `supabase_realtime` (`wal_level=logical` is already set in v1).
  **AC-21: the slot is temporary** — it disappears with the connection, so a stopped core can never make
  Postgres retain WAL until the disk is full; realtime gives no delivery guarantee across reconnects at
  Supabase either. Per-table triggers and `selfbase.enable_realtime` are dropped by a platform
  migration; "add table to publication" is the only switch, tables need no `id` column, old records
  follow `REPLICA IDENTITY`.
- **RLS:** unchanged idea from v1 — for each change, `core` checks visibility as each subscriber's role
  and claims by primary key before sending; subscribers with identical claims are checked once. DELETE
  sends primary-key columns only when RLS is on (Supabase's behaviour). Filters: `eq, neq, lt, lte, gt,
  gte, in`.
- **Broadcast and Presence** live in `core`'s memory (one core per project, so no clustering).
  Broadcast also over HTTP (`POST /realtime/v1/api/broadcast`) and from the database:
  `realtime.messages`, `realtime.send()`, `realtime.broadcast_changes()`, picked up from the same
  replication stream.
- **Authorization:** private channels are checked against RLS policies on `realtime.messages` with
  `realtime.topic()`, as Supabase does.
- **Limits** (channels per connection, joins and events per second, payload size, presence keys) are
  project config with Supabase's defaults.

**Storage** (`/storage/v1`):

| Gap | Design |
|---|---|
| Full object API | `move`, `copy`, `update`, `info`, `exists`, `createSignedUrls`, signed upload URLs, list v2 with search and sort, bucket CRUD with size and MIME limits. Uploads are streamed to disk (removes v1's in-memory 50 MB shortcut). |
| Resumable uploads | TUS at `/storage/v1/upload/resumable` using `@tus/server` (the reference implementation; storage-api uses it too). |
| Image transformations | `/render/image/{public,authenticated,sign}/…` and `transform` options. `core` authorises the request, then calls **imgproxy** — what Supabase uses — with a signed imgproxy URL whose source is a one-minute internal signed URL on that project's core. **AC-22: one shared imgproxy in the control stack**, not one per project: it is stateless and idle most of the time; per project it would cost ~100 MB each. Rejected: `sharp` inside core (native memory spikes inside a 256 MB container). |
| S3 protocol | `/storage/v1/s3`: SigV4 with per-project access keys (and session-token mode that applies RLS), object CRUD, ListObjectsV2, multipart upload. Own code in core; rejected: putting MinIO/Garage in front, because objects must stay governed by `storage.objects` and RLS. |
| Backend | A storage backend interface with `file` (default, the volume) and `s3` (any S3-compatible store). The `s3` backend is what makes a second server possible: files on a local volume do not follow a database failover. |

### 8.4 Database features

| Feature | Choice | Why / rejected alternative |
|---|---|---|
| GraphQL | **pg_graphql** compiled into the db image at a pinned tag; `/graphql/v1` is forwarded by core to PostgREST `rpc/graphql` (schema `graphql_public`), exactly Supabase's wiring. GraphiQL in Studio. | It is what Supabase uses; ~0 MB when unused. Rejected: PostGraphile/Hasura — different schema shape, another service per project. Cost: a Rust (pgrx) build step in CI. |
| Queues | **pgmq** (SQL-only install) + `pgmq_public` wrapper functions exposed through PostgREST as Supabase does. | Standard; no service. |
| Cron | `pg_cron` (already there) + Studio screen (jobs, run history from `cron.job_run_details`). | — |
| HTTP from SQL | Keep v1's `net` shim (queue table + worker in core) and complete it: `net.http_delete`, `net._http_response`, percent-encoded params, concurrent sending. | `pg_net` was excluded in v1 and the shim works; the rule "a copy never calls production" lives in this worker. |
| Database webhooks | `supabase_functions.http_request()` trigger function + `supabase_functions.hooks` log, built on the `net` shim; Studio screen creates the triggers. | Supabase's own mechanism, so existing migrations that create webhooks apply unedited. |
| Vault | `vault.secrets` / `decrypted_secrets` / `create_secret` / `update_secret` with real encryption (7.4). | Replaces v1's plaintext shim. Rejected: `supabase_vault` + pgsodium (extra extensions for the same result). |
| Extensions | From PGDG packages: pg_stat_statements, pgaudit, pg_repack, hypopg, pgtap, plpgsql_check, pg_partman, pgrouting, http, pg_hint_plan, rum (plus v1's PostGIS, pgvector, pg_cron, pg_trgm, unaccent, pgcrypto, uuid-ossp). From source: pg_graphql, pg_jsonschema. Studio "Extensions" toggles them. | Covers what Supabase ships for PG 17 that has a package or a small build. Left out: `wrappers`, `pgsodium`, `pg_net`, `index_advisor` (tail). |
| Compat roles | NOLOGIN roles that Supabase dumps and migrations reference (`supabase_admin`, `supabase_auth_admin`, `supabase_storage_admin`, `dashboard_user`, `supabase_realtime_admin`, …) so `GRANT`/`ALTER … OWNER` statements in unedited migrations succeed. | Extends v1's `40-compat.sql`. |

### 8.5 Functions

- **Deploy:** the CLI or Studio uploads a function's source files (the management API's multipart
  `functions/deploy` shape) → `control` → `core:8081` → written to the project's `functions` volume as
  `<slug>/<version>/…` and switched atomically. Metadata (`verify_jwt`, entrypoint, import map, hash) is
  stored in control-db and in a manifest on the volume, so the project still starts with control down.
- **Isolation (AC-23): each function runs in its own Deno Worker** inside the `fn` container, started on
  first request and terminated on redeploy or idle. Reason: v1 imports every function into one process
  and cannot unload a module, so a redeploy would need a container restart, and one function's global
  state leaks into another. Rejected: Supabase's edge-runtime (excluded service image). Known
  difference: memory is capped per project (`fn` container), not per function.
- Per-function `deno.json` / import map is honoured (removes a v1 shortcut). `EdgeRuntime.waitUntil` is
  provided. Wall-clock limit and request body limit are project config.
- **Secrets:** function secrets are project secrets of kind `function`; set/unset recreates `fn`.
  `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_URL` (through the
  pooler, off by default as in v1) are provided.
- **Logs:** each console line is emitted as JSON with the function slug and request id (8.7).
- v1's "functions are read from the team's repository checkout on the host" is replaced by
  `selfbase functions deploy` from that repository; the import-map redirect of
  `esm.sh/@supabase/supabase-js` to `selfbase-js` stays.

### 8.6 Studio screens

Organization level: projects, members and roles (Owner, Administrator, Developer, Read-only; optional
project scope), access tokens, audit log, server capacity (budget, per-project use).

Project level — **exists in v1** / new:

| Group | Screens | Wave |
|---|---|---|
| Home | Status, URLs, keys, recent activity | 1 |
| Table editor | **Tables**, row drawer; schema visualizer | 1 / 5 |
| SQL | **Editor** with CodeMirror, saved snippets, results export | 1 / 2 |
| Database | Functions, triggers, enumerated types, extensions, indexes, publications, roles, **policies**, migrations | 2 |
| Database | Backups (scheduled, PITR), replication/HA, connection strings and pooler | 4 |
| Integrations | Cron, queues, webhooks, vault, GraphiQL | 2 |
| Auth | **Users**, providers, email templates, URL configuration, sessions, rate limits, hooks, MFA, SSO, audit log | 3 |
| Storage | **Files**, bucket settings, policies, S3 keys | 3 |
| Edge functions | List, detail (code view, invocations, logs), secrets | 2 |
| Realtime | Inspector (join a channel, watch and send messages), settings, policies | 3 |
| API docs | Generated from PostgREST's OpenAPI: tables, RPCs, snippets; type download | 2 |
| Logs | Per-service log views; explorer with saved queries | 1 (basic) / 5 |
| Reports | API, database, auth, storage, realtime charts | 5 |
| Advisors | Security and performance lints; query performance (pg_stat_statements) | 5 |
| Branches | List, create, diff, merge, delete | 4 |
| Settings | General, API keys and JWT signing keys, database, compute size, custom domain, pause/restore/delete | 1–4 |

Advisors: the lint set is Supabase's **splinter** (Apache-2.0, a list of SQL queries), vendored with its
licence and run through the admin port; results use the same lint names so Supabase's documentation for
each lint applies.

### 8.7 Observability

| Need | Choice | Rejected |
|---|---|---|
| Collect container logs | **Docker's `syslog` logging driver**, set per container by the provisioner, sending to the log store's listener on 127.0.0.1 (async mode, so a stopped store never blocks a container). Docker's local cache keeps `docker logs` working. **AC-24:** no log shipper and no second consumer of the Docker socket. | Vector/Promtail/Fluent Bit reading the socket (would see every team's containers). |
| Store and query logs | **VictoriaLogs**, one shared container, retention by days and by disk size. Services log one JSON object per line (`svc`, `project`, `request_id`, level, method, path, status, latency, …). | Loki (+ Grafana; heavier, object-store oriented); ClickHouse (≥ 1 GB); Supabase's Logflare (excluded); rows in control-db (write load and bloat on the database that holds our secrets). |
| Metrics | `core` exposes Prometheus text on the admin port: its own counters plus database statistics it queries (connections, sizes, cache hit, replication lag). Container CPU/memory come from the provisioner's `stats`. **VictoriaMetrics** (shared, single binary) scrapes and stores. Each project also serves Supabase's metrics endpoint path with service-role basic auth. | Prometheus (more memory for the same job); a `postgres_exporter` per project (another container each). |
| Health and alerts | Reconcile loop + container health → project status in Studio; optional e-mail to org owners on unhealthy, disk and memory thresholds. | — |

Known difference: the logs explorer speaks LogsQL, not Supabase's SQL dialect. Studio offers the same
canned queries per service so most use never touches the query language.

### 8.8 Backups, PITR, HA

**Backups (all projects).** Daily logical backup as in v1 (`pg_dump -Fc`, globals, storage archive,
MANIFEST), run as a provisioner job, one project at a time, retention per project. Destination is an
S3-compatible bucket (from wave 4; a host directory before that). control-db is backed up by the same job.
Restore = a job that restores into the same project or **into a new project** (the safe default).

**PITR (per project, opt-in — as at Supabase).**
- **Tool: WAL-G** (`archive_command` → `wal-push`, daily `backup-push`, `backup-fetch` +
  `restore_command` → `wal-fetch`, retention by `delete retain`). **AC-25:** it is what Supabase runs,
  one static binary, S3-native. Rejected: pgBackRest — richer (verification, block-incremental), but
  its maintenance outlook was uncertain in 2026 *(verify at wave 4 start; if it is healthy and WAL-G is
  not, swap — the design does not depend on which)*.
- **Store: Garage**, one shared container, a bucket and key pair per project. **AC-26:** the single-server
  test must exercise the real S3 code path, so that an external S3 later is an endpoint and key change.
  Rejected: MinIO (community edition was reduced to maintenance mode in 2025), SeaweedFS (heavier),
  a plain directory (would leave the S3 path untested).
- **Restore to a time:** job stops the stack, restores base backup + WAL up to `recovery_target_time`
  into a **new** pgdata volume, starts on it, keeps the old volume for 7 days. Storage objects are not
  rewound (same as Supabase).
- Honest limit: on one server, Garage is on the same disk as the data. It protects against mistakes and
  corruption, not against losing the server. The guide says so until an external S3 is configured.

**HA (per project, opt-in).**
- **Tool: Patroni** inside the db image, with **etcd** as its store — one shared single-node etcd in the
  control stack, one key prefix per project. **AC-27:** failover is the worst place for hand-written
  logic; Patroni is the standard and also handles replica creation, `pg_rewind` and switchover.
  Rejected: failover driven by our control plane (puts the control plane in the data path and reinvents
  fencing); pg_auto_failover and repmgr (smaller communities, same number of moving parts).
  `failsafe_mode: true` is required so a stopped etcd does not demote a healthy primary. Cost: ~50 MB
  per database container, inside its cap.
- **Topology:** `sb-<ref>-db` and `sb-<ref>-db2` (own volume), asynchronous streaming replication by
  default, synchronous as a project setting.
- **Routing:** `sb-<ref>-dbproxy` (HAProxy, TCP) takes over the network alias `db`, health-checks
  Patroni's REST API, and sends `db:5432` to the current primary and `db:5433` to replicas. `rest`,
  `core`, `pooler` keep connecting to `db` and need no HA awareness; core's realtime replication
  connection simply reconnects (temporary slot). **AC-28:** the standard Patroni pattern and it keeps
  failover independent of the control plane.
- **Turning HA on** for a running project: recreate `db` in Patroni mode on the existing data directory
  (seconds of downtime), create the replica from a base backup, insert `dbproxy`.
- **Second server later = configuration:** `nodes` is a table from wave 1 (Docker endpoint through that
  node's socket proxy over a private link, advertised address). Every database member is addressed by an
  *advertised address*, which is a container name on one host and `node-ip:published-port` with TLS
  across hosts. Moving to two servers is: add the node, set the replica's node, run etcd on three
  members, point WAL-G and the storage backend at an S3 both servers reach. **Not solved by software:**
  the public hostname must reach the surviving server (floating IP or DNS failover); the stateless
  services are started on the surviving node by the control plane or by a second control instance — the
  guide describes this as the later step, it is not built or tested in v2.

### 8.9 Pooler and external database access

- **PgBouncer** per project, transaction pooling. **AC-29:** ~10 MB, the standard; Supavisor is an
  excluded Supabase service built for many tenants behind one endpoint, which architecture A does not
  have. Internal services keep direct connections (PostgREST and core pool themselves; LISTEN and
  replication need a real session). Functions that are given `SUPABASE_DB_URL` get the pooler.
- **CC-3: external Postgres access is supported, off by default, per project, from a configurable port
  range.** When enabled, the provisioner publishes two host ports from `DB_PORT_RANGE`: the pooler
  (Supabase's 6543 role) and the direct/session port (Supabase's 5432 role); it checks the port is free
  on the host first. **AC-30: host ports, not Traefik TCP routing** — routing Postgres by SNI needs
  new entrypoints on `coolify-proxy`, which we may not configure.
- TLS: the control plane runs a small internal CA; each project gets a server certificate; clients use
  `sslmode=require`, or `verify-full` with the CA certificate downloadable in Studio (as Supabase's).
- With a replica, the pooler also offers a read-only database alias routed to `db:5433`.

### 8.10 Branching

With architecture A a branch is a **child project**: own stack (micro), own ref, URL and keys, a
`parent_project_id` and `branch_name` (optionally `git_branch`). The parent is the default branch.

- **Create** (job): new stack → restore a **schema-only** dump of the parent, plus the rows of
  `supabase_migrations.schema_migrations`, bucket definitions (no objects), auth configuration → apply
  `supabase/seed.sql` if the CLI supplied one → copy the parent's deployed functions. Option
  `--with-data` does a full dump/restore and copies storage objects.
  **AC-31: clone the schema rather than replay migrations** — CorteQS's migration history cannot run
  from an empty database (it starts from a baseline dump), and a clone is exact.
- **A branch must not reach production:** function secrets, SMTP and OAuth provider secrets are *not*
  copied (e-mail is auto-confirmed and written to the log instead of sent); `cron` jobs are restored
  disabled; URLs of the parent inside the database and the `net` queue are rewritten to the branch's
  host by the v1 migrate scripts (05, 06), which already do this for `*.supabase.co`.
- **Diff and merge:** diff = migra between branch and parent. Merge = apply the migrations present in
  the branch's history but not the parent's, in order, each in a transaction, then deploy changed
  functions; refuses if the parent has migrations the branch lacks (rebase first: `branches reset`).
- **Lifecycle:** ephemeral branches auto-pause after a configurable idle time and are deleted by
  `branches delete` (or a CI job on PR close); persistent branches are not auto-paused. Admission
  control bounds how many run.
- **Hostnames while on sslip.io:** a branch does not get a fresh hostname; it takes one of
  `BRANCH_HOST_SLOTS` reusable hosts (default 2), whose certificates are issued once and kept (7.3).
  Creating a branch when all slots are taken is refused. `BRANCH_HOST_SLOTS=0` disables branching; on a
  real domain the setting is lifted and branches get `<ref>.<BASE>` like any project. Branch keys and
  ref are still unique per branch — only the hostname is recycled, so a deleted branch's clients get
  401 from its successor, not its data.
- API: Supabase's `/v1/projects/{ref}/branches` and `/v1/branches/{id}/…`. No GitHub App.

**Pause / restore / export / import** use the same machinery: pause = stop containers, keep volumes;
`selfbase projects export` = logical backup + a project manifest (config, and secrets re-encrypted under
a passphrase the operator types); `import` creates a project from one. Import is also how a project
moves to the owner's own server and how a v1 install is adopted.

## 9. Control-plane data model (control-db)

One Postgres (our db image, 384 MB cap). Dashboard users are in the `auth` schema (core's tables).
Schema `control`:

| Table | Key columns | Notes |
|---|---|---|
| `organizations` | id, slug, name | |
| `memberships` | org_id, user_id, role, project_id null | role ∈ owner, administrator, developer, read_only; project_id narrows it |
| `invitations` | org_id, email, role, token_hash, expires_at | |
| `access_tokens` | user_id, name, token_hash, last_used_at, expires_at | `sbp_…`, shown once |
| `nodes` | name, docker_endpoint, advertise_addr, proxy_mode, proxy_network, memory_budget_mb | one row today |
| `projects` | ref (unique), org_id, name, status, size, node_id, template_version, subnet, parent_project_id, branch_name, git_branch, persistent, ha_enabled, pitr_enabled, db_port, pooler_port, disk_limit_mb, paused_at, last_activity_at | status uses Supabase's names (`COMING_UP`, `ACTIVE_HEALTHY`, `INACTIVE`, `RESTORING`, `UPGRADING`, `REMOVED`, …) |
| `project_domains` | project_id, hostname, kind | default, custom, legacy |
| `host_slots` | hostname, pool, project_id null, first_issued_at | pool ∈ project, branch, test; a row with null project_id is a free, already-certified host (7.3) |
| `project_secrets` | project_id, name, kind, ciphertext, nonce, key_version | kind ∈ platform, function |
| `project_config` | project_id, section, data jsonb, version, updated_by | sections: auth, postgrest, storage, realtime, database, pooler, functions; non-secret values only |
| `api_keys` | project_id, type, name, prefix, hash, revoked_at | legacy_anon, legacy_service_role, publishable, secret |
| `functions` | project_id, slug, version, verify_jwt, entrypoint, import_map, sha256, status | source lives in the project's volume |
| `backups` | project_id, kind, status, started_at, finished_at, size_bytes, location, lsn | logical, physical |
| `jobs`, `job_events` | type, project_id, status, step, payload, error, attempts, created_by | payload never contains secret values |
| `snippets` | project_id, owner_id, name, sql, visibility | |
| `audit_log` | actor, org_id, project_id, action, target, ip, at, details | every write through `/v1` and `/platform` |
| `settings` | key, value | base domain, budget, overcommit, port range, subnet pool, registry |

Rule: everything a project needs **at run time** is in the project (its database, volumes, container
environment). control-db holds desired state, metadata and secrets. If control-db is lost, projects keep
running and it is rebuilt from its backup plus the master key.

## 10. How CorteQS becomes project #1

The existing install is a Coolify compose resource (v1 `compose.yml`, branch `v1`), with Coolify-named
volumes and its secrets in Coolify's environment. Its database is empty today, but the procedure is
written for a populated one because it is the general "adopt a v1 install" path.

**Decision (AC-32): migrate, do not keep two modes.** After wave 1 a production install always runs
under the control plane. The template remains runnable with plain `docker compose` for local work and
tests, and the `v1` branch stays deployable until the cutover below is confirmed. Reason: two production
modes would mean two panels, two upgrade paths and two guides.

**Import without the CLI (CC-4).** The CLI arrives in wave 2, so import is a control-plane job from
the start: `POST /platform/projects/import` (name, size, a backup directory name inside the configured
host backup directory, and the v1 env file as an upload) with an "Import project" form in Studio. The
provisioner job mounts the backup directory read-only, so nothing large is uploaded. Wave 1 also ships
`scripts/import-project.mjs`, a thin HTTP client of that endpoint for use over SSH; it reads the env
file locally and prints no values. `selfbase projects import` in wave 2 wraps the same endpoint.

Cutover (end of wave 1, run by a builder over SSH, each step in the guide):
1. Control stack is deployed and has created and destroyed a throw-away project on the server.
2. Take a backup of the v1 install with v1's own `backup.sh` (its tested path) into the host backup
   directory. Then import (form or script):
   - creates project #1 (size small) with a new 20-letter ref, **reusing** the v1 `JWT_SECRET`,
     `ANON_KEY`, `SERVICE_ROLE_KEY` and auth/SMTP/Google settings from the env file (sent over TLS,
     stored encrypted, never printed or logged) so existing app builds and tokens stay valid;
   - restores with v1's `restore.sh` logic; core then applies platform migrations.
3. Verify on `<ref>.<BASE>`: health, a login, a file download, the acceptance suite (section 11).
4. Switch the old hostname, **after the owner's OK** (shared-host rule): stop the v1 resource in
   Coolify, then add `selfbase-corteqs.<host>.sslip.io` to project #1 as a `legacy` domain. Order
   matters: two routers must not claim one host. The host's existing certificate is reused.
5. Rollback until the owner deletes the v1 resource: remove the legacy domain, start the v1 resource;
   its volumes were never touched.

The app side changes nothing at cutover. Later waves change what the app *can* use, not what it must.

## 11. Waves

Every wave ends with: all tests green in CI; deployed on the shared server; the **acceptance suite**
green; memory of the control stack and of one idle micro project measured and recorded;
`docs/REHBER.md` updated in Turkish for everything the wave added; no change to any container, network
or volume that is not ours (checked by listing them before and after).

**Acceptance suite (CC-5).** Two parts, both run by builders:
1. Our own parity and smoke suite in the selfbase repository, run against a project on the server. From
   wave 3 it includes the conformance tests that drive the real `@supabase/supabase-js`.
2. The CorteQS unit tests on the local worktree `D:\Dev\corteqsemir-wt\selfbase` (branch
   `selfbase/client-swap`), pointed at the project where a test needs a backend.

Nothing is pushed to the CorteQS repository and no PR is opened without the team's approval. What a
wave needs on the CorteQS side (vendored client update, build environment, CSP origins, new URLs) is
delivered as commits on that **local branch plus a written handoff** for the team
(`docs/handoff/wave-N-corteqs.md` in the selfbase repository: what changed, why, how to verify).

**Wave 1, task 1 — server facts.** Before anything is built, a builder reads from the server
(read-only) and records in this file: proxy network name, Traefik entrypoint and certificate-resolver
names and Traefik version; Docker version, cgroup driver and version; Coolify's cleanup/prune filters;
Docker networks and subnets in use (to choose `PROJECT_SUBNET_POOL`); free ports for `DB_PORT_RANGE`;
the ACME log's view of sslip.io rate limits. Every server-side *(verify)* in this document is closed
here; a fact that contradicts the design stops the wave and goes to the controller.

**Wave 1 — Control plane and project #1.** Monorepo; CI images in the registry; control, control-db,
provisioner, socket proxy; template v2 (admin port, platform migrations, pooler, sizes, syslog driver);
routing on `coolify-proxy` and own-Traefik mode; secrets encryption; organizations, members, roles,
access tokens; admission and limits; reconcile and jobs; Studio shell with the five v1 screens, project
home, settings, basic per-service logs (VictoriaLogs); `/v1` projects, api-keys, health, pause/restore,
database/query; export/import as `/platform` jobs with a Studio form and `scripts/import-project.mjs`;
hostname slots and the new-host cap; CorteQS cutover.
*Proves:* a project is created from Studio in under two minutes without Coolify; two projects cannot
reach each other; with the control stack stopped every project still serves; the provisioner refuses
anything outside the template (security review task); CorteQS runs as project #1; the whole wave
requested at most `MAX_NEW_HOSTS_PER_WEEK` new certificates.
*Own-Traefik mode (CC-6)* is proven on the owner's Windows machine with Docker Desktop: the control
stack with `PROXY_MODE=own` creates two projects, routes them by host on `*.localhost`, and after
`docker restart` of our Traefik the routes return by themselves. **Not proven there:** public ACME
issuance and renewal (no public DNS; Traefik serves its default certificate), binding 80/443 on a
Linux host with a firewall, the systemd slice, and behaviour next to another proxy. Those remain
first-time steps on the owner's real server and the guide marks them as such.

**Wave 2 — CLI, functions and database features.** `selfbase` CLI core set and local stack; `/v1`
migrations, functions, secrets, types, config; function deploy with worker isolation and logs;
`supabase_migrations` history and retirement of `sync.mjs`; pg_graphql, pgmq, webhooks, vault
encryption, `net` shim completion, extensions; external database access with TLS; Studio: database,
integrations, edge functions, API docs, SQL snippets.
*Proves:* the CorteQS repository's daily workflow (new migration, push, deploy a function, set a secret,
generate types) works with `selfbase` in place of `supabase`, with no file in `supabase/` edited;
a GraphQL query and a queue round-trip pass through the public URL.

**Wave 3 — Auth, Realtime, Storage wire parity.** Everything in 8.1–8.3; conformance suite; full
`selfbase-js`; Studio auth, storage and realtime screens. The three areas are independent and can be
built in parallel.
*Proves:* the unmodified, pinned `@supabase/supabase-js` passes the conformance suite against a project;
the CorteQS app passes its tests with both the real client and `selfbase-js`; exclusions list is written
and every entry has a reason.

**Wave 4 — Data safety and lifecycle.** Garage; WAL-G and PITR; backups to S3 and restore-to-new-project;
Patroni, etcd, dbproxy, HA switch; storage `s3` backend; branching (create, diff, merge, auto-pause);
Studio backups, replication, branches; CLI `branches`, `backups`.
*Proves, on the one server:* killing the primary container during a write load → writes resume through
the same connection string within 60 s, and with synchronous mode no acknowledged commit is lost;
restore to a timestamp between two known writes lands exactly between them, into a new project;
a replica configured with advertised `host:port` + TLS addressing (the cross-server path) on the same
host stays in sync — the rehearsal for "second server is configuration"; a branch of CorteQS is created
on a branch host slot, changed, diffed and merged, and provably sends nothing to the parent's URLs;
a second branch reuses the first one's host without a new certificate. Killing containers and other
disruptive steps are done on `sb-*` containers of a test project, never on project #1 without the
owner's OK.

**Wave 5 — Observability, advisors, completion.** VictoriaMetrics and reports; logs explorer; advisors
(splinter) and query performance; disk limits and read-only mode; alerts; remaining Studio screens;
CLI tail; auth tail (if stable upstream); hardening pass (dependency audit, rate limits on `/v1`,
backup of control-db restore drill); full rewrite pass of `REHBER.md` including the "move to your own
server" drill; a written real-CLI readiness report (7.9 list checked against the then-current CLI).
*Proves:* an operator diagnoses a failing function and a slow query from Studio alone; the parity
checklist (section 8 tables + exclusions) has no unexplained gap.
*Move drill (CC-6):* following the guide alone, the control stack is installed on the owner's Windows
machine (Docker Desktop, `PROXY_MODE=own`), a project is exported from the shared server and imported
there, and the acceptance suite passes against it. This is a real move between two machines.
**Not proven:** the Linux-only install steps (packages, firewall, systemd slice), public DNS and
certificate issuance on the new machine, the DNS cutover of a live app, restore time at production
data size, and HA across two hosts. The guide lists these as steps the owner does for the first time
on the real server, with what to check after each.

Order rationale: wave 1 first because every later feature is delivered *to projects through the control
plane*; wave 2 before 3 because the CLI and platform migrations are the tools the later waves use to
change existing projects; wave 4 after 3 because cloning and PITR must copy the final schemas; wave 5
last because it observes everything else.

## 12. Risks

| Risk | Mitigation |
|---|---|
| Provisioner bug = host root on a shared server | Typed operations only, no bind mounts or privileges, socket proxy allow-list beneath it, small dependency-free code, dedicated security review, tests that assert refusal. |
| Coolify's Traefik names/versions differ from assumed defaults; a Coolify upgrade changes them | Names are settings discovered by read-only inspect; reconcile re-labels by recreating our containers; guide section "after a Coolify upgrade". |
| Coolify cleanup jobs prune our images or stopped containers | Registry images (re-pullable); paused projects are stopped containers with our labels — if a prune removes them, reconcile recreates them from desired state (volumes are never pruned by container prune) *(verify Coolify's prune filters)*. |
| Let's Encrypt limits on sslip.io are shared worldwide and with the other teams on this IP (sslip.io is not on the Public Suffix List); a new project can wait for a certificate, and our issuance uses quota others need | Hostname reuse, weekly new-host cap, fixed branch host pool, `certificate pending` status (7.3); path-based routing as fallback; the real domain removes the problem by configuration. |
| Builders with root on a shared host | Shared-host rule (section 5): only `sb-*`/`selfbase-*` objects and selfbase paths without asking; before/after listing of foreign containers, networks, volumes in every wave's exit. |
| Memory: 16 GB with no swap, caps sum to the budget but another team's spike can still OOM the host | Hard per-container caps, admission at overcommit 1.0, optional systemd slice cap, capacity screen. |
| Wave 3 is large; "parity" can grow without end | Parity is defined by the pinned client + conformance suite + written exclusions; nothing outside that list is in scope. |
| Vendored Supabase client code drifts from upstream | Approved by the owner (AC-16/17, pg_graphql). Version is pinned; an upgrade is a deliberate task that re-vendors and re-runs the conformance suite. |
| Single etcd and single Garage are single points for HA/PITR bookkeeping | `failsafe_mode`; Garage data and etcd are backed up; documented as the one-server limit; three etcd members and external S3 are the two-server step. |
| HA on one host proves the software, not survival of a host loss | Said in the guide and Studio ("replica is on the same server"). |
| WAL-G / pgBackRest / migra maintenance status | Verify at wave start; each is behind a job type, so swapping one does not touch the rest. |
| Logical-replication realtime under heavy write load delays or drops changes | Temporary slot bounds WAL; per-project events-per-second limit; `system` message tells clients about overflow, as Supabase does. |
| Config change = container recreate = dropped WebSockets for seconds | Clients reconnect by design; Studio warns before applying; batch config edits into one apply. |
| Docker `syslog` driver behaviour when the store is down; JSON parsing of syslog bodies in VictoriaLogs | Async mode *(verify)*; fallback is a small relay in the control stack. |
| Control-db or master key lost | Daily backup of control-db; key kept offline by the owner; projects keep running meanwhile; `import` can re-adopt a running project's volumes. |

## 13. Left to the builder

Internal folder layout of each package; HTTP framework details; whether the provisioner and control
share code through a package or duplicate the small template parser; pgoutput decoder (library or own);
exact Phoenix serializer versions to accept (whatever the pinned realtime-js sends); TUS store layout;
imgproxy URL signing details; HAProxy and Patroni configuration files; WAL-G retention commands;
job-step granularity; Studio component library and routing (the v1 hash router will not be enough);
test tooling; exact Postgres settings per size beyond the two given; the conformance suite's structure;
port and subnet allocation algorithm; how the CLI stores its token on each OS; names of internal
environment variables.

Not left to the builder: anything marked AC-n, the anti-goals, the socket-proxy allow-list, the secret
handling rules, the `/v1` shape rule, and each wave's "proves" list.

## 14. Decided, and what still needs the owner

Decided on 2026-11-22: host changes on the shared server are approved (section 5); builders get
SSH/root under the shared-host rule; vendoring Supabase's MIT clients and building pg_graphql is
approved; sslip.io stays for now (7.3); images, memory policy, external ports, proof locations,
acceptance suite and wave-1 import are Controller's calls CC-1…CC-6.

No design question is open. The owner is still needed for these actions, each asked for when its
step comes:
1. Enter the GHCR pull credential on the server once (wave 1).
2. Keep an offline copy of `SELFBASE_MASTER_KEY` (wave 1 install).
3. Say OK before: `systemctl set-property selfbase.slice MemoryMax=16G`; stopping the v1 Coolify
   resource at cutover; any disruptive test on project #1; anything outside `sb-*`/`selfbase-*`.
4. Enter third-party secrets (SMTP, OAuth clients, SMS) in Studio; builders never see them.
5. Take the CorteQS handoff of each wave to the team for approval.
6. Provide the real wildcard domain when it exists (then: one settings change, 7.3).
