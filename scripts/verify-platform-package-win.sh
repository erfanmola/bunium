#!/usr/bin/env bash
# Windows counterpart of scripts/verify-platform-package.sh /
# verify-platform-package-linux.sh -- proves the installed-consumer story
# end to end for bunium-win32-x64: a materialized node_modules/bunium (dev
# tree unreachable) with the staged platform package as its sibling,
# running a real window + paint.
#
#   scripts/verify-platform-package-win.sh [--stage]
#   --stage  (re)stage release artifacts first (needs native/build +
#             vendor/cef-windows-x64)
#
# Mirrors what a fresh npm install of "bunium" + "bunium-win32-x64" would
# resolve: src/paths.ts finds no dev tree, so it falls back to the platform
# package via import.meta.resolve. Exit 0 = PASS. MUST run on Windows (Git
# Bash) -- same real-window/desktop-session requirement as the mac/Linux
# verifiers.
set -euo pipefail
export MSYS2_ARG_CONV_EXCL='*'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -W 2>/dev/null || pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -W 2>/dev/null || pwd)"

if [ "${1:-}" = "--stage" ]; then
  "$SCRIPT_DIR/stage-release-artifacts-win.sh"
fi

PKG_NAME="bunium-win32-x64"
PKG_DIR="$REPO_ROOT/dist-release/$PKG_NAME"
[ -f "$PKG_DIR/shim/bunium_shim.dll" ] || {
  echo "error: $PKG_DIR missing -- run scripts/stage-release-artifacts-win.sh first" >&2
  exit 1
}

CONSUMER="$REPO_ROOT/dist-release/_consumer_win"
rm -rf "$CONSUMER"
mkdir -p "$CONSUMER/node_modules/bunium"
tar -C "$REPO_ROOT/src" -cf - . | (mkdir -p "$CONSUMER/node_modules/bunium/src" && cd "$CONSUMER/node_modules/bunium/src" && tar -xf -)
cp "$REPO_ROOT/package.json" "$CONSUMER/node_modules/bunium/package.json"
# No symlink support assumption on Windows/Git-Bash filesystems -- copy the
# staged package instead of ln -sfn (mac/Linux use symlinks; NTFS symlinks
# need elevated privileges by default, so a real copy is the portable choice
# here).
mkdir -p "$CONSUMER/node_modules/$PKG_NAME"
tar -C "$PKG_DIR" -cf - . | (cd "$CONSUMER/node_modules/$PKG_NAME" && tar -xf -)
# Script run relative to the consumer so import.meta.resolve of
# "bunium-win32-x64" walks the consumer's own node_modules.
cp "$SCRIPT_DIR/verify-platform-package-main.ts" "$CONSUMER/main.ts"

cd "$CONSUMER"
BUN_BIN="$(command -v bun)"
"$BUN_BIN" main.ts
