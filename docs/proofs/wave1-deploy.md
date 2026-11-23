# Wave 1: deploy record (Task 20)

Date: 2026-11-23, 22:48 to 23:01 UTC (server clock). Machine: the shared Coolify server of spec section 15.
`<BASE>` is `<ip>.sslip.io`. Release: tag `v2.1.0` = `cba2de6` (branch `v2`), cloned from the public repository into
`/opt/selfbase/src`. Docker Engine 29.6.1, Compose v5.3.0, `coolify-proxy` Traefik v3.6.22.

## Images

GitHub Actions is blocked by billing, so the eight images were built on the host from the tag with `docker build -f
<name>/Dockerfile .` (repository root as context, the `images.yml` matrix), tagged
`ghcr.io/suleymanemirgergin/selfbase-<name>:2.1.0`. Nothing was pushed; the provisioner uses the local image (D-1).

| Image | Id | Build |
|---|---|---|
| db | `sha256:3f1c8afa77b19f35b965d26a8381f7829210450cf96ad5c961172d52a193b8e0` | 11 s |
| core | `sha256:a7effd27e6112086738a5c22e797e9e48601d72e1fbde6fe3d2776cc8e545d7e` | 5 s |
| fn | `sha256:a34b64bcdcc411fc6917b1b6e6395fdd19c6e5e531d2eb3f6d47af2a409989ea` | 2 s |
| rest | `sha256:9e5a03267df25812b2327b0126d4a6bd407277d83e8b30af3772c731da930216` | 0 s |
| pooler | `sha256:2ce0eefc27736d0de4d8b73deb6c855bbb1b4a6b34c9dc5fc21d9e96c904410d` | 2 s |
| job | `sha256:322cdc085cfae946ed3b55c9cf71c530dcde0227f32a2834380db48475382cbe` | 3 s |
| control | `sha256:0022649bc6fefb1b39b8664dc031e87a3102ac826a8c27934d62e416d8fa8a01` | 9 s |
| provisioner | `sha256:4e432e08f8e12376f359366e2246d4cd02068ba07e8b963f97703f89563bd844` | 1 s |

## Install

Layout under `/opt/selfbase` (0700): `control/compose.yml` and `control/traefik-socket-proxy.env`, with
`provisioner/socket-proxy.env` beside it so `env_file: ../provisioner/socket-proxy.env` resolves; `.env` (0600, no
secrets); `secrets/` (0700); `backups/` (0711); `proofs/`; `src/` (the tag checkout). Started with
`docker compose -p selfbase -f control/compose.yml --env-file .env up -d`.

- Secrets: `gen-keys.mjs --secrets /secrets 10001` in the control image as root, no network: `master_key`,
  `control_db_password`, `control_jwt_secret`, `provisioner_token`, each 0640 root:10001 (the mode install-check
  requires; control and the provisioner read them as group 10001). Never displayed.
- `install-check.mjs /env /secrets` (control image, root, no network, `HOST_DOCKER_SOCKET_GID` passed):
  `install-check: ok`. By hand: `docker network inspect coolify` succeeds, `docker image inspect` succeeds for all
  eight images, `/opt/selfbase/backups` exists.
