#!/usr/bin/env bash
# Give each Antibody role its own OS user so no process can read another
# role's key file (invariant I-12). Run once as root after `antibody setup`.
# Linux (useradd) and macOS (dscl; hidden service accounts, no login).
#
#   sudo ANTIBODY_HOME=/srv/antibody scripts/setup-roles.sh
#
# Then start each daemon as its user, e.g.
#   sudo -u antibody-signer  env ANTIBODY_ROLE=signer  ANTIBODY_HOME=/srv/antibody antibody signer serve
#   sudo -u antibody-control env ANTIBODY_ROLE=control ANTIBODY_HOME=/srv/antibody antibody control serve --web
#   sudo -u antibody-agent   env ANTIBODY_ROLE=agent   ANTIBODY_HOME=/srv/antibody antibody agent serve
#   sudo -u antibody-ingest  env ANTIBODY_ROLE=ingest  ANTIBODY_HOME=/srv/antibody antibody ingest watch
# and run `antibody payee …` as antibody-user.
#
# Windows has no POSIX users or modes; there, use separate Windows accounts
# and NTFS ACLs on %USERPROFILE%\.antibody\keys\<role>, or run Antibody in WSL.
set -euo pipefail
HOME_DIR="${ANTIBODY_HOME:?set ANTIBODY_HOME}"
GROUP=antibody
ROLES="control user agent ingest signer"
[ "$(id -u)" = 0 ] || { echo "run as root: sudo ANTIBODY_HOME=$HOME_DIR $0" >&2; exit 1; }
for role in $ROLES; do [ -d "$HOME_DIR/keys/$role" ] || { echo "missing $HOME_DIR/keys/$role: run antibody setup first" >&2; exit 1; }; done

case "$(uname -s)" in
  Linux)
    getent group "$GROUP" >/dev/null || groupadd --system "$GROUP"
    for role in $ROLES; do
      user="antibody-$role"
      id "$user" >/dev/null 2>&1 || useradd --system --gid "$GROUP" --home-dir "$HOME_DIR" --shell /usr/sbin/nologin "$user"
    done
    ;;
  Darwin)
    # A free id below 500 keeps the accounts off the login window.
    free_id() { # $1 = /Users UniqueID | /Groups PrimaryGroupID
      local used; used="$(dscl . -list "$1" "$2" | awk '{print $2}')"
      for n in $(seq 401 499); do echo "$used" | grep -qx "$n" || { echo "$n"; return; }; done
      echo "no free id in 401-499" >&2; exit 1
    }
    if ! dscl . -read "/Groups/$GROUP" >/dev/null 2>&1; then
      dseditgroup -o create -i "$(free_id /Groups PrimaryGroupID)" -r "Antibody roles" "$GROUP"
    fi
    gid="$(dscl . -read "/Groups/$GROUP" PrimaryGroupID | awk '{print $2}')"
    for role in $ROLES; do
      user="antibody-$role"
      if ! dscl . -read "/Users/$user" >/dev/null 2>&1; then
        uid="$(free_id /Users UniqueID)"
        dscl . -create "/Users/$user"
        dscl . -create "/Users/$user" UniqueID "$uid"
        dscl . -create "/Users/$user" PrimaryGroupID "$gid"
        dscl . -create "/Users/$user" UserShell /usr/bin/false
        dscl . -create "/Users/$user" NFSHomeDirectory /var/empty
        dscl . -create "/Users/$user" RealName "Antibody $role"
        dscl . -create "/Users/$user" Password '*'
        dscl . -create "/Users/$user" IsHidden 1
      fi
      dseditgroup -o edit -a "$user" -t user "$GROUP"
    done
    ;;
  *) echo "unsupported system $(uname -s): see the comment at the top of this script" >&2; exit 1 ;;
esac

# keys/ itself: the group may enter it (to reach its own subdirectory) but not list it.
chown root:"$GROUP" "$HOME_DIR/keys"
chmod 0710 "$HOME_DIR/keys"
for role in $ROLES; do
  user="antibody-$role"
  dir="$HOME_DIR/keys/$role"
  chown -R "$user:$GROUP" "$dir"
  chmod 0700 "$dir"
  find "$dir" -type f -name '*.key' -exec chmod 0600 {} +
done
# Shared state: sockets (run/), per-role logs, and the simulated fixture chain
# and relayer (offline/, SIMULATED backend only). Group members read and write.
for d in run logs offline; do
  mkdir -p "$HOME_DIR/$d"
  chgrp -R "$GROUP" "$HOME_DIR/$d"
  chmod -R g+rwX "$HOME_DIR/$d"
  chmod 2770 "$HOME_DIR/$d"
done
# Control's own state: the text cache (decrypted memories), reports, the high-water mark.
mkdir -p "$HOME_DIR/cache"
chown -R antibody-control:"$GROUP" "$HOME_DIR/cache"
chmod 0700 "$HOME_DIR/cache"
[ -e "$HOME_DIR/hwm.json" ] && chown antibody-control:"$GROUP" "$HOME_DIR/hwm.json" && chmod 0600 "$HOME_DIR/hwm.json"
# Non-secret settings everyone reads; the home is writable by the group for atomic renames.
chgrp "$GROUP" "$HOME_DIR" "$HOME_DIR/antibody.json"
chmod 0640 "$HOME_DIR/antibody.json"
chmod 2770 "$HOME_DIR"
echo "Each role now owns only its own key. Start daemons with ANTIBODY_KEY_ISOLATION=enforce (the live default)."
