# End-to-end stack test

`stack.test.mjs` proves the control stack on a real Docker host: it builds every image locally (CC-1, no registry),
starts `control/compose.yml` + `control/compose.build.yml` with `PROXY_MODE=own` (compose profile `proxy`) as compose
project `selfbase-t17`, and then creates, uses, pauses, restores, deletes, exports and imports projects.

```
npm ci
npx -w studio playwright install chromium      # once, for case 4
node --test test/e2e/stack.test.mjs            # from the repository root
E2E_KEEP=1 node --test test/e2e/stack.test.mjs # leave the stack up (Task 18 runs against it)
```

Settings (helpers.mjs `envFile`): `BASE_DOMAIN=localhost`, `PROXY_CERTRESOLVER=` (Traefik's default certificate,
accepted for `*.localhost` only), `CERT_PROBE=off`, Traefik on `18080`/`18443`, `MAX_NEW_HOSTS_PER_WEEK=3`, syslog to
`udp://127.0.0.1:5514`, projects in `10.218.0.0/16`. On the Docker host (on Docker Desktop: inside its VM) the run
makes `/opt/selfbase/sb-e2e` with `backups/`, `secrets/` and a root-only copy of the env file, and goes through the
install steps of `control/.env.example` as written there: `gen-keys.mjs --secrets`, then `install-check.mjs` in the
control image as root. The test never sees a secret. `PROXY_NETWORK=sb-0-e2e-proxy` sorts before every `sb-<ref>`
network, as `coolify` does on the server, so the test sees the Docker DNS order control has to cope with there.
Requests go to `127.0.0.1` with SNI and `Host` set; no hosts-file entry is needed.

It refuses to start when any fixed name of a real install exists (the `selfbase-*` containers of control/compose.yml,
the networks `selfbase`, `selfbase-docker`, `selfbase-traefik-docker`, `sb-0-e2e-proxy`, the volumes
`selfbase-control-pgdata`, `selfbase-logs`, `selfbase-acme`, or `/opt/selfbase/sb-e2e`), so it never adopts one. A local
`selfbase start` stack (`selfbase-local-*`) is fine. Ports 18080, 18443 and 5514/udp must be free. The teardown removes
only what the run owns: the containers, networks and volumes of the project refs it created (also read from control-db),
compose project `selfbase-t17` (`rm -sv`, then `down` without `-v`, then the volumes carrying its label), and the proxy
network and host directory it made. `teardown.test.mjs` checks that a foreign `sb-*` network and volume are not on that
list; case 11 that the host's lists are as before. Built images stay (`selfbase.local/selfbase-*:e2e`).

## Cases

1. create-owner, sign in, access token; project A `ACTIVE_HEALTHY` in under 120 s; `/health`, `/rest/v1/` with the
   anon key; `/admin/ready` and `/panel/` on the public host are 404.
2. Project B; A's core cannot resolve B's db, rest or pooler, and B's core only to its proxy-network address (the
   cores share that network); TCP to B's /27 (db:5432, core:8080/8081) times out; B's admin port on the proxy
   network answers 403 (core's /27 peer check); A's key on B's host is 401; different /27s in the pool.
3. Every project container: `Memory == MemorySwap`, `PidsLimit`, `no-new-privileges`, no binds, no published port,
   syslog logging. Control has no socket and is not on the socket proxy's network. The control stack's secrets are
   files under `/run/secrets`, none in any `Config.Env`. Seven wrong sign-ins from A's core straight to
   `selfbase-control:8080`, each with a new spoofed `X-Forwarded-For`: the sixth and seventh are 429 (the key is the
   socket address, since only the proxy container's own address may forward). A container on the proxy network
   with the network alias `selfbase-traefik` gets the same 429s: trust is by exact container name, not DNS.
4. Studio in Chromium: sign in, insert a row in the table editor, `select 1`, core log lines from VictoriaLogs.
5. Control stack stopped: both projects answer `/health`, sign-up and `/rest/v1/`; a core restart comes back healthy
   with `logs` down (D-5); after the stack starts again reconcile changes nothing (no job, no recreated container).
6. `docker restart selfbase-traefik`: both hosts answer again within 30 s.
7. Pause B → 540; restore → 200.
8. Cap 3 (control host + A + B): a fourth host is refused with the cap message; deleting B removes its containers,
   network and volumes and frees its host slot.
9. `docker rm -f` of A's rest → reconcile recreates it within 60 s. Project C is created while control is killed
   mid-create; it ends `ACTIVE_HEALTHY` with one container per service, on the host B freed.
10. Export A with a passphrase, change A's row, delete C, import the export as D: D takes the freed host (no new one),
    has the exported row and A's JWT secret (A's anon key works on D). A wrong passphrase leaves no project.
11. Teardown, and the before/after comparison.

## Measured (Docker Desktop 4.x, Docker 29.8.0, Windows 11, 2026-11-22)

Last green run: 11/11 in 507 s (images cached).

- Control stack `up -d --wait` to Studio answering through Traefik: 17 s.
- Project create to `ACTIVE_HEALTHY`: 70.6 s (A), 81.0 s (B), 82.0 s (C, with control killed mid-create).
- Routes back after `docker restart selfbase-traefik`: 1.0 s. Pause to 540 and restore to 200: 21 s total.
- Reconcile recreates a removed rest: 6.5 s. Export + import of A as D: 82 s.
- Idle memory (`docker stats`): control 69 MiB, control-db 83, provisioner 56, socket-proxy 8, logs 17, traefik 23,
  traefik-socket-proxy 8 (control stack about 264 MiB). A micro project: db 99, rest 60, core 51, fn 15, pooler 2
  (about 227 MiB).
