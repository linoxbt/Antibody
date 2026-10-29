#!/usr/bin/env bash
# Antibody installer: downloads Antibody, installs its dependencies and adds an
# `antibody` command. Re-running it updates an existing install.
#
#   curl -fsSL https://antibody-memory.netlify.app/install.sh | bash
#
# Settings (optional): ANTIBODY_APP_DIR (default ~/.antibody-app),
# ANTIBODY_BIN_DIR (default ~/.local/bin), ANTIBODY_REPO, ANTIBODY_REF, ANTIBODY_NO_SHORTCUTS.
# Your data and keys live in ~/.antibody (ANTIBODY_HOME); this script never touches them.
set -euo pipefail

REPO="${ANTIBODY_REPO:-https://github.com/linoxbt/Antibody.git}"
REF="${ANTIBODY_REF:-main}"
DIR="${ANTIBODY_APP_DIR:-$HOME/.antibody-app}"
BIN="${ANTIBODY_BIN_DIR:-$HOME/.local/bin}"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
ok() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
fail() {
  printf '\n\033[31m✗ %s\033[0m\n' "$1" >&2
  shift
  for line in "$@"; do printf '  %s\n' "$line" >&2; done
  printf '\n  More fixes: https://antibody-memory.netlify.app/install#troubleshooting\n' >&2
  exit 1
}

bold "Antibody installer"

WINDOWS=0
case "$(uname -s)" in
  Linux | Darwin) ok "$(uname -s) detected" ;;
  MINGW* | MSYS* | CYGWIN*) WINDOWS=1; ok "Windows (Git Bash) detected" ;;
  *) fail "Unsupported system: $(uname -s)." "Antibody runs on macOS, Linux and Windows." ;;
esac

command -v git >/dev/null 2>&1 || fail "git is not installed." "macOS: xcode-select --install" "Ubuntu/Debian: sudo apt update && sudo apt install -y git" "Fedora: sudo dnf install -y git" "Windows: winget install --id Git.Git -e"
ok "git $(git --version | awk '{print $3}')"

if [ "$WINDOWS" = 1 ]; then NODE_HINT="Windows: winget install OpenJS.NodeJS.LTS (then open a new Git Bash window)"; else NODE_HINT="Easiest: install nvm (https://github.com/nvm-sh/nvm), then: nvm install 22"; fi
command -v node >/dev/null 2>&1 || fail "Node.js is not installed (Antibody needs version 22 or newer)." \
  "$NODE_HINT" \
  "Or download the LTS installer from https://nodejs.org"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 22 ] || fail "Node.js $(node -v) is too old; Antibody needs 22 or newer." "$NODE_HINT" "Then open a new terminal and run this installer again."
ok "Node.js $(node -v)"
command -v npm >/dev/null 2>&1 || fail "npm is missing." "npm ships with Node.js: reinstall Node 22 (nvm install 22)."
ok "npm $(npm -v)"

if [ -d "$DIR/.git" ]; then
  bold "Updating $DIR"
  git -C "$DIR" fetch --depth 1 origin "$REF" || fail "Could not reach GitHub to update." "Check your internet connection, or a proxy/firewall blocking github.com."
  git -C "$DIR" checkout -q -B "$REF" FETCH_HEAD
elif [ -e "$DIR" ]; then
  fail "$DIR exists but is not an Antibody install." "Move it away, or choose another folder: ANTIBODY_APP_DIR=~/antibody-app bash install.sh"
else
  bold "Downloading Antibody into $DIR"
  git clone -q --depth 1 --branch "$REF" "$REPO" "$DIR" || fail "Could not download Antibody from $REPO." "Check your internet connection, or a proxy/firewall blocking github.com."
fi
ok "source at $(git -C "$DIR" rev-parse --short HEAD)"

bold "Installing dependencies (about a minute)"
(cd "$DIR" && npm ci --omit=dev --no-audit --no-fund --loglevel=error) || fail "npm could not install the dependencies." \
  "Out of disk space? Free some and re-run." \
  "Behind a proxy? npm config set proxy http://host:port" \
  "Then re-run this installer; it picks up where it stopped."
ok "dependencies installed"
(cd "$DIR" && node --import tsx scripts/build-site.ts >/dev/null 2>&1) && ok "recorded demo built" || echo "  (recorded demo skipped: the console still works; Enter the demo will not)"

mkdir -p "$BIN" || fail "Could not create $BIN." "Pick another folder you own: ANTIBODY_BIN_DIR=~/bin bash install.sh"
cat >"$BIN/antibody" <<SH
#!/usr/bin/env bash
exec node "$DIR/bin/antibody.mjs" "\$@"
SH
chmod +x "$BIN/antibody"
ok "command installed at $BIN/antibody"

# An app launcher entry: opens the console signed in, starting Antibody first if needed.
if [ -z "${ANTIBODY_NO_SHORTCUTS:-}" ] && [ "$WINDOWS" = 0 ]; then
  case "$(uname -s)" in
    Linux)
      APPS="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
      if mkdir -p "$APPS" 2>/dev/null; then
        cat >"$APPS/antibody.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Antibody
Comment=Open the Antibody console
Exec="$BIN/antibody" open
Icon=$DIR/web/assets/img/icon-512.png
Terminal=false
Categories=Utility;Security;
DESKTOP
        ok "app launcher entry added (Antibody in your applications menu)"
      fi
      ;;
    Darwin)
      APP="$HOME/Applications/Antibody.app"
      if command -v osacompile >/dev/null 2>&1 && mkdir -p "$HOME/Applications"; then
        rm -rf "$APP"
        if osacompile -o "$APP" -e "do shell script quoted form of \"$BIN/antibody\" & \" open >/dev/null 2>&1 &\"" >/dev/null 2>&1; then
          # The Antibody icon instead of the generic script one (best effort).
          if command -v sips >/dev/null 2>&1; then
            sips -s format icns "$DIR/web/assets/img/icon-512.png" --out "$APP/Contents/Resources/applet.icns" >/dev/null 2>&1 || true
            touch "$APP"
          fi
          ok "Antibody.app added to ~/Applications"
        fi
      fi
      ;;
  esac
fi

"$BIN/antibody" --help >/dev/null 2>&1 || fail "The antibody command did not start." "Run it directly to see why: node $DIR/bin/antibody.mjs --help"

echo
bold "Antibody is installed."
case ":$PATH:" in
  *":$BIN:"*) ;;
  *)
    SHELL_RC="$HOME/.bashrc"
    [ "$(basename "${SHELL:-}")" = "zsh" ] && SHELL_RC="$HOME/.zshrc"
    echo "  $BIN is not on your PATH yet. Add it once:"
    echo "    echo 'export PATH=\"$BIN:\$PATH\"' >> $SHELL_RC && source $SHELL_RC"
    echo
    ;;
esac
echo "  Try it (simulated, no keys needed):"
echo "    antibody setup     # keys and a practice account"
echo "    antibody up        # starts Antibody and prints your sign-in link"
echo "  Then open it any time with: antibody open (or the Antibody app icon)"
echo
echo "  Guide: https://antibody-memory.netlify.app/install"
