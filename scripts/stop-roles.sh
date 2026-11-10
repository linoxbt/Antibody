#!/usr/bin/env bash
# Stop the daemons started by scripts/start-roles.sh.
H="${ANTIBODY_HOME:?set ANTIBODY_HOME}"
for r in ingest agent control signer; do
  [ -f "$H/run/$r.pid" ] && kill "$(cat "$H/run/$r.pid")" 2>/dev/null && echo "stopped $r"
  rm -f "$H/run/$r.pid"
done
