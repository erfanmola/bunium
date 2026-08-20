#!/usr/bin/env bash
# Developer workflow wrapping a small Windows box for bunium windows work
# from macOS. Three modes:
#
#   scripts/win-remote.sh push  [user@]host   sync tree + CEF distro, build, smoke
#   scripts/win-remote.sh smoke [user@]host   sync, rebuild, run the basic-window smoke
#   scripts/win-remote.sh pack  [user@]host   sync, rebuild, package the fixture app and
#                                             verify the packaged EXE end-to-end
#                                             (packaging/win/package.sh --verify)
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
    "cd \$HOME/$REMOTE_DIR && "\
    "export PATH=\"\$PWD/native/build:/c/Program Files/LLVM/bin:\$PATH\" && "\
    "bash native/win/build.sh 2>&1 | tail -5 && "\
    "bun examples/basic-window.ts 2>&1 | tee smoke.log"
}

# Same build, then the full packaging pipeline: packaging/win/package.sh
# (CEF staging + launcher exe compile + manifest) and a packaged-app verify
# run. The fixture opens a real window, so the remote session needs access to
# an interactive desktop (same as the dev smoke runs).
build_pack_and_verify() {
  ssh "$HOST" \
    "cd \$HOME/$REMOTE_DIR && "\
    "export PATH=\"\$PWD/native/build:/c/Program Files/LLVM/bin:\$PATH\" && "\
    "bash native/win/build.sh 2>&1 | tail -5 && "\
    "bash packaging/win/package.sh --verify "\
    "  -a packaging/mac/fixture-app -n BuniumFixture -o dist-app 2>&1 | tee pack.log"
}

case "$MODE" in
  push|smoke)
    sync_tree
    build_and_smoke
    ;;
  pack)
    sync_tree
    build_pack_and_verify
    ;;
  *)
    usage
    ;;
esac

echo "logs stay on $HOST at $REMOTE_DIR: smoke.log (smoke) / pack.log (pack)"