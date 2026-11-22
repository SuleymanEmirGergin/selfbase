# Shared helpers for the bash migration scripts (sourced, not run).

# Reads .env the same way the Node scripts do (05's loadEnv): KEY=value per line, value taken
# literally to the end of the line (no quotes, no inline comments, no expansion), a trailing \r
# dropped, lines starting with # skipped. Variables already set in the environment win.
load_env() {
  local line k v
  [ -f "$1" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    [[ $line =~ ^[[:space:]]*(#|$) || $line != *=* ]] && continue
    k="${line%%=*}"; v="${line#*=}"
    k="${k#"${k%%[![:space:]]*}"}"; k="${k%"${k##*[![:space:]]}"}"
    [[ $k =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    [ -n "${!k+x}" ] || export "$k=$v"
  done < "$1"
}

# Host part of a postgres URL (no credentials, no port, IPv6 brackets and trailing dots removed).
url_host() {
  local u="${1#*://}"
  u="${u##*@}"; u="${u%%[/?]*}"
  if [[ $u == \[* ]]; then u="${u%%]*}"; u="${u#\[}"; else u="${u%:*}"; fi
  while [[ $u == *. ]]; do u="${u%.}"; done
  echo "$u"
}

# The target must be selfbase, never the hosted project being migrated away from. Returns 2 (scripts
# call `refuse_supabase_target X || exit 2`), so it is also safe in an interactive shell.
refuse_supabase_target() {
  local h; h="$(url_host "${!1}")"
  if [[ ${h,,} == *.supabase.co || ${h,,} == *.supabase.com ]]; then
    echo "$1 points at a Supabase host; it must be the selfbase database" >&2
    return 2
  fi
}

# Keeps connection strings, the pooler user (postgres.<ref>) and the project host out of error output.
redact() { sed -E 's#postgres(ql)?://[^[:space:]"]+#<db-url>#g; s#postgres\.[a-z0-9]{20}#postgres.<ref>#g; s#[a-z0-9]{20}\.supabase\.co#<ref>.supabase.co#g'; }

# Defined into the container scripts (declare -f pgenv): turns the URL in the named variable into
# PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE/PGSSLMODE and unsets it, so neither the URL nor the
# password ever becomes a psql/pg_dump argument (visible in the process table).
pgenv() {
  local u="${!1}" q="" userinfo rest hostport kv
  dec() { local s="${1//\\/\\\\}"; printf '%b' "${s//%/\\x}"; } # percent-decoding; literal \ kept
  u="${u#*://}"
  [[ $u == *\?* ]] && { q="${u#*\?}"; u="${u%%\?*}"; }
  userinfo="${u%@*}"; rest="${u##*@}"
  [[ $u == *@* ]] || userinfo=""
  if [ -n "$userinfo" ]; then
    export PGUSER="$(dec "${userinfo%%:*}")"
    [[ $userinfo == *:* ]] && export PGPASSWORD="$(dec "${userinfo#*:}")"
  fi
  hostport="${rest%%/*}"
  [[ $rest == */* && -n ${rest#*/} ]] && export PGDATABASE="$(dec "${rest#*/}")"
  if [[ $hostport == \[* ]]; then # [IPv6] or [IPv6]:port
    PGHOST="${hostport%%]*}"; export PGHOST="${PGHOST#\[}"
    [[ $hostport == *]:* ]] && export PGPORT="${hostport##*]:}"
  else
    export PGHOST="${hostport%:*}"
    [[ $hostport == *:* ]] && export PGPORT="${hostport##*:}"
  fi
  for kv in ${q//&/ }; do
    if [ "${kv%%=*}" = sslmode ]; then export PGSSLMODE="${kv#*=}"
    else echo "$1: unsupported URL parameter '${kv%%=*}' (only sslmode is supported)" >&2; return 1; fi
  done
  unset "$1"
}

# Runs a bash script read from stdin in postgres:17, with pgenv defined in it. The script (and any
# data after an `exec psql ...` line, which bash leaves unread) goes on stdin, never into docker's argv.
# Arguments: docker run options (network, -e NAME, mounts).
container_run() {
  { declare -f pgenv; cat; } | MSYS_NO_PATHCONV=1 docker run --rm -i "$@" postgres:17 bash -s
}

_lib_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# psql against the selfbase target for SQL on stdin: `node 03-auth-storage.sql.mjs rows | psql_target`.
# Reads the root .env like the scripts (in a subshell, so the calling shell is untouched), refuses a
# Supabase host, and passes the password via PGPASSWORD inside the container. Optional: DOCKER_NETWORK.
psql_target() (
  load_env "$_lib_root/.env"
  [ -n "${TARGET_DB_URL:-}" ] || { echo "TARGET_DB_URL is not set" >&2; exit 2; }
  refuse_supabase_target TARGET_DB_URL || exit 2
  net=()
  [ -n "${DOCKER_NETWORK:-}" ] && net=(--network "$DOCKER_NETWORK")
  set -o pipefail
  { echo 'set -e; pgenv TARGET_DB_URL; exec psql -X -q -v ON_ERROR_STOP=1'; cat; } |
    container_run "${net[@]}" -e TARGET_DB_URL 2>&1 | redact
)

# On Linux/macOS the container runs as the caller, so files it writes under dump/ are the caller's.
docker_user=()
case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) ;; *) docker_user=(--user "$(id -u):$(id -g)") ;; esac
