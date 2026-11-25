# Project network isolation (operator note)

Each project gets one /27 from `PROJECT_SUBNET_POOL`. The provisioner cuts it into three networks:

| Network | Range | Who is on it | Way out |
|---|---|---|---|
| `sb-<ref>` | base/28 | db, rest, core, fn, pooler (base+2 up); backup and restore jobs (base+8/29) | none on Docker 28+ |
| `sb-<ref>-ctl` | base+16/29 | core (base+18) and control only | none on Docker 28+ |
| `sb-<ref>-egress` | base+24/29 | fn only | yes: fn's outbound fetch |

Core also sits on the proxy network, where Traefik reaches it and where its own outbound calls go (those are checked
by core's guard, `core/src/netguard.ts`).

## What this closes

- **Control's API (:8080)** is on `sb-<ref>-ctl` only. No tenant container (fn, rest, db, pooler) shares a bridge
  with control.
- **Core's admin port (:8081)** answers peers from `sb-<ref>-ctl` only. A request from fn or any other tenant
  container gets 403 before the token is read.
- **The host and the internet, from db, rest and pooler:**
  - On Docker 28 or later, `sb-<ref>` and `sb-<ref>-ctl` are `internal` networks with
    `com.docker.network.bridge.gateway_mode_ipv4=isolated`. These are per-network options, not daemon settings.
  - Their containers reach neither the internet nor the host's own addresses through the bridge gateway (host
    services, published ports).

On an engine older than 28, the provisioner logs `has no gateway_mode_ipv4` once and creates the same three networks
without the isolation. The first two points still hold. The host gateway then stays reachable from every project
container, and the rule below then needs the whole pool, not only the egress ranges.

## What stays open: fn to the host

fn runs project code and needs a way out, so `sb-<ref>-egress` has a gateway. Through it, fn can open connections to
the host's own addresses: sshd, a database or panel listening on 0.0.0.0, and published container ports. selfbase does
not change the host firewall. An operator who wants this closed adds host rules like these (iptables, as root; adjust
the pool if `PROJECT_SUBNET_POOL` is not 10.207.0.0/16):

```bash
# new connections from project containers to the host itself (host services, userland-proxied ports)
iptables -I INPUT -s 10.207.0.0/16 -m conntrack --ctstate NEW -j DROP
# new connections from project containers to ports published by other containers (Docker's DNAT path)
iptables -I DOCKER-USER -s 10.207.0.0/16 -m conntrack --ctstate DNAT -j DROP
```

Neither rule touches traffic between containers on the same network or fn's traffic to the internet, with one
exception: the DNAT rule also drops fn's calls to public sites this same server serves (Studio, any project's address,
its own included, other teams' apps), because those reach the proxy's published ports through Docker's DNAT. Make the rules
persistent the way the host does it (for example `iptables-persistent`). Check afterwards that fn still resolves and
fetches an outside URL.

## What these rules do not cover: core's outbound calls

On Docker 28 and later, core's outbound calls (the `net.http_*` queue a project's SQL fills, Google OAuth, SMTP) leave
from core's address on the proxy network, not from the project's /27: the project network is isolated and has no
gateway, so the proxy network holds core's only default route. The rules above match only `PROJECT_SUBNET_POOL`, so
they do not apply to core there. (Below Docker 28 the project network has a gateway, and Docker picks the default
route by network name. With the own proxy network, `sb-<ref>` sorts before `selfbase-proxy`, so core's calls leave
from the pool and the rules do cover them. Under Coolify, `coolify` sorts first and the calls leave from the proxy
network as on Docker 28.) What stands between a project's `net.http_*` request and the host is core's guard alone
(`core/src/netguard.ts`): it refuses private, loopback and link-local addresses and core's own networks, but the
host's public address is an ordinary public address to it. A service on the host listening on 0.0.0.0, or a published
port, is reachable that way. A host in `NETQUEUE_ALLOW_HOSTS` skips the guard entirely. There is no simple host rule
for this: the proxy network is shared, and a rule on its whole subnet also cuts off what else runs there and needs the
host (Coolify reaches the host over SSH from that network). Until core's calls leave from a network of their own,
count every host service that listens on the public address as reachable from any project's SQL.
