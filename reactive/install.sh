#!/usr/bin/env bash
# Install `guard`, the Antibody Guard command line: curl -fsSL https://antibody-guard.netlify.app/install.sh | bash
# Needs git and Node.js 22+. Installs into ~/.antibody-guard/app and puts `guard` in ~/.local/bin.
set -euo pipefail
REPO="${GUARD_REPO:-https://github.com/linoxbt/Antibody}"
REF="${GUARD_REF:-reactive-guard}"
APP="${GUARD_APP_DIR:-$HOME/.antibody-guard/app}"
BIN="${GUARD_BIN_DIR:-$HOME/.local/bin}"

command -v git >/dev/null || { echo "guard: git is required" >&2; exit 1; }
command -v node >/dev/null || { echo "guard: Node.js 22 or newer is required (https://nodejs.org)" >&2; exit 1; }
major="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$major" -lt 22 ]; then echo "guard: Node.js 22 or newer is required (found $(node -v))" >&2; exit 1; fi

if [ -d "$APP/.git" ]; then
  echo "Updating $APP"
  git -C "$APP" fetch -q --depth 1 origin "$REF"
  git -C "$APP" checkout -q --detach FETCH_HEAD
else
  echo "Installing into $APP"
  mkdir -p "$(dirname "$APP")"
  git clone -q --depth 1 --branch "$REF" "$REPO" "$APP"
fi
( cd "$APP/reactive" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error )

mkdir -p "$BIN"
cat > "$BIN/guard" <<SH
#!/bin/sh
exec node "$APP/reactive/bin/guard.mjs" "\$@"
SH
chmod +x "$BIN/guard"
echo "Installed: $BIN/guard ($(git -C "$APP" rev-parse --short HEAD))"
case ":$PATH:" in *":$BIN:"*) ;; *) echo "Add $BIN to your PATH, for example: echo 'export PATH=\"$BIN:\$PATH\"' >> ~/.profile" ;; esac
echo "Next: guard keys new owner && guard keys new agent && guard help"
