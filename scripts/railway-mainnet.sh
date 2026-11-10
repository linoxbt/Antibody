#!/usr/bin/env bash
# Entrypoint for ANTIBODY_MODE=mainnet (the repo Dockerfile) (runs as root, then drops to one user per role).
#  - First boot: unpacks ANTIBODY_SEED_B64 (a tar.gz of an existing home: antibody.json,
#    encrypted keys/, hwm.json, payments.json, ingest/) onto the volume.
#  - Writes /etc/antibody/<role>.env and <role>.pass (0400, owned by that role) from
#    this container's variables; each role sees only its own secrets.
#  - Starts signer, control, agent and the sentinel as antibody-<role>; if any of them
#    exits, the container exits and the platform restarts it.
#  - Answers GET /healthz on $PORT (status only, no data).
set -euo pipefail
H="${ANTIBODY_MAINNET_HOME:-/srv/antibody}"
CONF="${ANTIBODY_ROLE_CONF:-/etc/antibody}"
APP="${ANTIBODY_APP:-$(cd "$(dirname "$0")/.." && pwd)}"
mkdir -p "$H" "$CONF"; chmod 0755 "$CONF"

if [ ! -f "$H/antibody.json" ]; then
  [ -n "${ANTIBODY_SEED_B64:-}" ] || { echo "empty volume and no ANTIBODY_SEED_B64: nothing to run" >&2; exit 1; }
  echo "first boot: unpacking the seed home into $H"
  echo "$ANTIBODY_SEED_B64" | base64 -d | tar -xz -C "$H"
fi
mkdir -p "$H/logs" "$H/run"; rm -f "$H"/run/*.sock "$H"/run/*.pid

shared=(ANTIBODY_BACKEND SUI_NETWORK MEMWAL_ACCOUNT_ID MEMWAL_SERVER_URL TATUM_API_KEY ANTIBODY_CROSSCHECK_RPC_URL ANTIBODY_CROSSCHECK_TRANSPORT ANTIBODY_CROSSCHECK_API_KEY)
declare -A extra=(
  [control]="ANTIBODY_TELEGRAM_BOT_TOKEN ANTIBODY_TELEGRAM_CHAT_ID ANTIBODY_ALERT_WEBHOOK ANTIBODY_X402_ALLOW"
  [agent]="LLM_PROVIDER LLM_BASE_URL LLM_API_KEY LLM_MODEL FORTYTWO_API_KEY LLM_REASONING_EFFORT ANTIBODY_X402_ALLOW"
  [ingest]="" [signer]="" [user]=""
)
for role in control user agent ingest signer; do
  R=${role^^}
  pv="ANTIBODY_KEY_PASSPHRASE_${R}"
  [ -n "${!pv:-}" ] || { echo "missing $pv" >&2; exit 1; }
  ( umask 077
    printf '%s\n' "${!pv}" > "$CONF/$role.pass"
    { echo "ANTIBODY_HOME=$H"; echo "ANTIBODY_ROLE=$role"; echo "ANTIBODY_KEY_ISOLATION=enforce"
      echo "ANTIBODY_KEY_PASSPHRASE_${R}_FILE=$CONF/$role.pass"
      for v in "${shared[@]}" ${extra[$role]}; do if [ -n "${!v:-}" ]; then echo "$v=${!v}"; fi; done
    } > "$CONF/$role.env" )
  chown "antibody-$role:antibody" "$CONF/$role.env" "$CONF/$role.pass"
  chmod 0400 "$CONF/$role.env" "$CONF/$role.pass"
done
ANTIBODY_HOME="$H" bash "$APP/scripts/setup-roles.sh" >/dev/null

# Behind an egress proxy (not on Railway), pass it and its CA through to the roles.
net=()
for v in HTTPS_PROXY https_proxy NO_PROXY no_proxy; do if [ -n "${!v:-}" ]; then net+=("$v=${!v}"); fi; done
if [ -n "${NODE_EXTRA_CA_CERTS:-}" ] && [ -r "$NODE_EXTRA_CA_CERTS" ]; then
  cp "$NODE_EXTRA_CA_CERTS" "$CONF/ca-bundle.crt"; chmod 0644 "$CONF/ca-bundle.crt"; net+=("NODE_EXTRA_CA_CERTS=$CONF/ca-bundle.crt")
fi
pids=()
start() { # role, args...
  local role=$1; shift
  runuser -u "antibody-$role" -- env -i PATH="$PATH" HOME="$H" NODE_ENV=production "${net[@]}" ANTIBODY_ENV_FILE="$CONF/$role.env" \
    node "$APP/bin/antibody.mjs" "$@" >> "$H/logs/$role.out" 2>&1 &
  pids+=("$!"); echo "started $role as antibody-$role"
}
wait_sock() { for _ in $(seq 1 120); do [ -S "$H/run/$1.sock" ] && return 0; sleep 1; done; echo "$1 did not start:" >&2; tail -20 "$H/logs/$1.out" >&2; exit 1; }
start signer signer serve;          wait_sock signer
start control control serve --web;  wait_sock control
start agent agent serve;            wait_sock agent
start ingest ingest watch

# Health: 200 while every daemon's socket exists (the sentinel has none: its process is watched below).
H="$H" node -e '
const http = require("http"), fs = require("fs"), H = process.env.H;
http.createServer((q, s) => {
  const ok = ["signer", "control", "agent"].every((n) => fs.existsSync(`${H}/run/${n}.sock`));
  s.writeHead(q.url === "/healthz" ? (ok ? 200 : 503) : 404, { "content-type": "text/plain" }).end(q.url === "/healthz" ? (ok ? "ok" : "starting") : "");
}).listen(Number(process.env.PORT || 8080));
' &
pids+=("$!")
tail -n0 -F "$H"/logs/*.out &
echo "Antibody mainnet up: every role as its own user"
# Tell the owner it (re)started; logs whether the alert channel works. Never fatal.
if [ -n "${ANTIBODY_TELEGRAM_BOT_TOKEN:-}${ANTIBODY_ALERT_WEBHOOK:-}" ]; then
  runuser -u antibody-control -- env -i PATH="$PATH" HOME="$H" NODE_ENV=production "${net[@]}" ANTIBODY_ENV_FILE="$CONF/control.env" \
    node "$APP/bin/antibody.mjs" alert started 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -v '^━━' | sed 's/^/alerts: /' || echo "alerts: start notice failed (check the bot token and chat id)"
fi
wait -n "${pids[@]}"
echo "a daemon exited; restarting the container" >&2
exit 1
