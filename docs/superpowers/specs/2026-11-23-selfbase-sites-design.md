# selfbase Sites — frontends on the platform (Wave 6 design)

Date: 2026-11-23 · Status: awaiting owner approval · Builds on: `2026-11-22-selfbase-v2-design.md` (v2)

Reader: a planner who writes the Wave 6 plan from this file. Owner decisions are stated as facts.
Decisions made here are marked **SD-n** with the reason and the rejected alternatives. *(verify)* marks
a fact not checked on the server or upstream; all of them are closed by sub-step 6.0. Section and AC/CC
numbers without a file name refer to the v2 spec.

## 1. Intent

The owner wants one panel that runs everything for many projects — database, auth, storage, functions
**and the frontend** — on his own server, without Vercel or Supabase: lower cost, less exposure,
"build once and lean back". Owner decision: **Wave 6 "Sites"** after wave 5:

- (a) static/SPA sites (Vite/React/Vue; CorteQS today: Vite SPA, nginx, runtime env at `/env-config.js`),
- (b) server-rendered/Node apps (Next.js, Nuxt, Node APIs) as containers,
- (c) per-branch preview deployments,
- git-push deploys, env vars, custom domains with certificates, instant rollback.

This amends one v2 anti-goal: "Features Supabase does not have" gets a single named exception, Sites.
Sites is built so that removing it leaves v2 intact: own tables, own provisioner module, own images,
routes only under `/platform/sites` (never `/v1`), no change to the project template.

**The hard part:** builds and Node apps run tenant code (in practice: thousands of third-party npm
install scripts). They must not reach the host, the Docker socket, `control`, other projects or sites,
or the shared Coolify network.

## 2. Non-goals (Wave 6)

