# PgBouncer from Alpine, built as selfbase-pooler (plan D-2). Build context is the repository root.
# entrypoint.sh writes pgbouncer.ini and a 0600 userlist into /run/pgbouncer at start (transaction pooling, spec 8.9).
FROM alpine:3.22
RUN apk add --no-cache pgbouncer \
 && mkdir -p /run/pgbouncer && chown nobody:nobody /run/pgbouncer && chmod 700 /run/pgbouncer
COPY --chmod=755 pooler/entrypoint.sh /entrypoint.sh
USER nobody
EXPOSE 6432
ENTRYPOINT ["/entrypoint.sh"]
