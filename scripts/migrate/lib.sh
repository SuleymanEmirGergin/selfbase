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

# Host part of a postgres URL (no credentials).
url_host() { local u="${1#*://}"; u="${u##*@}"; u="${u%%[/?]*}"; echo "${u%:*}"; }

# The target must be selfbase, never the hosted project being migrated away from.
refuse_supabase_target() {
  local h; h="$(url_host "${!1}")"
  if [[ ${h,,} == *.supabase.co || ${h,,} == *.supabase.com ]]; then
    echo "$1 points at a Supabase host; it must be the selfbase database" >&2
    exit 2
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
  export PGHOST="${hostport%:*}"
  [[ $hostport == *:* ]] && export PGPORT="${hostport##*:}"
  for kv in ${q//&/ }; do [ "${kv%%=*}" = sslmode ] && export PGSSLMODE="${kv#*=}"; done
  unset "$1"
}

# On Linux/macOS the container runs as the caller, so files it writes under dump/ are the caller's.
docker_user=()
case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) ;; *) docker_user=(--user "$(id -u):$(id -g)") ;; esac
