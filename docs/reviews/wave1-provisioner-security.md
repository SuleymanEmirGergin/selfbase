# Wave 1 provisioner security review (Task 8)

Reviewed: `provisioner/src/*` (names, settings, template, spec, docker, ops, server), `provisioner/socket-proxy.env`,
the real `template/compose.yml` and `template/sizes.json` as the image bakes them, and core's admin listener.
Base `v2` at 98d14c0. The reviewer did not write Tasks 6 and 7.

**Threat.** `control` is fully compromised. It holds `PROVISIONER_TOKEN` and can send any request body to any
route. The provisioner's node settings (`REGISTRY`, `BACKUP_HOST_DIR`, the network names and so on) come from the
operator's env file, not from control. They are checked anyway, as a second wall.

**Boundary.** The provisioner checks the *shape* of what control asks for. It does not check whether control may
ask: which hosts belong to which project, which subnet a project owns, and whether a project may be deleted are
control's decisions (Tasks 11 and 12). Two projects with the same host are **accepted** here; host uniqueness is
Task 11's (`refusal.test.ts` asserts this boundary). An `ensure` for an existing network with a different subnet is
refused (409 `subnet_conflict`), because Docker would keep the old one.

## What each route and field reaches

| Route / field | What a compromised control reaches |
|---|---|
| `GET /health` (no token) | `templateVersion` only. |
| `GET /projects`, `GET /projects/:ref` | State of labelled `sb-*` containers: names, status, health, spec hash, memory cap. No env. |
| `ref` (every route) | `^[a-z]{20}$` (names.ts) before it is part of any name. `control` is refused everywhere except backup jobs (`assertJobRef`). |
| `EnsureInput.templateVersion` | `^[0-9A-Za-z._-]{1,64}$`; picks the image tag inside our registry path only. |
| `EnsureInput.size` | One of `micro`/`small`/`medium` from the baked table, which is checked: whole-number memory and pids, cpus from 0.01, `shared_buffers` like `128MB`, whole-number `max_connections`/`pool_size`. |
| `EnsureInput.subnet` | A /27 inside `PROJECT_SUBNET_POOL`; it becomes the network's IPAM subnet and core's `PROJECT_SUBNET`. |
| `EnsureInput.hosts` | 1 to 10 lowercase DNS names; they become `Host(...)` rules on core's `sb-<ref>` routers. |
| `EnsureInput.env` | Names `[A-Za-z_][A-Za-z0-9_]*`, values strings of at most 64 KiB with no NUL. They are **render variables only**: a container's `Env` is the template's `environment`, rendered. A key the template does not use reaches nothing. `REGISTRY`, `TEMPLATE_VERSION`, `PROJECT_SUBNET`, `DB_SHARED_BUFFERS`, `DB_MAX_CONNECTIONS` and `POOL_SIZE` from control are dropped. |
| `ensure.recreate` | Restarts template services of that ref. |
| `start`/`stop` `services` | Template services of that ref. |
| `DELETE ?volumes=true` | Removes that ref's containers, network and template volumes (data loss, within control's authority). |
| `attach-proxy` | Connects `sb-<ref>-core` to the proxy network. |
| `JobInput.type` | Fixed enum; `backup` and `restore` run, the rest are 501. `Cmd` is fixed per type. |
| `JobInput.args.dir` / `BACKUP_SUBDIR` / `RESTORE_DIR` | One or two plain segments, no `.`/`..`; relative to `/backups` inside the job. `RESTORE_DIR` may also be `import/<a>/<b>` (the operator's drop area; control checks that `<a>` is the importing organization). |
| `JobInput.env` | Eight allowed names (no `LD_PRELOAD`, no `PATH`), same value limits as above. `PGHOST` can point the job anywhere the `sb-<ref>` network reaches. |
| `GET .../jobs/:type` | Status and the last 50 log lines of `sb-<ref>-job-<type>`, then removes a finished one. |
| `GET .../services/:service/logs|stats` | Template services only (`job-*` and anything else named `sb-<ref>-*` is 400 `invalid_service`). Logs can hold whatever the service logs. |

## Required answers

- **Bind mount?** No. Template volumes are named volumes only (`MOUNT_RE`, declared names). The one bind is
  `BACKUP_HOST_DIR` → `/backups` in job containers, and `BACKUP_HOST_DIR` must now be under `/opt/selfbase/`.
  The proxy also checks it now: `SP_ALLOWBINDMOUNTFROM=${BACKUP_HOST_DIR}` (wollomatic 1.14.0 supports it; it reads
  `Binds` and `Mounts` of type bind, `..` included; tested).
- **Privileged or host-namespace container?** No input sets `Privileged`, `CapAdd`, `Devices`, `PidMode`, `IpcMode`,
  `UsernsMode` or published ports; the template refuses those keys. `NetworkMode` is `sb-<ref>`, or `CONTROL_NETWORK`
  for control's backup job, which settings now refuse as `host`, `none`, `bridge`, `default` or `container:x`.
  A template `user` can no longer interpolate (a project env value could have picked `0:0`).
- **Object not named `sb-*`?** No create. Containers `sb-<ref>-<service>` and `sb-<ref>-job-<type>`, networks
  `sb-<ref>`, volumes `sb-<ref>-<volume>`. Template services may not be named `job-*`, so a project service cannot
  collide with a job container. Control's backup job is `sb-control-job-backup` (7 letters: never a project ref).
  It *joins* `CONTROL_NETWORK`, and ensure connects `CONTROL_CONTAINER` to `sb-<ref>`; both names come from settings.
- **Image outside our registry path?** No. A rendered image must equal `<REGISTRY>/selfbase-<service>:<version>`;
  the job image is `<REGISTRY>/selfbase-job:<TEMPLATE_VERSION>`. Image inspect through the proxy is now limited to
  `<REGISTRY>/selfbase-*:<tag>`. Pull (`/images/create?fromImage=`) is enforced by the provisioner alone, because the
  proxy does not see the query string.
- **Traefik label not prefixed `sb-<ref>`?** No. Labels come only from `traefikLabels()`; routers, services and the
  middleware are all `sb-<ref>[-http|-redirect]`; templates cannot carry labels.
- **Host rule outside `hosts` validation?** No. Each host matches `HOST_RE` (no backtick, parenthesis or `|`), so
  the rule is only `Host(`a`) || Host(`b`)`. **But** see finding R-1: a valid host can be another team's.
- **Env value that changes the command?** Not through the provisioner any more. `Cmd` is the template's, each entry
  rendered as one argv item. A template `command` or `CMD` healthcheck that runs a shell or interpreter (`sh`,
  `bash`, `node`, `python`, `env`, ...) with `${...}` is refused, as `CMD-SHELL` with `${...}` already was. The
  size-derived values (`shared_buffers=...` in db's command) are validated and cannot come from control. Inside the
  images, entrypoints read env as data; the pooler writes `POSTGRES_PASSWORD` into its userlist, where a newline
  could add a userlist line (finding R-4).
- **Path outside `backupHostDir`?** No. The bind source is `BACKUP_HOST_DIR` exactly; `dir` is relative, one or two
  plain segments (or `import/<a>/<b>` for a restore). (A job can create a symlink inside the backup dir; it resolves in the job's own mount namespace.
  A host-side tool that follows links under `/opt/selfbase/backups` as root would need care; there is none today.)
- **Log line with a secret?** No. One line per request: method, path (ref, service, job type), status, error code.
  No body, no query. Docker's error text is dropped for `/containers/create` (it can echo `Env`); other calls
  carry no env. Refusal messages name env *keys*, never values; render errors name the variable and the template's
  own `:?` text. Unexpected errors log a stack trace, which holds no request values.

## Residual risk: a compromised provisioner process (spec 7.5)

The provisioner is root-equivalent by design; the proxy only narrows *paths*. Through the proxy it can still:

- `POST /containers/create` with any body except a bind mount: `Privileged`, `PidMode:host`, `CapAdd`, `Devices`,
  `NetworkMode:host`. Starting it needs an `sb-*` name, which it can give. **This is host root.**
- `POST /volumes/create` with local-driver `DriverOpts` (`type=none,o=bind,device=/`): a bind mount the proxy's
  bind check does not see, mounted as a "volume". Also host root.
- Connect any container, named in the body, to an `sb-*` network or the proxy network, which reaches other teams'
  containers. Disconnect any container from `sb-*` networks only (other teams' containers are not on them unless
  connected that way). It can no longer disconnect anything from the shared proxy network: that path is gone from
  the allow-list, because the provisioner never needs it and the proxy cannot see which container the body names.
- Pull any image (`fromImage` is a query parameter), filling the disk.
- List all containers on the host (`GET /containers/json`: names, images, labels, no env) and read `/info`, `/version`.
- Stop, kill, restart, remove any `sb-*` container, volume or network.

What it cannot do through the proxy: `exec`, `build`, `commit`, swarm, plugins, secrets, prune, inspect or touch
any container, volume or network not named `sb-*`, inspect images outside our registry path, bind-mount any host
path but the backup directory.

## Findings and verdicts

Tests: P = `provisioner/test/refusal.test.ts` (pure), O = `ops.test.ts`, X = `proxy.test.ts` (real Docker behind the
proxy), C = `core/test/admin-peer.test.ts`.

| # | Finding (source) | Verdict | Test |
|---|---|---|---|
| 1 | Settings reach HostConfig unvalidated: `CONTROL_NETWORK=host`, `BACKUP_HOST_DIR=/var/run` (T6) | Fixed: network/container names plain and not `host/none/bridge/default`; backup dir under `/opt/selfbase/`; `CGROUP_PARENT` a `.slice`; `LOG_SYSLOG_ADDR` `udp|tcp://host:port`; entrypoints and resolver plain names | P |
| 2 | Render errors surface as TemplateError (500) (T6) | Fixed: a render failure at request time is 400 `invalid_env` naming the variable; start-time checks stay `TemplateError` | P, O |
| 3 | Template service `job-*` collides with job containers (T6) | Fixed: refused by `validateTemplate` | P |
| 4 | Project env supplies `DB_SHARED_BUFFERS`/`DB_MAX_CONNECTIONS`/`POOL_SIZE` when a size omits them (T6) | Fixed: these and `REGISTRY`, `TEMPLATE_VERSION`, `PROJECT_SUBNET` are dropped from project env; the template's own default applies | P |
| 5 | No cap on host count (T6) | Fixed: at most 10 hosts per project | P |
| 6 | Fractional `pids`/`mem_mb` accepted (T6) | Fixed: whole numbers (and `shm_mb`) | P |
| 7 | Null size entry throws TypeError (T6) | Fixed: 500 `size_invalid` | P |
| 8 | `cpus` < 5e-10 rounds to NanoCpus 0 = unlimited (T6) | Fixed: `cpus` from 0.01 to 1024 | P |
| 9 | Size-derived env vars unvalidated (T6) | Fixed: `shared_buffers` `^[1-9]\d{0,6}(kB|MB|GB)$`, `max_connections`/`pool_size` whole numbers > 0 | P |
| 10 | Template `command` with `sh -c` and `${VAR}` (T6) | Fixed: interpreter + interpolation refused in `command` and `CMD` healthchecks; `user` may not interpolate | P |
| 11 | `-allowbindmountfrom` (T7) | Fixed: supported by 1.14.0; `SP_ALLOWBINDMOUNTFROM=${BACKUP_HOST_DIR:-/opt/selfbase/no-bind-mounts}` | X |
| 12 | `POST /networks/<PROXY_NETWORK>/disconnect` lets a compromised provisioner detach any container (T7) | Fixed in the proxy: removed from the allow-list (the provisioner never used it). The proxy cannot see the body, so it can only allow or deny the whole path; `sb-*` disconnect stays (delete detaches control) | X |
| 13 | Image inspect could be fixed to `<REGISTRY>/` (T7) | Fixed: `GET /images/${REGISTRY}/selfbase-…:<tag>/json` only | X |
| 14 | ensure ignores an existing network's subnet (T7) | Fixed: 409 `subnet_conflict`, before anything changes | O |
| 15 | Orphaned volumes from older templates (T7) | Moved to Task 12 (lifecycle and upgrades): a template upgrade that drops a volume must decide keep or delete. `DELETE ?volumes=true` removes current template volumes only; listing volumes would need `GET /volumes`, which the proxy cannot scope by name. Low | — |
| 16 | Start order and unanchored-regex probes untested (T7) | Fixed (tests): db starts before core, core stops before db; five anchoring probes (prefix, suffix, `jsonx`, `..` into the proxy network) are 403 | O, X |
| 17 | `remove()` takes the ref lock, jobs the `jobs` lock: delete races job create (T7) | Fixed: job create takes the ref lock, then `jobs` (one order everywhere, no cycle); a job for a ref without a network is 404 `project_not_found`. RED: the concurrent delete answered 502 (volume in use by the new job) | O |
| 18 | `jobStatus` may answer 404 `service_not_found` (T7) | Fixed: `containerLogs` takes the not-found code; job status passes `job_not_found`. The window (container removed between inspect and logs) is not reproducible in a test | — |
| 19 | Typo in docker.ts (T7) | Fixed: `const HOST =(` → `const HOST = (` (line 8; the line-48 comment reads correctly) | — |
| 20 | No package.json script for the Docker tests (T7) | Fixed: `npm run test:docker -w provisioner`; `refusal.test.ts` joins `npm test` | — |
| 21 | Core admin port 8081 reachable from other tenants on the shared network (T5, controller ruling) | Fixed: the provisioner sets `PROJECT_SUBNET` (control cannot override it); core's admin middleware answers 403 `{error:'admin_forbidden'}` to any peer outside it, and to its network, gateway (base+1: the host's bridge interface, so every host-network process) and broadcast addresses, before the token check, IPv4-mapped IPv6 included; forwarding headers are ignored; unset = any peer, one warning at start; a bad value stops start | P, C |
| 22 | Env keys with `=`/NUL, values over 64 KiB (brief) | Fixed: refused in project and job env | P |
| 23 | `ref:'control'` on routes other than backup jobs (brief) | Fixed: restore jobs and restore status for `control` are 400 `invalid_ref`; every other route already refused it | P |
| 24 | `service` path segment not in the template (brief) | Fixed: logs/stats accept template services only | P, O |
| 25 | `templateVersion` outside `^[0-9A-Za-z._-]{1,64}$` (brief) | Already refused (Task 6); now covered by the refusal file | P |

Fix round 1 (task review) refined these rows:
- 21: the gateway, network and broadcast addresses of the /27 are refused too (I-1); `X-Forwarded-For`,
  `X-Real-IP` and `Forwarded` do not count.
- 2: only a missing variable (unset `${X}` or `${X:?msg}`, `MissingVarError`) is 400 `invalid_env`; any other render
  error (unsupported interpolation) stays 500 `template_invalid`.
- 4: dropped provisioner-set names are logged as one warning line, names only.
- 10: every argv item before the first exact `-c`/`-e` is checked, so `tini --`, `su-exec u`, `gosu u`, `busybox`,
  `xargs`, `dumb-init` cannot hide a shell; `sh -ec` is caught because there is no exact `-c`. Limit (marked
  `shortcut:` in template.ts): the deny-list is by name, so an interpreter under another name passes.
- 11: wollomatic 1.14.0 does not treat the allowed directory as a bare string prefix: `<dir>x` and `<dir>-evil`
  (Mounts and Binds) are 403. No trailing slash was needed.

## Not fixed: for the controller

| # | Finding | Severity | Owner |
|---|---|---|---|
| R-1 | **Host hijack on the shared Traefik.** `hosts` validation checks shape only. A compromised control can put another team's hostname on `sb-<ref>` routers: Traefik then has two routers for one host, decided by priority (rule length) and tie order, and the certificate resolver may request a certificate for it. The provisioner cannot know other teams' hosts. Options: a `HOST_SUFFIXES` setting the provisioner enforces (custom domains would have to be listed), or setting a low explicit router priority once Task 1's facts show Coolify has no catch-all router. | Important | Controller / Task 11 |
| R-2 | **Certificate churn.** Up to 10 hosts per ensure, and control can change them on every call; each new host can cost a Let's Encrypt order. Only control's weekly new-host cap (Task 11) bounds it. | Important | Task 11 |
| R-3 | A compromised provisioner can bind-mount through a local-driver volume (`DriverOpts device=/`) and create privileged containers; the proxy cannot see bodies. This is spec 7.5's stated residual risk. | Important (accepted by the spec) | — |
| R-4 | Env values may contain newlines. The pooler entrypoint writes `POSTGRES_PASSWORD` into `userlist.txt`, where a newline adds a userlist line. The value is control's own project password, so this gives control nothing it lacks; refusing newlines everywhere would block multi-line values later. | Minor | Accepted |
| R-5 | `job/backup.sh` does not read `BACKUP_SUBDIR` yet, and both job scripts still describe the old compose service (Task 5's concern). | Minor | Task 14 |
| R-6 | Control-side timeouts: job status waits behind the `jobs` lock through a pull of up to 120 s, and now a job create also waits behind its ref's ensure. Control's provisioner client must allow for that. | Minor | Task 12 |
