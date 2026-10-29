#!/usr/bin/env bash
# Give each Antibody role its own OS user so no process can read another
# role's key file (invariant I-12). Run once as root after `antibody setup`.
#
#   sudo ANTIBODY_HOME=/srv/antibody scripts/setup-roles.sh
#
# Then start each daemon as its user, e.g.
#   sudo -u antibody-signer  env ANTIBODY_ROLE=signer  ANTIBODY_HOME=/srv/antibody antibody signer serve
#   sudo -u antibody-control env ANTIBODY_ROLE=control ANTIBODY_HOME=/srv/antibody antibody control serve --web
#   sudo -u antibody-agent   env ANTIBODY_ROLE=agent   ANTIBODY_HOME=/srv/antibody antibody agent serve
# and run `antibody payee …` as antibody-user, `antibody ingest scan` as antibody-ingest.
set -euo pipefail
HOME_DIR="${ANTIBODY_HOME:?set ANTIBODY_HOME}"
GROUP=antibody
getent group "$GROUP" >/dev/null || groupadd --system "$GROUP"
for role in control user agent ingest signer; do
  user="antibody-$role"
  id "$user" >/dev/null 2>&1 || useradd --system --gid "$GROUP" --home-dir "$HOME_DIR" --shell /usr/sbin/nologin "$user"
  dir="$HOME_DIR/keys/$role"
  [ -d "$dir" ] || { echo "missing $dir: run antibody setup first" >&2; exit 1; }
  chown -R "$user:$GROUP" "$dir"
  chmod 0700 "$dir"
  find "$dir" -type f -name '*.key' -exec chmod 0600 {} +
done
# Shared, non-secret state: the run directory (sockets), cache, logs, hwm.json.
for d in run cache logs; do mkdir -p "$HOME_DIR/$d"; chgrp "$GROUP" "$HOME_DIR/$d"; chmod 2770 "$HOME_DIR/$d"; done
chgrp "$GROUP" "$HOME_DIR" "$HOME_DIR/antibody.json" 2>/dev/null || true
chmod 0750 "$HOME_DIR"
echo "Each role now owns only its own key. Start daemons with ANTIBODY_KEY_ISOLATION=enforce (the live default)."
