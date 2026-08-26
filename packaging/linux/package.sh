#!/usr/bin/env bash
# Packages a built bunium app (create-bunium-app output: electron/main.ts +
# built dist/ + a "bunium" package.json dependency) into a flat Linux
# directory layout -- the Linux counterpart of packaging/mac/package.sh and
# packaging/win/package.sh.
#
# X11 has no bundle/framework concept (like Windows, unlike macOS' .app),
# and unlike Windows a shell script has neither a console-flash problem nor
# a shebang-exec limitation -- so the launcher here is a plain shell script
# (mac's approach), not a compiled binary (win's approach, forced by
# Windows GUI-subsystem/console-flash constraints that don't apply here).
#
# Bundle layout produced:
#   Out/Name/
#     Name              shell launcher: exports BUNIUM_SHIM_PATH/
#                       BUNIUM_SUBPROCESS_PATH/BUNIUM_FRAMEWORK_DIR/
#                       BUNIUM_RESOURCES_DIR/BUNIUM_ROOT_CACHE_PATH (see
#                       src/paths.ts + src/native.ts for what each governs)
#                       then execs `bun app/electron/main.ts`
#     bun               the Bun binary itself (copied from $BUN_BIN)
#     Runtime/          bunium_shim.so + bunium_subprocess + libcef.so +
#                       icudtl.dat + v8_context_snapshot.bin +
#                       chrome_*.pak/resources.pak + locales/ -- ALL in one
#                       merged directory, matching native/linux/build.sh's
#                       own native/build-linux/ output exactly (the
#                       already-proven-working set across the full 35/37
#                       examples sweep) and the bunium-linux-<arch> platform
#                       package layout in src/paths.ts (frameworkDir ==
#                       resourcesDir == one "framework/" dir there too).
#                       This single-dir merge exists because Chrome-runtime
#                       resolves chrome_*.pak/locale paks/icudtl.dat/the V8
#                       snapshot RELATIVE TO libcef.so's OWN DIRECTORY
#                       (base::DIR_MODULE / dladdr), independent of
#                       CefSettings.resources_dir_path -- see the
#                       native/linux/build.sh comment for the exact crash
#                       this caused when the two lookup paths first
#                       diverged (silent SIGTRAP inside LoadLocalState).
#                       bunium_shim.so/bunium_subprocess use an
#                       $ORIGIN-relative rpath (native/linux/build.sh), so
#                       libcef.so resolves automatically from this same
#                       dir with no LD_LIBRARY_PATH needed.
#     app/              dist/ + electron/main.ts + package.json + a real
#                       (not symlinked) node_modules/bunium materialized
#                       from src/ + package.json
#
# No codesign story (Linux has none locally-relevant), no DMG/deb/rpm/
# AppImage (true distribution packaging is a documented v2 follow-up, see
# docs/guide/packaging.md and PLAN.md Phase 6 Linux known-gaps) -- this is
# the pragmatic "ship a runnable directory" v1, matching the project's
# "ship what's proven, document the gap" pattern.
#
# Usage:
#   packaging/linux/package.sh -a <app-dir> [-n Name] [-o out-dir]
#     [-r bunium-repo] [-b /path/to/bun] [-v 1.0.0] [--locales en[,de,...]]
#     [--verify]
#
# --verify runs the freshly packaged Name launcher and requires the app to
# emit PACKAGED_APP_VERIFY:PASS before exiting (needs a real or Xvfb X
# server on $DISPLAY -- the fixture opens a real window). The mac packaging
# fixture doubles as the Linux verifier too: packaging/mac/fixture-app.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
# Phase 10 CEF resource trim, shared with any future release pipeline
# (mirrors packaging/mac/package.sh's own `source .../cef-trim.sh`).
source "$SCRIPT_DIR/cef-trim.sh"

NAME=""
VERSION="1.0.0"
APP_DIR=""
OUT_DIR="$REPO_ROOT/dist-app"
BUNIUM_REPO="$REPO_ROOT"
BUN_BIN="$(command -v bun || true)"
LOCALES="all" # comma list (e.g. "en") trims locales/ to a keeplist
VERIFY=0
# Phase 10 CEF resource trim (SwiftShader software-Vulkan stack -- see
# cef-trim.sh). Default on, matching mac/win's own default-on posture.
TRIM_CEF=1

