# Stub: PgBouncer from Alpine, built as selfbase-pooler (plan D-2). Task 5 adds the entrypoint that writes
# pgbouncer.ini and the userlist (transaction pooling, spec 8.9).
FROM alpine:3.22
# log to stderr, no unix socket: the packaged defaults are not writable as nobody
RUN apk add --no-cache pgbouncer \
 && sed -i -e 's|^logfile = .*|logfile =|' -e 's|^unix_socket_dir = .*|unix_socket_dir =|' /etc/pgbouncer/pgbouncer.ini
USER nobody
EXPOSE 6432
CMD ["pgbouncer", "/etc/pgbouncer/pgbouncer.ini"]
