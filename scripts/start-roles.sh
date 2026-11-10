#!/usr/bin/env bash
# Start every Antibody daemon as its own OS user (after scripts/setup-roles.sh).
# Each role reads only /etc/antibody/<role>.env (its own settings and secrets) and
# /etc/antibody/<role>.pass (its own key passphrase), both 0400 and owned by that role.
#
#   sudo ANTIBODY_HOME=/srv/antibody scripts/start-roles.sh
set -euo pipefail
H="${ANTIBODY_HOME:?set ANTIBODY_HOME}"
APP="$(cd "$(dirname "$0")/.." && pwd)"
CONF="${ANTIBODY_ROLE_CONF:-/etc/antibody}"
[ "$(id -u)" = 0 ] || { echo "run as root: sudo ANTIBODY_HOME=$H $0" >&2; exit 1; }
start() { # role, args...
  local role=$1; shift
  [ -r "$CONF/$role.env" ] || { echo "missing $CONF/$role.env" >&2; exit 1; }
  # Behind an egress proxy, pass it (and its CA, copied to $CONF/ca-bundle.crt) through.
  local net=()
  for v in HTTPS_PROXY https_proxy NO_PROXY no_proxy; do [ -n "${!v:-}" ] && net+=("$v=${!v}"); done
  [ -r "$CONF/ca-bundle.crt" ] && net+=("NODE_EXTRA_CA_CERTS=$CONF/ca-bundle.crt")
  runuser -u "antibody-$role" -- env -i PATH="$PATH" HOME="$H" "${net[@]}" ANTIBODY_ENV_FILE="$CONF/$role.env" \
    nohup node "$APP/bin/antibody.mjs" "$@" >> "$H/logs/$role.out" 2>&1 &
  echo "$!" > "$H/run/$role.pid"
  echo "started $role as antibody-$role"
}
wait_sock() { for _ in $(seq 1 90); do [ -S "$H/run/$1.sock" ] && return 0; sleep 1; done; echo "$1 did not start; see $H/logs/$1.out" >&2; exit 1; }
start signer signer serve;          wait_sock signer
start control control serve --web;  wait_sock control
start agent agent serve;            wait_sock agent
start ingest ingest watch