usage() {
  sed -n '2,40p' "$0" | grep -E '^#|^$' | sed 's/^# //; s/^#$//'
  exit 1
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    -a) APP_DIR="$2"; shift 2 ;;
    -n) NAME="$2"; shift 2 ;;
    -o) OUT_DIR="$2"; shift 2 ;;
    -r) BUNIUM_REPO="$2"; shift 2 ;;
    -b) BUN_BIN="$2"; shift 2 ;;
    -v) VERSION="$2"; shift 2 ;;
    --locales) LOCALES="$2"; shift 2 ;;
    --verify) VERIFY=1; shift ;;
    --no-trim) TRIM_CEF=0; shift ;;
    *) echo "unknown option: $1" >&2; usage ;;
  esac
done

[ -n "$APP_DIR" ] || { echo "missing -a <app-dir>" >&2; usage; }
[ -d "$APP_DIR/electron" ] || { echo "error: $APP_DIR/electron missing (main-process dir)" >&2; exit 1; }
[ -d "$APP_DIR/dist" ] || { echo "error: $APP_DIR/dist missing -- run the app's build first" >&2; exit 1; }
[ -f "$APP_DIR/electron/main.ts" ] || { echo "error: $APP_DIR/electron/main.ts missing" >&2; exit 1; }
[ -n "$NAME" ] || NAME="$(basename "$APP_DIR")"
case "$NAME" in
  *" "*) echo "error: app name must not contain spaces (launcher layout)" >&2; exit 1 ;;
esac
# Note: no -f/-x precheck here -- some sandboxed shells (e.g. tool-runner
# sandboxes that hide parts of $HOME from stat() but still allow execve())
# report false negatives for real, runnable binaries under $HOME/.bun. The
# `cp` below is the real, reliable check -- it fails loudly if BUN_BIN is
# actually missing.
[ -n "$BUN_BIN" ] || { echo "error: bun binary not found (pass -b)" >&2; exit 1; }

case "$(uname -m)" in
  aarch64 | arm64) CEF_PLATFORM=linuxarm64 ;;
  x86_64 | amd64) CEF_PLATFORM=linux64 ;;
  *) echo "error: unsupported arch $(uname -m)" >&2; exit 1 ;;
esac

BUILD_DIR="$BUNIUM_REPO/native/build-linux"
CEF_RELEASE="$BUNIUM_REPO/vendor/cef-${CEF_PLATFORM}/Release"
CEF_RESOURCES="$BUNIUM_REPO/vendor/cef-${CEF_PLATFORM}/Resources"
[ -f "$BUILD_DIR/bunium_shim.so" ] || { echo "error: $BUILD_DIR/bunium_shim.so missing -- run bash native/linux/build.sh first" >&2; exit 1; }
[ -f "$BUILD_DIR/bunium_subprocess" ] || { echo "error: $BUILD_DIR/bunium_subprocess missing -- run bash native/linux/build.sh first" >&2; exit 1; }
[ -d "$CEF_RESOURCES" ] || { echo "error: vendored CEF resources not found at $CEF_RESOURCES" >&2; exit 1; }

PACKAGE="$OUT_DIR/$NAME"
echo "packaging $APP_DIR -> $PACKAGE"
rm -rf "$PACKAGE"
mkdir -p "$PACKAGE/Runtime" "$PACKAGE/app"

# --- Runtime: everything native/linux/build.sh already proved works
# together in native/build-linux/ (shim, subprocess, libcef.so, icudtl.dat,
# v8 snapshot, paks, locales), plus the CEF distro's own chrome-sandbox
# helper if present. ---
cp "$BUILD_DIR/bunium_shim.so" "$PACKAGE/Runtime/"
cp "$BUILD_DIR/bunium_subprocess" "$PACKAGE/Runtime/"
cp "$BUILD_DIR/libcef.so" "$PACKAGE/Runtime/"
cp "$BUILD_DIR/icudtl.dat" "$PACKAGE/Runtime/"
cp "$BUILD_DIR/v8_context_snapshot.bin" "$PACKAGE/Runtime/"
cp "$BUILD_DIR/"*.pak "$PACKAGE/Runtime/"
cp -R "$CEF_RESOURCES/locales" "$PACKAGE/Runtime/"
# Phase 10 trim (default on, --no-trim override). Note native/linux/
# build.sh own dev output (BUILD_DIR) never copies the SwiftShader stack
# into native/build-linux/ in the first place (only libcef.so, icudtl.dat,
# the V8 snapshot and the paks/locales -- see that script), so this only
# matters for anything that DOES land it under Runtime/ later.
if [ "$TRIM_CEF" -eq 1 ]; then
  trim_cef_runtime "$PACKAGE/Runtime"