- Dockerfile / image-based deploys, Nixpacks, Railpack, buildpacks (SD-3). Non-Node runtimes.
- Scale-out (one app container per instance), background workers, cron, persistent disks for apps
  (use the project's Storage, queues, cron, functions).
- Per-commit preview URLs, a GitHub App, commit statuses or PR comments written back to the git host.
- Edge/serverless functions per route, an image-optimisation service, a CDN, web analytics.
- Secret masking in build logs (documented: build output is visible to site members).
- bun as a package manager; a site config file in the repository (config lives in control-db, set from
  Studio or CLI).

## 3. Decisions at a glance

| # | Decision |
|---|---|
| SD-1 | A site is its **own resource** (own 20-letter ref, org-owned) with an optional link to one project |
| SD-2 | Source arrives as an **uploaded tarball** (CLI/CI) or by **git webhook + per-site SSH deploy key**; a separate fetch container holds the credential |
| SD-3 | Builds produce a **directory artifact, never an image**: fixed builder image + framework presets (`npm ci && npm run build`) |
| SD-4 | Build sandbox = hardened unprivileged job container on an **internal network with an allow-listing egress proxy**; one build at a time |
| SD-5 | Artifacts are immutable release directories on a per-site volume, written only by our publish job. **No registry** |
| SD-6 | Every instance is fronted by **our nginx `edge` container**; tenant Node code runs in an `app` container that is never on the proxy network |
| SD-7 | Deploy and rollback do not recreate the edge: static = symlink flip, Node = health-checked app swap behind the edge |
| SD-8 | Previews are per-branch instances; on sslip.io they use a fixed, password-protected host pool |
| SD-9 | The provisioner stays one process and one socket path; Sites is a second pure spec builder with its own line budget and review. **The socket-proxy allow-list does not change** |
| SD-10 | Builds share the single heavy job slot, raised to 2048 MiB; sites count against the node budget |

## 4. Model (question 1)

**SD-1: `sites` is a top-level resource in an organization, with `project_id` nullable.**

| Option | For | Against | Decision |
|---|---|---|---|
| Service inside the project stack | One ref, one network, anon key is "right there" | Tenant frontend code would sit on the network of Postgres and the admin port; previews exhaust the /27; pause, upgrade, restore, branch and resize of the project drag the frontend along; the strict template (AC-4) would need per-project variable services; a site without a backend needs a fake project | Rejected |
| A row in `projects` with `kind='site'` | Reuses ref, subnet, membership, jobs columns | Every project query (admission, reconcile, `/v1/projects`, paused router, backups) needs a `kind` filter; one missed filter is a bug in v2's core | Rejected |
| **Own resource, optional project link** | Clean isolation; site lifecycle is independent; a marketing site needs no project; removal leaves v2 intact | New tables; hostname and subnet allocation must look at two owners (section 10) | **Chosen** |

- **Identity:** site ref has the project ref format (`^[a-z]{20}$`), generated against both tables, so
  every v2 name rule holds: containers/volumes `sb-<ref>-…`, network `sb-<ref>`. Site objects carry
  `selfbase.managed=true` and `selfbase.site=<ref>` and **never** `selfbase.project` (v2's
  `listProjects`/`remove` key on that label).
- **Kinds and presets:** `kind` ∈ `static`, `node`. `preset` ∈ `vite`, `static` (any build that emits a
  folder), `prebuilt` (upload a `dist`, no build), `next` (requires `output: 'standalone'`), `nuxt`
  (Nitro `node-server`), `node` (install, optional build, start command). Detected from `package.json`
  on first deploy, then stored and editable: `root_dir`, install/build command, output dir, start
  command, Node major (22 or 24, from `engines`/`.nvmrc`).
- **Project link:** env values may reference `{{project.url}}`, `{{project.anon_key}}`,
  `{{project.publishable_key}}`; linking a project pre-fills rows for the preset
  (`VITE_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_URL`, …). Control resolves them at deploy time from
  `project_domains` and the key store. The **service-role/secret key is never injected automatically**;
  an operator may add it by hand as a runtime-only secret of a `node` site. A static site can never
  hold a secret (Studio refuses `secret` on static sites). If the project's URL or key changes, Studio
  marks the site "env out of date" until redeployed.
- **Previews and branches:** a preview of git branch `x` resolves `{{project.*}}` against the branch
  project whose `git_branch = x` when one exists, otherwise against the `preview` env set (which
  defaults to the linked project). A preview only ever receives `preview`-target env rows.
- **Permissions:** org roles as in v2 (Developer deploys and edits env; Administrator manages domains,
  deploy keys and deletion; Read-only sees deployments and logs, never env values).

**Data (schema `control`):** `sites` (ref, org_id, project_id, node_id, name, kind, preset, size,
status, subnet, repo_url, git_host_key, prod_branch, root_dir, commands, node_major, previews on/off +
branch pattern); `site_deployments` (site_id, target, branch, commit_sha, source ∈ git/upload/rollback/
env, status, release_id, artifact_sha256, size_bytes, pinned, timings, created_by); `site_instances`
(site_id, key `p`/`v1..vN`, branch, deployment_id, last_deployed_at); `site_env` (site_id, name, target,
scope ∈ build/runtime/both, secret, AES-GCM ciphertext with AAD `<site ref>:<name>` as 7.4);
`site_domains` (site_id, instance key, hostname unique, kind ∈ default/custom/redirect/preview);
`jobs.site_id` nullable. Rule kept from v2: everything a site needs to **serve** is in its containers
and volume; control-db holds desired state.

## 5. Build pipeline (question 2)

### 5.1 How source arrives — SD-2

| Option | Decision |
|---|---|
| **Tarball upload** `POST /platform/sites/{ref}/deployments` (multipart, ≤ 100 MB, `.gitignore` applied by the CLI) — `selfbase sites deploy [--branch x] [--prebuilt dir]`, usable from a laptop or any CI | **Chosen, built first.** Works with no git host at all; reuses wave 2's function-upload code |
| **Webhook + deploy key**: `POST /platform/hooks/git/{site id}`, HMAC-verified (`X-Hub-Signature-256` for GitHub, `X-Gitea-Signature` for Gitea *(verify)*); control generates an ed25519 key pair per site, Studio shows the public half to paste as a read-only deploy key; the git host's SSH host key is pinned (GitHub's shipped, others recorded at connect and shown) | **Chosen.** Push to `prod_branch` → production; push to a branch matching the preview pattern → preview; branch delete → preview removed. The payload only selects a ref and SHA of the **configured** repository; a URL in the payload is never used. Same SHA twice = no new build |
| HTTPS + personal/fine-grained token | Rejected: tied to a person and expires — the opposite of "lean back" |
| GitHub App | Rejected (v2 non-goal; binds the platform to one host) |
| `control` runs `git clone` itself | Rejected: the process holding the master key must not parse tenant repositories |

Uploads are held on a `selfbase-uploads` volume of `control` until fetched, then deleted.

### 5.2 What builds it — SD-3

**A fixed builder image runs the preset's commands and the result is a directory.** The serving
containers are our images with that directory mounted read-only — the pattern `fn` already uses.

