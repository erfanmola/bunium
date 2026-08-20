#!/usr/bin/env bash
# Developer workflow wrapping a small Windows box for bunium windows work
# from macOS. Two modes:
#
#   scripts/win-remote.sh push  [user@]host   sync tree + CEF distro, build, smoke
#   scripts/win-remote.sh smoke [user@]host   sync, rebuild, run the basic-window smoke
#
# Remote host assumptions (Windows, Git Bash): clang-cl on PATH (LLVM), bun on
# PATH, rsync reachable as `rsync`, and a normal ssh server. CEF is git-ignored
# so carry vendor/cef-windows-x64 explicitly.
#
# The mac-side flow: everything runs on the Windows box; only logs stream back.
set -euo pipefail

HOST=""
MODE=""

usage() {
  sed -n '2,14p' "$0"
  exit 1
}

[ $# -ge 1 ] || usage
MODE="$1"; shift
[ $# -ge 1 ] || usage
HOST="$1"; shift

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REMOTE_DIR="~/bunium-win"

# Sync an optional path (first arg = source). Tree is always pushed fresh;
# native build dirs are git-ignored and never synced -- the CEF distro is the
# exception (needed on the box, too big to re-download every time).
sync_tree() {
  rsync -az --delete \
    --exclude '.git' \
    --exclude 'node_modules' \
    --exclude '.github/workflows' \
    "$REPO/" "$HOST:$REMOTE_DIR/"
  rsync -az \
    "$REPO/vendor/cef-windows-x64/" "$HOST:$REMOTE_DIR/vendor/cef-windows-x64/"
}

# Remote command runs under the Windows Git Bash + clang-cl + bun on PATH,
# with native/build on PATH so the shim's dll deps resolve (see
# docs/guide/windows.md -> "DLL search-order gotcha").
build_and_smoke() {
  ssh "$HOST" \
    "cd '$REMOTE_DIR' && \
     export PATH='$REMOTE_DIR/native/build:/c/Program Files/LLVM/bin:\$PATH' && \
     bash native/win/build.sh 2>&1 | tail -5 && \
     bun examples/basic-window.ts 2>&1 | tee smoke.log"
}

case "$MODE" in
  push|smoke)
    sync_tree
    build_and_smoke
    ;;
  *)
    usage
    ;;
esac

echo "logs stay on $HOST at $REMOTE_DIR/smoke.log"