fi

# --- Optional locale trim (Chromium falls back to en-US strings when a
# requested locale's pak is absent -- a trimmed app still runs, just with
# untranslated browser-chrome dialogs). Linux locale paks are flat BCP-47
# names like Windows (en-US.pak), not macOS' *.lproj dirs. ---
if [ "$LOCALES" != "all" ]; then
  IFS=',' read -ra KEEP <<< "$LOCALES"
  for f in "$PACKAGE/Runtime/locales/"*.pak; do
    base="$(basename "$f" .pak)"
    keepit=0
    for l in "${KEEP[@]}"; do
      if [ "$l" = "$base" ] || [ "$l-US" = "$base" ]; then
        keepit=1
        break
      fi
    done
    [ "$keepit" -eq 1 ] || rm -f "$f"
  done
fi

# --- app/: the user app (dist/ + electron/ + package.json) + a real (not
# symlinked) node_modules/bunium materialized from the bunium repo so
# "import { app } from 'bunium'" resolves inside the package. ---
resource_app="$PACKAGE/app"
mkdir -p "$resource_app"
# cp -a (not rsync -- not guaranteed present) with a manual node_modules/.git
# exclude via tar piping, which cp has no native equivalent for.
(cd "$APP_DIR" && tar cf - --exclude=node_modules --exclude=.git .) | (cd "$resource_app" && tar xf -)
mkdir -p "$resource_app/node_modules/bunium"
(cd "$BUNIUM_REPO/src" && tar cf - .) | (cd "$resource_app/node_modules/bunium" && mkdir -p src && cd src && tar xf -)
cp "$BUNIUM_REPO/package.json" "$resource_app/node_modules/bunium/package.json"

# --- bun binary ---
cp "$BUN_BIN" "$PACKAGE/bun"

# --- The launcher: a plain shell script suffices on Linux (no shebang-exec
# limitation and no console-flash problem the way Windows has, so no
# compiled-launcher workaround needed here -- mirrors macOS' approach). ---
cat > "$PACKAGE/$NAME" <<EOF
#!/bin/sh
# bunium packaged launcher -- see packaging/linux/package.sh for the layout.
APP_ROOT="\$(cd "\$(dirname "\$0")" && pwd)"
export BUNIUM_SHIM_PATH="\$APP_ROOT/Runtime/bunium_shim.so"
export BUNIUM_SUBPROCESS_PATH="\$APP_ROOT/Runtime/bunium_subprocess"
export BUNIUM_FRAMEWORK_DIR="\$APP_ROOT/Runtime"
export BUNIUM_RESOURCES_DIR="\$APP_ROOT/Runtime"
CACHE_ROOT="\${XDG_CACHE_HOME:-\$HOME/.cache}/$NAME/CEF"
mkdir -p "\$CACHE_ROOT"
export BUNIUM_ROOT_CACHE_PATH="\$CACHE_ROOT"
exec "\$APP_ROOT/bun" "\$APP_ROOT/app/electron/main.ts" "\$@"
EOF
chmod +x "$PACKAGE/$NAME"

echo "package: $PACKAGE ($(du -sh "$PACKAGE" | awk '{print $1}'))"
echo "  launcher: $PACKAGE/$NAME"

if [ "$VERIFY" -eq 1 ]; then
  echo "verify: running packaged app (real window; needs \$DISPLAY, e.g. Xvfb)..."
  VLOG="$OUT_DIR/.verify-$NAME.log"
  "$PACKAGE/$NAME" > "$VLOG" 2>&1 || true
  cat "$VLOG"
  if grep -q "PACKAGED_APP_VERIFY:PASS" "$VLOG"; then
    echo "verify: PASS"
  else
    echo "verify: FAIL (no PACKAGED_APP_VERIFY:PASS in $VLOG)" >&2
    exit 1
  fi
fi