| Option | Against | Decision |
|---|---|---|
| Dockerfile via rootless BuildKit | Needs `seccomp`/`apparmor` unconfined (or privileged) for nested user namespaces: breaks the provisioner invariants; tenant chooses base image, `USER root`, ports; needs a registry; Coolify's nightly cleanup deletes unused images (15.1) | Rejected |
| Dockerfile via Kaniko | Upstream archived in 2025 *(verify)*; `RUN` steps execute as root in the build container; still needs a registry | Rejected |
| Nixpacks / Railpack / Cloud Native Buildpacks | All end in an image through a Docker or BuildKit API (CC-1: the platform has no build API); Nixpacks is in maintenance mode | Rejected |
| **Presets + plain install/build in our image** | Node ecosystem only; a site needing system packages cannot be built | **Chosen.** Covers CorteQS, Next, Nuxt, Node APIs. Revisit trigger: the first real site that needs a system package — then Dockerfile builds become an own-server-only option under gVisor |

Images (built by CI like every other, pulled by exact name `…/selfbase-site-<x>:<version>`):
`site-build` (Debian slim, Node 22 + 24, corepack for pnpm/yarn, git, compiler toolchain for native
modules), `site-node` (same base, no toolchain, our `run` and `healthcheck` scripts), `site-static`
(unprivileged nginx with one fixed config), `egress` (section 5.4).

### 5.3 The three job containers

