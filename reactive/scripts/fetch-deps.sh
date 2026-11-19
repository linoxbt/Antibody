#!/usr/bin/env bash
# Fetch the Reactive Network contract library at a pinned commit (not vendored: it is UNLICENSED).
set -euo pipefail
cd "$(dirname "$0")/.."
REPO=https://github.com/Reactive-Network/reactive-lib-omni.git
COMMIT=3ade0dcf1d27e67e5783ef807e73a1b9e0c0cce8
DIR=lib/reactive-lib-omni
if [ ! -d "$DIR/.git" ]; then git clone -q "$REPO" "$DIR"; fi
git -C "$DIR" fetch -q --depth 1 origin "$COMMIT"
git -C "$DIR" checkout -q --detach "$COMMIT"
echo "reactive-lib-omni at $(git -C "$DIR" rev-parse --short HEAD)"
