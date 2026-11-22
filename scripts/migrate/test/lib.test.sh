#!/usr/bin/env bash
# bash scripts/migrate/test/lib.test.sh — checks lib.sh's .env reader, URL parsing and target guard.
set -euo pipefail
. "$(dirname "$0")/../lib.sh"
fail=0
eq() { if [ "$1" != "$2" ]; then echo "FAIL $3: got [$1] want [$2]"; fail=1; else echo "ok $3"; fi; }

tmp="$(mktemp)"
printf '%s\r\n' '# comment' 'A=plain' 'B=p@ss$wo"rd#x y' ' C = spaced' 'export D=no' '' > "$tmp"
unset A B C D
PRESET=keep; printf 'PRESET=over\n' >> "$tmp"
load_env "$tmp"; rm -f "$tmp"
eq "$A" plain 'env: plain value, CRLF stripped'
eq "$B" 'p@ss$wo"rd#x y' 'env: value literal to end of line'
eq "$C" ' spaced' 'env: key trimmed, value literal'
eq "${D-unset}" unset 'env: non-identifier key skipped'
eq "$PRESET" keep 'env: existing variable wins'

U='postgres://postgres.abcdefghijklmnopqrst:p%40ss%25w%5Cd@aws-1-eu-west-2.pooler.supabase.com:5432/postgres?sslmode=require'
( pgenv U
  eq "$PGUSER" postgres.abcdefghijklmnopqrst 'pgenv: user'
  eq "$PGPASSWORD" 'p@ss%w\d' 'pgenv: password decoded'
  eq "$PGHOST" aws-1-eu-west-2.pooler.supabase.com 'pgenv: host'
  eq "$PGPORT" 5432 'pgenv: port'
  eq "$PGDATABASE" postgres 'pgenv: database'
  eq "$PGSSLMODE" require 'pgenv: sslmode'
  eq "${U-unset}" unset 'pgenv: url variable unset' ) || fail=1

eq "$(url_host "$U")" aws-1-eu-west-2.pooler.supabase.com 'url_host'
T="$U"; ( refuse_supabase_target T ) 2>/dev/null && { echo 'FAIL guard: supabase.com accepted'; fail=1; } || echo 'ok guard: supabase.com refused'
T='postgres://u:p@abcdefghijklmnopqrst.supabase.co:5432/postgres'; ( refuse_supabase_target T ) 2>/dev/null && { echo 'FAIL guard: supabase.co accepted'; fail=1; } || echo 'ok guard: supabase.co refused'
T='postgres://postgres:x@db:5432/postgres'; ( refuse_supabase_target T ) && echo 'ok guard: selfbase accepted' || fail=1
for T in 'postgres://u:p@abc.supabase.co./postgres' 'postgres://u:p@abc.supabase.co.:5432/postgres' \
         'postgres://u:p@abc.supabase.com..:6543/postgres'; do
  ( refuse_supabase_target T ) 2>/dev/null && { echo "FAIL guard: trailing-dot host accepted: $T"; fail=1; } || echo "ok guard: refused $T"
done

# IPv6 hosts, with and without a port
( V='postgres://u:p@[::1]:5433/db'; pgenv V; eq "$PGHOST|$PGPORT" '::1|5433' 'pgenv: [IPv6]:port' ) || fail=1
( V='postgres://u:p@[fe80::1]/db'; pgenv V; eq "$PGHOST|${PGPORT-none}" 'fe80::1|none' 'pgenv: [IPv6] without port' ) || fail=1
eq "$(url_host 'postgres://u:p@[::1]:5433/db')" '::1' 'url_host: IPv6'
# Query parameters other than sslmode are refused, by name only
out="$( V='postgres://u:secret@h/db?sslmode=require&options=-csearch_path%3Dx'; pgenv V 2>&1 )" && { echo 'FAIL pgenv: unsupported parameter accepted'; fail=1; } || true
eq "$out" "V: unsupported URL parameter 'options' (only sslmode is supported)" 'pgenv: unsupported parameter refused'

# Same path 02 uses: pgenv defined into the container script on stdin (container_run)
if command -v docker > /dev/null; then
  X='postgres://user:p%25a\b%40c%3Ad%2Fe@db:5432/postgres'
  got="$(printf '%s\n' 'pgenv X' 'printf "%s|%s|%s|%s" "$PGUSER" "$PGPASSWORD" "$PGHOST" "${X-unset}"' | X="$X" container_run -e X)"
  eq "$got" 'user|p%a\b@c:d/e|db|unset' 'container_run: password with % \ @ : / reaches PGPASSWORD'
else
  echo 'skip container_run: no docker'
fi
exit $fail
