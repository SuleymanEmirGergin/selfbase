#!/bin/sh
# Writes pgbouncer.ini and the userlist from the environment, then runs PgBouncer as PID 1 (spec 8.9).
#   POSTGRES_PASSWORD  required, the database superuser's password
#   POOL_SIZE          required, server connections per user/database pair (from sizes.json)
set -eu
: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}"
: "${POOL_SIZE:?POOL_SIZE is required}"
case "$POOL_SIZE" in '' | *[!0-9]*) echo "POOL_SIZE must be a whole number" >&2; exit 1 ;; esac

dir=/run/pgbouncer
umask 077
cat > "$dir/pgbouncer.ini" <<EOF
[databases]
* = host=db port=5432

[pgbouncer]
listen_addr = 0.0.0.0
listen_port = 6432
unix_socket_dir =
logfile =
pidfile =
auth_type = scram-sha-256
auth_file = $dir/userlist.txt
pool_mode = transaction
max_client_conn = 200
default_pool_size = $POOL_SIZE
ignore_startup_parameters = extra_float_digits
EOF
# shortcut: single superuser in the userlist, a pooler role with auth_query when external access lands (wave 2)
printf '"postgres" "%s"\n' "$(printf '%s' "$POSTGRES_PASSWORD" | sed 's/"/""/g')" > "$dir/userlist.txt"

exec pgbouncer "$dir/pgbouncer.ini"
