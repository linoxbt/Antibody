#!/usr/bin/env bash
# Assemble the Guard status site into reactive/web-dist (brand assets copied from the main site).
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=web-dist
rm -rf "${OUT:?}" && mkdir -p "$OUT/assets/fonts"
cp web/index.html web/netlify.toml "$OUT/"
cp web/guard.css "$OUT/assets/guard.css"
cp ../web/assets/img/mark.svg ../web/assets/img/favicon.svg "$OUT/assets/"
cp ../web/assets/fonts/dm-sans-latin-wght-normal.woff2 "$OUT/assets/fonts/dm-sans.woff2"
cp ../web/assets/fonts/jetbrains-mono-latin-wght-normal.woff2 "$OUT/assets/fonts/jetbrains-mono.woff2"
cp ../web/assets/fonts/LICENSE.md "$OUT/assets/fonts/"
echo "built $OUT"
