#!/usr/bin/env bash
# Guards against the exact class of bug found during the Linux IPC-latency
# re-verification (2026-08-31, see benchmark/RESULTS.md's "Linux IPC
# latency re-verified" section): a checked-in-at-some-point dev-tree build
# artifact (native/build*/bunium_shim.{so,dylib,dll}) silently drifting
# behind its own source files. That incident was caught loudly (bun:ffi
# threw a Symbol-not-found error because the stale .so was missing a whole
# new export) -- but a signature-compatible, behaviorally-stale rebuild
# would have failed *silently* instead, producing correct-looking output
# with an old code path underneath. This script makes that check explicit
# and fast, instead of relying on luck (a hard ffi crash) every time.
#
# Usage: scripts/check-native-freshness.sh [mac|linux|win] [--fix]
#   No args: auto-detects platform from `uname` (mac/linux only --
#            Windows must be passed explicitly since this runs under
#            Git Bash there, which reports as a POSIX-ish uname).
#   --fix:   rebuilds automatically (via the platform's own
#            native/<platform>/build.sh) instead of just failing.
#
# Exit codes: 0 = fresh (or freshly rebuilt with --fix), 1 = stale
# (without --fix), 2 = artifact missing entirely, 3 = usage error.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

FIX=0
PLATFORM=""
for arg in "$@"; do
  case "$arg" in
    --fix) FIX=1 ;;
    mac | linux | win) PLATFORM="$arg" ;;
    *)
      echo "usage: $0 [mac|linux|win] [--fix]" >&2
      exit 3
      ;;
  esac
done

if [ -z "$PLATFORM" ]; then
  case "$(uname -s)" in
    Darwin) PLATFORM=mac ;;
    Linux) PLATFORM=linux ;;
    *)
      echo "Cannot auto-detect platform from uname -- pass mac, linux, or win explicitly." >&2
      exit 3
      ;;
  esac
fi

# Shared sources every platform compiles unmodified (see each build.sh's
# own comments -- this is the exact file set that caused the Linux
# incident: Linux's build.sh compiles these straight from native/mac/
# with no copy step, so "the source changed" always means these paths,
# regardless of which platform you're checking).
SHARED_SRCS=(
  "$REPO_ROOT/native/mac/bunium_shim.cpp"
  "$REPO_ROOT/native/mac/bunium_common.h"
  "$REPO_ROOT/native/mac/subprocess_main.cpp"
  "$REPO_ROOT/native/mac/bunium_bsdiff_wrap.mm"
)

case "$PLATFORM" in
  mac)
    OUT_DIR="$REPO_ROOT/native/build"
    ARTIFACT="$OUT_DIR/bunium_shim.dylib"
    PLATFORM_SRCS=(
      "$REPO_ROOT/native/mac/bunium_window_mac.mm"
      "$REPO_ROOT/native/mac/bunium_system_mac.mm"
      "$REPO_ROOT/native/mac/bunium_system_notify_mac.mm"
      "$REPO_ROOT/native/mac/bunium_system_dialogs_mac.mm"
    )
    BUILD_CMD=("$REPO_ROOT/native/mac/build.sh")
    ;;
  linux)
    OUT_DIR="$REPO_ROOT/native/build-linux"
    ARTIFACT="$OUT_DIR/bunium_shim.so"
    PLATFORM_SRCS=("$REPO_ROOT"/native/linux/bunium_*.cc)
    BUILD_CMD=("$REPO_ROOT/native/linux/build.sh")
    ;;
  win)
    OUT_DIR="$REPO_ROOT/native/build"
    ARTIFACT="$OUT_DIR/bunium_shim.dll"
    PLATFORM_SRCS=("$REPO_ROOT"/native/win/bunium_*.cpp)
    BUILD_CMD=("$REPO_ROOT/native/win/build.sh")
    ;;
esac

if [ ! -f "$ARTIFACT" ]; then
  echo "MISSING: $ARTIFACT does not exist -- run: ${BUILD_CMD[*]}" >&2
  exit 2
fi

artifact_mtime() {
  # BSD stat (mac) vs GNU stat (linux) vs Git-Bash stat (win, GNU-flavored)
  # take incompatible flags -- try GNU form first, fall back to BSD form.
  stat -c %Y "$1" 2>/dev/null || stat -f %m "$1"
}

ARTIFACT_MTIME="$(artifact_mtime "$ARTIFACT")"
STALE_FILES=()

for src in "${SHARED_SRCS[@]}" "${PLATFORM_SRCS[@]}"; do
  [ -f "$src" ] || continue
  SRC_MTIME="$(artifact_mtime "$src")"
  if [ "$SRC_MTIME" -gt "$ARTIFACT_MTIME" ]; then
    STALE_FILES+=("$src")
  fi
done

if [ "${#STALE_FILES[@]}" -eq 0 ]; then
  echo "FRESH: $ARTIFACT is newer than all checked sources."
  exit 0
fi

echo "STALE: $ARTIFACT predates ${#STALE_FILES[@]} source file(s):" >&2
for f in "${STALE_FILES[@]}"; do
  echo "  - $f" >&2
done

if [ "$FIX" -eq 1 ]; then
  echo "Rebuilding via ${BUILD_CMD[*]}..." >&2
  "${BUILD_CMD[@]}"
  echo "FIXED: rebuilt $ARTIFACT." >&2
  exit 0
fi

echo "Run with --fix, or manually: ${BUILD_CMD[*]}" >&2
exit 1
