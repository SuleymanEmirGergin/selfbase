# Wave 1: before listing

Taken 2026-11-22T08:20:26Z on the server, read-only, before anything of wave 1 was deployed.

The listing itself stays on the server: `/opt/selfbase/proofs/before.txt` (root, mode 0600, in
`/opt/selfbase` and `/opt/selfbase/proofs`, both 0700). It holds the sorted names of all containers,
networks and volumes whose names do **not** start with `sb-` or `selfbase-` (Coolify, the v1 CorteQS
resource and every other team's objects).

| Object | Count |
|---|---|
| Containers | 17 |
| Networks | 6 |
| Volumes | 14 |

sha256 of `before.txt`: `784979b0bdfd7626664f8d66333f012bf661e2b591568549b29be4af07777cf9`

The after listing at the wave exit uses the same commands and compares by name:

```
docker ps -a --format '{{.Names}}'     | grep -v -E '^(sb-|selfbase-)' | LC_ALL=C sort
docker network ls --format '{{.Name}}' | grep -v -E '^(sb-|selfbase-)' | LC_ALL=C sort
docker volume ls --format '{{.Name}}'  | grep -v -E '^(sb-|selfbase-)' | LC_ALL=C sort
```

Coolify container names carry a deploy timestamp, so another team's redeploy changes a name without
anything of ours being involved; compare with that in mind.