- Settings in `.env`: `BASE_DOMAIN=<BASE>`, `REGISTRY=ghcr.io/suleymanemirgergin`, `TEMPLATE_VERSION=2.1.0`,
  `PROXY_MODE=coolify`, `PROXY_NETWORK=coolify`, `PROXY_ENTRYPOINT_HTTP=http`, `PROXY_ENTRYPOINT_HTTPS=https`,
  `PROXY_CERTRESOLVER=letsencrypt`, `PROXY_TRAEFIK_MAJOR=3`, `PROJECT_SUBNET_POOL=10.207.0.0/16`,
  `LOG_SYSLOG_ADDR=udp://127.0.0.1:5514`, `CGROUP_PARENT=selfbase.slice`, `BACKUP_HOST_DIR=/opt/selfbase/backups`,
  `MAX_NEW_HOSTS_PER_WEEK=3`, `TEST_HOST=sb-test.<BASE>`, `NODE_NAME=main`, `DOCKER_SOCKET_GID` (the socket's group),
  `SECRETS_DIR=/opt/selfbase/secrets`. Not set: `PUBLIC_URL` (default `https://selfbase.<BASE>`), `LEGACY_HOSTNAMES`,
  SMTP (links shown in Studio), capacity values (defaults: budget 16384 MiB, reserved 2720, job slot 512).
- Owner step D: `systemctl set-property selfbase.slice MemoryMax=16G`; `systemctl show selfbase.slice -p MemoryMax`
  answers `MemoryMax=17179869184`. Every control container and every project container runs in it
  (`HostConfig.CgroupParent=selfbase.slice`, `/proc/<pid>/cgroup` = `0::/selfbase.slice/docker-<id>.scope`). Slice
  memory: 282 MB with the idle control stack, 641 MB with one micro project running. The second wall is present.
- Owner: `create-owner` with a generated one-time password in `secrets/owner-initial-password` (0600 root).

## Measured

| What | Time |
|---|---|
| `compose up -d` returns | 10 s |
| `https://selfbase.<BASE>/health` 200 with a valid Let's Encrypt certificate, from `up` | 26 s |
| Throw-away project 1 (`test` pool, micro), POST to `ACTIVE_HEALTHY` | 82.8 s |
| same, without the certificate wait (POST to the `warm` step done) | 20.4 s |
| same, `certificate` step | 60.1 s |
| Acceptance suite, `full` mode, against project 1 | 12 passed, 0 failed, in 25.4 s |
| Delete project 1 (job) | 3 s |
| Throw-away project 2, same host, POST to `ACTIVE_HEALTHY` (`certificate` step 0 s) | 22.3 s |
| Delete project 2 | 2 s |
| Control stack started again, to healthy | 6 s |

The `certificate` step's 60 s is the probe's cache, not the issuance: `cert.ts` keeps a `pending` answer for 60 s, the
first probe ran before the certificate existed, and the next one found it. The certificate's notBefore, against the
control host's, puts the issuance about 25 s after the project's route appeared.

## Certificates

New hostnames this week: **2 of 3**. `selfbase.<BASE>` at the first start (`/platform/capacity`
`new_hosts_this_week: 1`; control-db `control_host_first_issued_at` written by control), `sb-test.<BASE>` with project 1
(`2`). Projects 2 and a third throw-away project (the slice check) took the freed `test` slot with the existing
certificate: the counter stayed at 2.

## Checks

- Step 6: after each delete, no container, network or volume named `sb-<ref>*` is left, the `test` host slot is free,
  the project row is `REMOVED`.
- Step 7: the five control containers stopped for 60 s while project 1 ran: 29 probes, each `/health` and `/rest/v1/`
  with the anon key over the public host, all 200. After the start, and 35 s for a reconcile pass: the project's five
  container ids unchanged, no new job, status `ACTIVE_HEALTHY`.
- Router priority (carried from Task 12's R-1 ruling): our project routers carry `priority=10`. No Coolify router on
  the server sets a priority label, so Traefik gives each its rule length, 37 to 71 here, and every Coolify router beats
  one of ours for the same host. Read from the labels of the 19 foreign routers; a live tie against another team's host
  was not attempted.
- Core admin peer check behind the real proxy: from `selfbase-control`, core's `:8081/admin/ready` at its address on the
  `coolify` network answers 403 (peer outside the project's /27), at its address on `sb-<ref>` 401 (peer allowed, no
  token). `https://sb-test.<BASE>/admin/ready` through `coolify-proxy` is 404.
- VictoriaLogs: `GET /platform/projects/<ref>/logs?service=core` answers from the store (no
  `x-selfbase-log-source: container` header) with timestamped core lines; the POST-form `start` cuts 151 lines to 2.
- Streaming through control (`fetch` with `duplex: 'half'`): a 20 MiB random body uploaded chunked to
  `/platform/projects/<ref>/admin/files/<bucket>/<name>` and read back gives the same sha256 and size.

## Other teams' resources

Listed with the commands of `docs/proofs/wave1-before.md` before and after; both lists stay on the server
(`/opt/selfbase/proofs/task20-{before,after}.txt`). Before: 17 containers, 6 networks, 14 volumes. After: the same
names and the same container ids, plus one line, `selfbase`: our own control network, which the `^(sb-|selfbase-)`
filter does not exclude. `coolify-proxy` has the same id, start time and restart count; `/etc/docker/daemon.json` the
same checksum.
