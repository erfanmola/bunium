#!/usr/bin/env bash
# Linux counterpart of scripts/verify-platform-package.sh -- proves the
# installed-consumer story end to end for bunium-linux-<arch>: a
# materialized node_modules/bunium (dev tree unreachable) with the staged
# platform package as its sibling, running a real window + paint.
#
#   scripts/verify-platform-package-linux.sh [--stage]
#   --stage  (re)stage release artifacts first (needs native/build-linux +
#             vendor/cef-linux*)
#
# Mirrors what a fresh npm install of "bunium" + "bunium-linux-<arch>"
# would resolve: src/paths.ts finds no dev tree, so it falls back to the
# platform package via import.meta.resolve. Exit 0 = PASS. Needs a real or
# Xvfb X server on $DISPLAY (the fixture opens a real window).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if [ "${1:-}" = "--stage" ]; then
  "$SCRIPT_DIR/stage-release-artifacts-linux.sh"
fi

case "$(uname -m)" in
  aarch64 | arm64) ARCH="arm64" ;;
  x86_64 | amd64) ARCH="x64" ;;
  *) echo "error: unsupported arch $(uname -m)" >&2; exit 1 ;;
esac
PKG_NAME="bunium-linux-$ARCH"
PKG_DIR="$REPO_ROOT/dist-release/$PKG_NAME"
[ -f "$PKG_DIR/shim/bunium_shim.so" ] || {
  echo "error: $PKG_DIR missing -- run scripts/stage-release-artifacts-linux.sh first" >&2
  exit 1
}

CONSUMER="$REPO_ROOT/dist-release/_consumer_linux"
rm -rf "$CONSUMER"
mkdir -p "$CONSUMER/node_modules/bunium"
# No rsync dependency (not guaranteed present on every Linux host) -- tar
# pipe copy, same approach as packaging/linux/package.sh.
(cd "$REPO_ROOT/src" && tar cf - .) | (mkdir -p "$CONSUMER/node_modules/bunium/src" && cd "$CONSUMER/node_modules/bunium/src" && tar xf -)
cp "$REPO_ROOT/package.json" "$CONSUMER/node_modules/bunium/package.json"
ln -sfn "$PKG_DIR" "$CONSUMER/node_modules/$PKG_NAME"
# Script run relative to the consumer so import.meta.resolve of
# "bunium-linux-<arch>" walks the consumer's own node_modules.
cp "$SCRIPT_DIR/verify-platform-package-main.ts" "$CONSUMER/main.ts"

cd "$CONSUMER"
BUN_BIN="$(command -v bun || echo "$HOME/.bun/bin/bun")"
"$BUN_BIN" main.ts
