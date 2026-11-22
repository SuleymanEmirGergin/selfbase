# Wave 1: own-Traefik proof (CC-6)

Date: 2026-11-22. Machine: the owner's Windows 11 PC, Docker Desktop 4.92.0 (engine 29.8.0, cgroupfs driver).
Repository state: branch `v2` at `6ebf070` plus the acceptance-suite commit.

## What ran

The Task 17 control stack (`control/compose.yml` + `control/compose.build.yml`, compose project `selfbase-t19`) with
`PROXY_MODE=own`, `COMPOSE_PROFILES=proxy`, built from the repository's own images (`selfbase.local/*:e2e`, layers
cached, `compose build` took 17 s). Install steps exactly as `control/.env.example` describes them: `gen-keys.mjs
--secrets` as root into a 0700 directory under `/opt/selfbase/sb-t19` inside the Docker Desktop VM, a root-only copy of
the env file, then `install-check.mjs` in the control image, which answered `install-check: ok`. A fresh control-db, so
the `MAX_NEW_HOSTS_PER_WEEK=3` counter started at zero (control host + two projects = 3).

Settings: `BASE_DOMAIN=localhost`, `PUBLIC_URL=https://selfbase.localhost`, `PROXY_HTTP_PORT=80`,
`PROXY_HTTPS_PORT=443`, `PROXY_NETWORK=sb-0-t19-proxy`, `PROJECT_SUBNET_POOL=10.218.0.0/16`.

Ports 80 and 443 were free on the Windows host (nothing listening), so Traefik published them as asked
(`80/tcp -> 0.0.0.0:80`, `443/tcp -> 0.0.0.0:443`); 18080/18443 were not needed.

## Switched off or left empty (Step 1)

| Setting | Value | Why |
|---|---|---|
| `PROXY_CERTRESOLVER` | empty | no public DNS and no ACME on `*.localhost`; Traefik serves its default certificate |
| `CERT_PROBE` | `off` | the https self-probe is for real hostnames; local only |
| `CGROUP_PARENT` | empty | Docker Desktop's VM uses cgroupfs, there is no systemd slice to place containers in |
| `LOG_SYSLOG_ADDR` | `udp://127.0.0.1:5514` (kept) | Docker Desktop accepted it: stack and both projects started with it. Log delivery was not re-checked in this run (Task 17 e2e case 4 does) |
| `DOCKER_SOCKET_GID` | `0` | the socket is root:root on Docker Desktop |

## Observed

| Step | Result |
|---|---|
| `docker compose up -d --wait` to Studio answering through Traefik on `https://selfbase.localhost` | 18.0 s |
| Owner created (throwaway generated password, not recorded), sign-in and access token via the API | worked |
| Project A created, `ACTIVE_HEALTHY` | 82.0 s |
| Project B created, `ACTIVE_HEALTHY` | 82.7 s |
| Chromium (headless Playwright) opens `https://<refA>.localhost/health` and `https://<refB>.localhost/health` | both 200 `{"ok":true}`; certificate is `TRAEFIK DEFAULT CERT`, self-signed (browser told to ignore the error) |
| `docker restart selfbase-traefik` | same container id, new start time; both hosts answered 200 again after 2.8 s with no other action |
| The two hosts opened again in Chromium after the restart | both 200 |
| Studio at `https://selfbase.localhost/` in Chromium: sign in as the owner, organisation list visible, project A's table editor opens | worked (0.5 s to the signed-in view) |

The two projects were reached by host name only, on the default port 443 (no port in any URL).

## Not proven there

Copied from the design spec (`docs/superpowers/specs/2026-11-22-selfbase-v2-design.md`, wave 1, CC-6):

- public ACME issuance and renewal (no public DNS; Traefik serves its default certificate)
- binding 80/443 on a Linux host with a firewall
- the systemd slice
- behaviour next to another proxy

Those remain first-time steps on the owner's real server and the guide marks them as such.

## Removal (Step 4)

The run removed the project containers, networks and volumes, the compose project's containers, networks and named
volumes, the proxy network, and `/opt/selfbase/sb-t19`. One slip: the first teardown left project A's five containers,
its network and four volumes behind (control was still running while they were removed and apparently recreated them);
they were removed by hand by name. Afterwards the `sb-*` / `selfbase-*` containers, networks and volumes on the host
were exactly the ones listed before the run (the pre-existing `sb-ctl-t12`, `selfbase-control-test` and
`selfbase-local` objects, untouched), ports 80 and 443 were free again, and `/opt/selfbase` was empty. Built images
stay.
