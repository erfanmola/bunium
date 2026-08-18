#!/usr/bin/env bash
# Phase 11 verification harness: proves the installed-consumer story end to
# end -- a materialized node_modules/bunium (no dev tree reachable) with the
# staged platform package as its sibling, running a real window + paint.
#
#   scripts/verify-platform-package.sh [--stage]
#   --stage  (re)stage release artifacts first (needs native/build + vendor/)
#
# Mirrors what a fresh npm install of "bunium" + "bunium-darwin-arm64" would
# resolve: src/paths.ts finds no dev tree, so it falls back to the platform
# package via import.meta.resolve. Exit 0 = PASS.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if [ "${1:-}" = "--stage" ]; then
  "$SCRIPT_DIR/stage-release-artifacts.sh"
fi

PKG_DIR="$REPO_ROOT/dist-release/bunium-darwin-arm64"
[ -f "$PKG_DIR/shim/bunium_shim.dylib" ] || {
  echo "error: $PKG_DIR missing -- run scripts/stage-release-artifacts.sh first" >&2
  exit 1
}

CONSUMER="$REPO_ROOT/dist-release/_consumer"
rm -rf "$CONSUMER"
mkdir -p "$CONSUMER/node_modules/bunium"
rsync -a "$REPO_ROOT/src/" "$CONSUMER/node_modules/bunium/src/"
cp "$REPO_ROOT/package.json" "$CONSUMER/node_modules/bunium/package.json"
ln -sfn "$PKG_DIR" "$CONSUMER/node_modules/bunium-darwin-arm64"
# Script run relative to the consumer so import.meta.resolve of
# "bunium-darwin-arm64" walks the consumer's own node_modules.
cp "$SCRIPT_DIR/verify-platform-package-main.ts" "$CONSUMER/main.ts"

cd "$CONSUMER"
bun main.ts