A deployment is one job in control's **heavy lane** with idempotent steps; each step is a typed
provisioner job (new enum values; `Cmd` is always a constant path in our image — tenant commands
travel as env to our wrapper, so v2's "no rendered value inside `sh -c`" rule holds):

| Job | Runs | Mounts (named volumes only) | Network | Holds |
|---|---|---|---|---|
| `site-fetch` | **our code**: `git clone --depth 1` of the SHA (hooks off, no submodules, no LFS, `protocol.file.allow=never`) or download + safe untar of the upload | `sb-<ref>-src` rw | git: `selfbase-build`; upload: control network, one-time token URL | deploy key (git mode) |
| `site-build` | **tenant code** under our PID 1 wrapper: install, build | `sb-<ref>-src` rw, `sb-<ref>-cache` rw | `selfbase-build` | build-scope env only |
| `site-publish` | **our code**: validate and copy output → `releases/<id>`, hash, pre-compress, write `env-config.js`, flip `live/<key>`, prune | `sb-<ref>-src` ro, `sb-<ref>-releases` rw | none | public env (static) |

The deploy key never meets tenant code; tenant code never has the releases volume. `site-publish` also
runs alone in `activate` mode (rollback, env-only change) and `prune` mode.

### 5.4 Build sandbox — SD-4

| Option | Decision |
|---|---|
| gVisor (`runsc`) | Best fit, but registering a runtime is a Docker daemon change — forbidden on the shared host (section 5 of v2). **Supported as setting `SITES_RUNTIME=runsc`** for the owner's own server; default `runc` |
| Kata / Firecracker | Needs KVM and daemon changes | Rejected |
| userns-remap / rootless Docker | Daemon-wide changes on a shared host | Rejected |
| **Hardened `runc` container + internal network + egress proxy** | **Chosen as the baseline everywhere** |

Every `site-build` and `app` container (tenant code) is created with: `User 10001:10001`,
`CapDrop: [ALL]`, `no-new-privileges`, default seccomp and AppArmor, `ReadonlyRootfs` with size-capped
tmpfs for `/tmp` and `$HOME`, no bind mounts, no devices, no host namespaces, `Memory = MemorySwap`,
`NanoCpus`, `PidsLimit`, `Ulimits fsize`, `cgroup-parent`, syslog log driver, restart `no` (build) /
`unless-stopped` (app). Our own `edge`, `site-fetch`, `site-publish` get the same hardening.

- **Limits (build):** 2048 MiB (the job slot, SD-10), 2 CPUs, 1024 pids, 15 min wall clock (control
  kills), 2 GiB max file size. **Disk:** Docker volumes have no quota, so our wrapper is PID 1, sums
  workspace + cache every 5 s and ends the build above `BUILD_DISK_MB` (8192). Tenant code cannot stop
  or kill PID 1 of its own namespace; killing the wrapper's children only fails the build. This is a
  brake, not a boundary (a hostile build can overshoot by seconds of disk throughput).
- **Network:** one Docker network `selfbase-build`, created `internal: true` by the control compose —
  no route out and none to the host *(verify on Docker 29: host gateway unreachable)*. Only one build
  runs at a time (v2's single job slot), so two tenants never share it. The `selfbase-egress`
  container (control stack, 64 MiB, on `selfbase-build` and a normal bridge) is the only way out:
  a stdlib-only HTTP `CONNECT` proxy (~150 lines, our code, security-reviewed) that resolves the name
  itself and **refuses** loopback, RFC 1918, link-local/metadata, CGNAT, the project subnet pools and
  every port except 443 (plus 22 to the site's configured git host for `site-fetch`). Default
  **allow-list**: the npm registry, the git host, hosts the operator adds (`BUILD_EGRESS_ALLOW`); a
  per-site switch "open egress (443, public addresses)" exists for builds that fetch CMS data.
  The builder exports `HTTPS_PROXY`/`NODE_USE_ENV_PROXY`. A Gitea on a private address needs an
  explicit operator entry (`GIT_HOSTS_ALLOW`).
- **Cache:** `sb-<ref>-cache` holds the package-manager store and framework caches. Per site, never
  shared (a poisoned cache stays in its site); wiped from Studio or automatically above
  `BUILD_CACHE_MAX_MB` (4096). `sb-<ref>-src` is emptied after publish.

### 5.5 Artifacts — SD-5

`sb-<ref>-releases` holds `releases/<release id>/` (static: the output folder; node: the standalone
app) and `live/<instance key>` symlinks. A release is written once by `site-publish`, which rejects
symlinks leaving the output, more than 1 GiB or 50 000 files, records size and SHA-256 of a manifest
in `site_deployments`, and re-checks the hash on every activation. Rejected: a local registry (nothing
is an image; it would be one more stateful service whose images Coolify's cleanup removes); artifacts
in Garage only (the serve path would need unpacking; kept as the **backup** format, section 7).

### 5.6 Provisioner invariants — SD-9

Measured today: `provisioner/src` is 945 lines against a target of < 1000. Sites cannot fit.

| Option | Decision |
|---|---|
| A second daemon (`site-provisioner`) with its own socket proxy | Rejected: both would hold the same root-equivalent socket; the boundary is the spec builder, not the process; +160 MiB and another token |
| **One process; `provisioner/src/site-spec.ts` + `site-ops.ts` as a separate, pure module** | **Chosen.** Restated invariant: core provisioner ≤ 1000 lines, sites module ≤ 600 lines, Node standard library only, each with its own security-review task and refusal tests |

The sites module carries every v2 invariant unchanged: typed operations only (`ensureSite`,
`ensureInstance`, `swapApp`, `removeInstance`, `removeSite`, `runSiteJob`, `logs/stats/inspect`), it
builds every spec itself, never `Privileged`/`CapAdd`/host namespaces/devices, **no bind mount at all**
(v2's backup bind stays the only one), limits on every container, images refused unless they equal the
four exact names, refs and instance keys validated by regex before they enter a name (`p`,
`v[1-9]`, app generation `a|b`). **The socket-proxy allow-list gains nothing:** no `build`, `exec`,
`archive`, `images/load` or registry path — all site objects match the existing `sb-…` patterns and
`selfbase-build` is joined at container create.

## 6. Serving (question 3)

### 6.1 Edge and app — SD-6

An **instance** is production (`p`) or one preview (`v1…`). Each instance has:

- `sb-<ref>-edge-<key>` — our `site-static` nginx (32 MiB), on `sb-<ref>` and the proxy network,
  carrying the Traefik labels (v2's label set, router `sb-<ref>-<key>`, port 8080). Static sites: it
  serves `live/<key>` (SPA fallback, hashed assets immutable, pre-compressed files, `/env-config.js`,
  security headers, `X-Robots-Tag: noindex` on previews). Node sites: it reverse-proxies to the alias
  `app-<key>` (WebSocket upgrade, body limit, a plain "deploying" page on 502).
- `sb-<ref>-app-<key>-<a|b>` — `site-node`, **only for `node` sites, only on `sb-<ref>`**.

| Option | Against | Decision |
|---|---|---|
| One shared static server for all sites | Traefik needs each host in a label for ACME, so every new domain recreates the shared container (all sites blip); it must mount every site's files; one failure domain | Rejected |
| App container directly on the proxy network (as `core`) | Tenant code would sit on the network of other teams' containers and could reach them on any port | Rejected |
| **Our edge per instance, app behind it** | 32 MiB per instance | **Chosen.** Only our nginx ever joins the proxy network; uniform routing, logs and headers for both kinds |

Each site has its own bridge network `sb-<ref>` (a /27 from `SITE_SUBNET_POOL`, default the /16 next to
the project pool). App containers have normal outbound access, like `fn` does today.

### 6.2 Deploy, swap, health — SD-7

- **Static:** activation is an atomic rename of `live/<key>` by `site-publish`. No container changes;
  no request fails.
- **Node:** `swapApp` creates the other generation (`a`↔`b`) on the new release with its env, waits for
  the Docker health check (our `healthcheck` binary: HTTP GET on `$PORT`, path configurable, default
  `/`, any status < 500), moves the alias `app-<key>` to it, then stops the old one with a 10 s grace.
  The edge resolves the alias with a 1 s TTL. The overlap (two app caps) is taken from the job slot.
  A release that never turns healthy is removed and the deployment is `failed`; production is untouched.
- **Edge recreate** happens only when hosts or labels change (≈ 1 s; Studio warns as for project
  config changes).
- Proof required in 6.3: a request loop during ten consecutive swaps sees zero non-2xx.

### 6.3 Hostnames and certificates

- Site default host `<site ref>.<SITES_BASE_DOMAIN>`. **`SITES_BASE_DOMAIN` is its own setting**
  (default = `BASE_DOMAIN` while on sslip.io): tenant pages must not be able to set cookies for Studio
  and project APIs once a real domain exists (section 8, T9).
- Sites use v2's `host_slots` (new pools `site`, `preview`), so **they draw on the same
  `MAX_NEW_HOSTS_PER_WEEK`** and a deleted site's certified host is reused by the next site. Site
  hosts are never reused for projects or the reverse.
- **Previews — SD-8.** On sslip.io: a server-wide pool of `PREVIEW_HOST_SLOTS` (default 2) fixed hosts,
  certified once. A new preview takes a free slot or evicts the least recently deployed preview
  (branch pool refuses; previews evict, because pushes are frequent). `MAX_PREVIEWS_PER_SITE` = 3.
  On a real domain: stable per-branch hosts `<branch-slug>-<ref8>.<SITES_BASE_DOMAIN>` (per-commit
  hosts rejected: issuance), still under the weekly cap; with `PROXY_MODE=own` a DNS-01 wildcard on our
  own Traefik lifts the cap. Previews are **password-protected by default** (nginx basic auth, one
  generated credential per site, shown in Studio) and removed when the branch is deleted or after
  `PREVIEW_IDLE_DAYS` (7).
- **Custom domains:** added in Studio/CLI; control first checks that the name resolves to this node
  (so a wrong DNS record never burns ACME attempts), then adds the `Host()` and probes the certificate
  (`certificate pending` as in v2). Apex↔www is a `redirect` domain. Custom domains are other
  registered domains and do not count against the sslip.io cap (existing `addDomain` rule).
- Paused/removed sites: control's catch-all answers for site hosts too.

## 7. Operations (question 4)

- **Rollback:** every `ready` production release can be activated again: static = symlink flip (< 1 s),
  node = `swapApp` on the old release (health-check time). No rebuild, no registry, no network.
  Activation re-verifies the release hash. **Production activation pre-empts a running build** (the
  build is cancelled and requeued), so a rollback never waits behind the job slot.
- **Env change:** runtime env of a node site = swap; `/env-config.js` of a static site = `activate`
  with new values (no rebuild); build-scope values need a rebuild and Studio says so.
- **Retention:** last 5 `ready` production releases + pinned + everything live; previews keep only
  their live release; deployment rows 90 days. Pruned by `site-publish`.
- **Logs:** all site containers use v2's syslog driver → VictoriaLogs. Build logs are tagged with the
  deployment id; Studio shows them live and afterwards. The edge writes one JSON access-log line per
  request (host, status, latency, bytes) — the source for request charts and error alerts, no exporter.
- **Metrics:** container CPU/memory through the provisioner's `stats`; requests, error rate and
  latency from edge logs; release and cache volume sizes from v2's disk sampler.
- **Health and alerts:** instance status from Docker health + the certificate probe; wave 5's alert
  mail covers failed deploys, unhealthy apps and disk thresholds.
- **Resource accounting — SD-10.**

  | Site size | edge | app | Total MiB |
  |---|---|---|---|
  | `static` (previews of static sites) | 32 | — | **32** |
  | `node-micro` (default, previews) | 32 | 256 | **288** |
  | `node-small` | 32 | 512 | **544** |
  | `node-medium` | 32 | 1024 | **1056** |

  Admission adds the caps of all running site instances to v2's sum. Builds run in the heavy lane, one
  heavy job per server, so builds and backups share one slot; **`JOB_SLOT_MB` rises from 512 to 2048**
  (setting; 6.0 measures CorteQS's real build peak). Shared stack + `egress` 64 → 4832 MiB; left for
  projects and sites: 11 552 MiB (was 13 152), e.g. CorteQS small + HA + its static site, six micro
  projects and ~1 GB of sites. Rejected: a second, parallel build slot (another 2 GB reserved for speed
  nobody asked for); overcommitting the slot (no swap on the host, CC-2).
- **Backups:** the backup job gains a site mode: site row, encrypted env and the live release as one
  archive, to the same destination as project backups. Older releases and caches are not backed up
  (rebuildable). `sites export/import` moves a site between servers like a project.
- **Control down:** every site keeps serving (edge and app are `unless-stopped` and need nothing from
  the control stack). Deploys, rollbacks and webhooks wait.

## 8. Security model (question 5)

Assumption: tenants are the owner's teams — the code is trusted, **its dependencies are not**. Sites
is not offered to anonymous sign-ups; that would require gVisor (`SITES_RUNTIME=runsc`) as a
precondition, not an option.

| # | Threat | Defence |
|---|---|---|
| T1 | Install/build script or SSR code tries to break out | No socket anywhere near it; non-root, no capabilities, no-new-privileges, seccomp + AppArmor, read-only root, no bind mounts; gVisor on the owner's server. **Residual:** a kernel escape under `runc` on the shared host |
| T2 | Stealing secrets during a build | Build sees build-scope env only; deploy key lives in `site-fetch`; static sites cannot hold secrets; egress allow-list limits where data can go |
| T3 | Lateral movement | Builds: internal network, proxy refuses private ranges — no host, control, socket proxy, projects, sites, Coolify network. Apps: own bridge, never on the proxy network, never on a project network; they reach projects only through public URLs. **Residual:** a running app can reach ports the host publishes to the internet anyway (the host has no firewall, 15.1) |
| T4 | Exhausting RAM, CPU, pids, disk | Hard caps, one build at a time, wall clock, disk brake, file-size limit, artifact caps, retention, admission at overcommit 1.0 |
| T5 | Poisoned cache or tampered rollback target | Cache per site; releases written only by our job, mounted read-only everywhere else, hash checked on activation |
| T6 | Hostile repository or archive | Fetch is unprivileged, hooks/submodules/LFS off, safe untar, publish rejects escaping symlinks |
| T7 | Forged or replayed webhook | Per-site HMAC secret, repository fixed in config, branch filter, rate limit, SHA de-duplication |
| T8 | Hostname takeover, certificate quota burn | One hostname-taken check across projects and sites, DNS pre-check, weekly cap, preview pool |
| T9 | Tenant page attacks Studio or an API from a sibling host (cookie tossing — sslip.io is not on the Public Suffix List) | Studio cookies become `__Host-` (section 10); separate `SITES_BASE_DOMAIN` on a real domain; each site and preview is its own origin; previews behind a password. **Residual:** recycled preview hosts share browser storage between successive previews |
| T10 | Egress proxy or git settings used for SSRF | Proxy resolves and checks the address itself, ports 443/22 only, private git hosts need an operator entry |
| T11 | Compromised `control` | Can only call typed site operations; cannot choose an image, a mount, a network or a `Cmd` |

**What stays external, and how the platform helps:**

| External | Why | Platform help |
|---|---|---|
| DNS and domain registration | A registrar/DNS host is needed by definition | Shows the exact records, verifies them before requesting a certificate, re-checks daily and warns when a custom domain stops pointing here or a certificate nears expiry |
| Certificate authority | Let's Encrypt | Hostname reuse, weekly cap, `certificate pending` status |
| Git host and npm registry | Source and dependencies live there | Upload path needs no git host; per-site cache softens registry outages; rollback needs neither |
| Payments | Card data and licensing belong to a provider | Runtime secrets store, stable production hosts for provider webhooks, project functions as webhook receivers; no card data on the platform |
| Email deliverability | IP reputation cannot be self-hosted on a shared IP | Project SMTP settings (v2); a domain check that reads SPF, DKIM and DMARC records and says what is missing |
| Off-site backups | A copy on the same disk does not survive the server | External S3 endpoint (wave 4) also receives site archives; Studio shows the age of the last off-site copy and alerts; restore drill in the guide |
| Outside-in uptime check, CDN/DDoS shield | A box cannot report itself down | Stable `/health` URL per site for any external pinger; a CDN in front is a DNS change the guide describes |

## 9. Wave 6 sub-steps (question 6)

Sizes: S ≈ 2–3 tasks, M ≈ 5–8, L ≈ 10–14 (v2 wave-1 task granularity). Each ends deployed and proven.

| Step | Content | Size | Proves |
|---|---|---|---|
| 6.0 Facts | Close every *(verify)*: internal-network isolation on the server's Docker, tmpfs/ulimit through the socket proxy, alias swap, webhook headers, Kaniko status; read CorteQS's Dockerfile and `env-config.js` format; measure its build peak and time | S | A fact that contradicts the design stops the wave |
| 6.1 Static by upload | Tables, sites provisioner module, `site-build`/`site-static`/`egress` images, the three jobs, edge, host slots, admission, Studio (sites list, deployments, build log), `selfbase sites create/deploy/logs` | L | CorteQS's frontend is built and served by the platform from an upload; from inside a build: host, control, socket proxy, another project, the proxy network and the metadata address are all unreachable, the npm registry is reachable; the provisioner refuses everything outside the site spec (security review) |
| 6.2 Env, domains, rollback | `site_env` with scopes and project references, `/env-config.js`, custom and redirect domains with DNS pre-check, rollback, retention, pin | M | Env-only change without rebuild; rollback of a static site under load with zero failed requests; a custom domain gets its certificate; the wave stays within the new-host cap |
| 6.3 Node apps | `site-node` image, `next`/`nuxt`/`node` presets, app container, health check, `swapApp`, runtime secrets, sizes | L | A Next.js and a Nuxt app deploy; ten swaps under load without a failed request; an app cannot reach a project database or another site; a failing release never replaces production |
| 6.4 Git push | Deploy key, host-key pinning, webhook endpoint for GitHub and Gitea, git mode of `site-fetch`, build pre-emption | M | `git push` to the production branch deploys with no manual step; a forged webhook is refused; the deploy key is absent from the build container |
| 6.5 Previews | Instances, preview pool and eviction, basic auth, branch-project resolution, cleanup on branch delete and idle | M | Two branches get previews on pooled hosts without a new certificate; a third evicts the oldest; a preview never receives production env |
| 6.6 Operations | Site backup/export/import, request charts and alerts, DNS and mail-record checks, `REHBER.md` (Turkish) chapter, CorteQS frontend handoff (`docs/handoff/wave-6-corteqs.md`; nothing pushed without the team) | M | A site is restored on the owner's Windows machine from its archive; the guide alone is enough to add a site and a domain |

Order: 6.1 before all (model and sandbox); 6.2 before 6.3 (env and rollback semantics are reused);
6.4 and 6.5 need 6.1–6.2 only and may run in parallel with 6.3.

## 10. What earlier waves must reserve now

Conflicts with wave 1's current code (none forces a rewrite if handled as stated):

1. **Provisioner size.** 945 of 1000 lines are used. Waves 2–5 must not rely on the remaining 55;
   their additions (job types, HA services) need the same restated budget rule as SD-9. In `spec.ts`,
   `hostConfig`, `seal`, `baseLabels` and `traefikLabels` are module-private and `traefikLabels`
   hard-codes the router name `sb-<ref>` — export them and take the router name as a parameter.
2. **`buildJob` is backup-shaped:** it refuses without `BACKUP_HOST_DIR`, always binds `/backups`, uses
   one fixed resource entry (512 MiB) and one image. Site jobs get their own builder; the global
   "one job container at a time" check (`JOB_NAME_RE`) must keep matching `sb-<ref>-job-…` so builds
   and backups exclude each other.
3. **Studio cookies are `sb_studio` / `sb_studio_refresh`** (refresh on a sub-path). Any sibling host
   under the base domain — other teams' apps today, sites tomorrow — can set cookies for the parent
   domain. Rename to `__Host-…` with `Path=/` **now**; it is a login-breaking change later.
4. **Labels:** only project containers may carry `selfbase.project`. Keep `listProjects`, `remove` and
   reconcile's orphan report keyed on it; sites use `selfbase.site`.
5. **Hostnames:** `host_slots.pool` has a check constraint (`project`, `branch`, `test`) and
   `project_domains.project_id` is required. Wave 6 adds pools and `site_domains`; until then keep the
   "is this hostname taken" test in one function and the weekly count on `host_slots` only (both true
   today in `hosts.ts`).
6. **Subnets:** `allocateSubnet` is tied to `control.projects` and its constraint name. Sites take a
   separate pool, so wave 6 only parameterises it; do not hand the neighbouring /16 to anything else.
7. **Admission and jobs:** `usedMb` sums projects only and `JOB_SLOT_MB` defaults to 512; `jobs` and
   the engine's "busy" test key on `project_id`. Wave 6 adds a site term, raises the slot and adds
   `jobs.site_id` — later waves should not add more `project_id`-only assumptions to the job engine.
8. **Paused catch-all** (`paused.ts`) and the certificate probe must stay lookups by hostname, not by
   project, so site hosts can be added.
9. **v2 text to amend:** AC-9 ("only `core` is on the proxy network" → also site edges); anti-goal
   "features Supabase does not have" (Sites exception); the 7.6 capacity table (slot 2048, egress 64).

Later waves, by design rather than code:

- **Wave 2:** build the function-source upload as a reusable streamed multipart-to-disk handler with a
  size cap; reserve CLI namespace `selfbase sites` and API prefix `/platform/sites`.
- **Wave 4:** give the backup manifest a version and a resource list so site entries can be added;
  name Garage buckets by ref, not "project".
- **Wave 5:** disk sampling, alerts, log views and reports address a *resource* (ref + kind), and the
  sampler walks every `sb-*` volume rather than the template's volume list.

## 11. Risks

| Risk | Mitigation |
|---|---|
| Kernel escape from a `runc` container on a shared host | Hardening in 5.4; trusted tenants only; gVisor on the owner's server; stated in the guide |
| Internal Docker networks still reach the host on the server's Docker version | 6.0 tests it; fallback is one host firewall rule for the build subnet, which needs the server owner's OK |
| A build needs more than 2 GiB or longer than 15 min | Both are settings; 6.0 measures CorteQS; `prebuilt` upload from CI is the escape hatch |
| Presets do not fit a real app (monorepo tooling, system packages) | Commands, root dir and output dir are editable; Dockerfile builds are the named later option |
| Preview pool of two is tight | Setting; lifted on a real domain; previews of one site can be turned off |
| Sites consume certificate quota shared with other teams | Same cap and slot reuse as projects; custom domains are outside it |
| Disk filled by caches and releases | Per-site caps, retention, sampler alerts; the disk brake during builds |
| nginx alias swap drops requests in some edge case | The 6.3 proof (ten swaps under load) is a wave exit condition |
| Tenant app misuse of the server's IP reputation (outbound spam, scans) | Trusted tenants; app logs and egress are attributable per site; documented |

## 12. Left to the builder

nginx config details; the alias-move mechanics; wrapper and health-check implementation language;
package-manager detection; preset detection heuristics; exact tmpfs sizes; the release id format;
Studio screen layout; how `env-config.js` names its global (must match CorteQS's current file); names
of internal env variables.

Not left to the builder: SD-1…SD-10, the hardening list in 5.4, "no allow-list change", "tenant code
never on the proxy network", "releases are written only by `site-publish`", and each sub-step's
"proves" column.

## 13. Open questions for the owner

1. **gVisor on the shared server:** will the server's owner register `runsc` in the Docker daemon
   (a daemon configuration change)? If not, Sites runs under `runc` there and only for trusted teams.
2. **Budget:** accept that the job slot grows to 2048 MiB (about one micro project less), or cap
   builds lower and build large apps in CI (`prebuilt`)?
3. **Git host:** GitHub only, or is there (or will there be) a Gitea — and on a public or private address?
4. **Real domain:** when it arrives, a second base domain for sites (recommended, T9) or one for both?
5. **Who may create sites:** only the owner's teams (assumed), or outsiders later?
6. **Host firewall rule** blocking new connections from selfbase subnets to the host — may a builder
   ask the server's owner for it (closes the residual in T3)?
7. **CorteQS frontend cutover:** does the team want it in Wave 6 (6.6 handoff), and which hostname
   must keep working?

## 14. Owner answers (2026-11-23)

The owner accepted every recommendation:

1. gVisor: not now. Sites run on hardened `runc`, for the owner's own teams only.
2. Build slot: 2048 MiB accepted.
3. Git host: GitHub first; Gitea later if needed.
4. Domains: a separate base domain for sites once a real domain exists.
5. Who creates sites: the owner's own teams only. Opening Sites to outside users makes gVisor mandatory and reopens SD-4.
6. Host firewall rule: may be requested from the server owner if the 6.0 verification shows the internal build network can reach the host.
7. CorteQS frontend migration is part of Wave 6 and is the first site.
