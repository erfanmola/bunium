#!/usr/bin/env bash
# Packages a built bunium app (create-bunium-app output: bunium/main.ts +
# built dist/ + a "bunium" package.json dependency) into a macOS .app bundle
# (and optionally a DMG), with the dev-tree-native-path assumptions reworked
# for the standard bundled layout -- this is the Phase 8 redo of the
# ARCHITECTURE.md §5 install_name_tool rewrite, which injected absolute
# dev-tree paths into bunium_shim.dylib/bunium_subprocess during development.
#
# Bundle layout produced:
#   Out/Name.app/
#     Contents/
#       Info.plist
#       MacOS/
#         Name          # shell launcher: exports BUNIUM_* env vars (see
#                        # src/native.ts for which paths they override) then
#                        # execs `bun Resources/app/bunium/main.ts`
#         bun           # the Bun binary itself (copied from $BUN_BIN)
#       Frameworks/
#         Chromium Embedded Framework.framework/
#         bunium_shim.dylib          # LC_LOAD_DYLIB rewritten to @loader_path/
#         bunium_subprocess          # ditto
#         libEGL/libGLESv2/...       # ANGLE libs + json (GPU-process fallback,
#                                    # same arrangement build.sh proved in dev)
#   Out/bunium_subprocess (Renderer).app/  # macOS helper apps -- Chromium
#   Out/bunium_subprocess (Alerts).app/    # spawns the renderer + notification
#                                    # alerts utility through per-type helper
#                                    # bundles named after the subprocess
#                                    # basename, as SIBLINGS of the main .app
#                                    # (the Google Chrome Helper (Renderer).app
#                                    # convention; CEF names them after
#                                    # browser_subprocess_path instead of the
#                                    # app name). Missing helpers make the
#                                    # renderer spawn fail with a silent ENOENT
#                                    # (release DLOG = no-op) -- navigation then
#                                    # dies with ERR_ABORTED. Their libcef
#                                    # install name is @loader_path-relative
#                                    # back into $NAME.app/Contents/Frameworks.
#       Resources/
#         app/
#           dist/                   # the app's built web assets
#           bunium/main.ts         # main-process entry, run as-is by bun
#           package.json
#           node_modules/bunium/     # materialized bunium package (src/ +
#                                    # package.json -- NOT a file: symlink,
#                                    # which would point back at the dev tree)
#
# The launcher exports BUNIUM_SHIM_PATH/BUNIUM_SUBPROCESS_PATH/
# BUNIUM_FRAMEWORK_DIR/BUNIUM_ROOT_CACHE_PATH pointing into this layout, so
# the same src/native.ts path-resolution code serves dev and packaged modes.
# A per-app root_cache_path gives each packaged app its own CEF profile
# (fixes the dev-mode ProcessSingleton collision note: real apps no longer
# share ~/Library/Application Support/CEF/User Data).
#
# Usage:
#   packaging/mac/package.sh -a <app-dir> [-n Name] [-i com.example.name]
#     [-o out-dir] [-r bunium-repo] [-b /path/to/bun] [-v 1.0.0] [-c icon.icns]
#     [--no-dmg]
#
# Signing/notarization: this script ad-hoc signs (codesign -s -) so the
# bundle runs locally with no cert. Real distribution needs a Developer ID
# (-c/codesign identity) plus notarization -- requires Apple credentials, so
# it deliberately is NOT wired in here; that's a documented follow-up.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
# Phase 10 CEF resource trim, shared with scripts/stage-release-artifacts.sh.
source "$SCRIPT_DIR/cef-trim.sh"

NAME=""
BUNDLE_ID=""
VERSION="1.0.0"
APP_DIR=""
OUT_DIR="$REPO_ROOT/dist-app"
BUNIUM_REPO="$REPO_ROOT"
BUN_BIN="$(command -v bun)"
ICON=""
MAKE_DMG=1
# Phase 10 CEF resource trim. Default trims ~65M of dead weight from the
# vendored framework: all *.lproj locale dirs except the --locales keeplist
# (en by default), the SwiftShader software-Vulkan stack (macOS has Metal
# everywhere; ANGLE's Metal backend serves the GPU process, SwiftShader only
# exists for exotic software-Vulkan cases), the gpu_shader_cache (regenerated
# on first run), and .DS_Store junk. Pass --no-trim to disable. Real world
# influence on locales: Chromium falls back to en-US strings when the
# requested locale's .lproj is absent, so a trimmed app still runs fine --
# just with untranslated UI chrome/dialogs.
TRIM_CEF=1
LOCALES="en"

usage() {
  sed -n '2,40p' "$0" | grep -E '^#|^$' | sed 's/^# //; s/^#$//'
  exit 1
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    -a) APP_DIR="$2"; shift 2 ;;
    -n) NAME="$2"; shift 2 ;;
    -i) BUNDLE_ID="$2"; shift 2 ;;
    -o) OUT_DIR="$2"; shift 2 ;;
    -r) BUNIUM_REPO="$2"; shift 2 ;;
    -b) BUN_BIN="$2"; shift 2 ;;
    -v) VERSION="$2"; shift 2 ;;
    -c) ICON="$2"; shift 2 ;;
    --no-dmg) MAKE_DMG=0; shift ;;
    --no-trim) TRIM_CEF=0; shift ;;
    --locales) LOCALES="$2"; shift 2 ;;
    *) echo "unknown option: $1" >&2; usage ;;
  esac
done

[ -n "$APP_DIR" ] || { echo "missing -a <app-dir>" >&2; usage; }
[ -d "$APP_DIR/bunium" ] || { echo "error: $APP_DIR/bunium missing (main-process dir)" >&2; exit 1; }
[ -d "$APP_DIR/dist" ] || { echo "error: $APP_DIR/dist missing -- run the app's build first" >&2; exit 1; }
[ -f "$APP_DIR/bunium/main.ts" ] || { echo "error: $APP_DIR/bunium/main.ts missing" >&2; exit 1; }
[ -n "$NAME" ] || NAME="$(basename "$APP_DIR")"
case "$NAME" in
  *" "*) echo "error: app name must not contain spaces (bundle layout/CFBundleExecutable)". >&2; exit 1 ;;
esac
[ -n "$BUNDLE_ID" ] || BUNDLE_ID="com.bunium.$(echo "$NAME" | tr '[:upper:]' '[:lower:]')"
[ -x "$BUN_BIN" ] || { echo "error: bun binary not found at $BUN_BIN" >&2; exit 1; }

CEF_FW_SRC="$BUNIUM_REPO/vendor/cef-macosarm64/Release/Chromium Embedded Framework.framework"
[ -d "$CEF_FW_SRC" ] || { echo "error: vendored CEF not found at $CEF_FW_SRC" >&2; exit 1; }
[ -f "$BUNIUM_REPO/native/build/bunium_shim.dylib" ] || { echo "error: run bun run build:native:mac first" >&2; exit 1; }

APP_BUNDLE="$OUT_DIR/$NAME.app"
echo "packaging $APP_DIR -> $APP_BUNDLE"
rm -rf "$APP_BUNDLE"
mkdir -p "$APP_BUNDLE/Contents/MacOS" \
         "$APP_BUNDLE/Contents/Frameworks" \
         "$APP_BUNDLE/Contents/Resources/app"

# --- MacOS: launcher wrapper (the CFBundleExecutable) + the bun binary ---
cp "$BUN_BIN" "$APP_BUNDLE/Contents/MacOS/bun"
cat > "$APP_BUNDLE/Contents/MacOS/$NAME" <<EOF
#!/bin/sh
# bunium packaged launcher -- see packaging/mac/package.sh for the layout.
APP_ROOT="\$(cd "\$(dirname "\$0")/.." && pwd)"
export BUNIUM_SHIM_PATH="\$APP_ROOT/Frameworks/bunium_shim.dylib"
export BUNIUM_SUBPROCESS_PATH="\$APP_ROOT/Frameworks/bunium_subprocess.app/Contents/MacOS/bunium_subprocess"
export BUNIUM_FRAMEWORK_DIR="\$APP_ROOT/Frameworks/Chromium Embedded Framework.framework"
CACHE_ROOT="\$HOME/Library/Application Support/$NAME/CEF"
mkdir -p "\$CACHE_ROOT"
export BUNIUM_ROOT_CACHE_PATH="\$CACHE_ROOT"
exec "\$APP_ROOT/MacOS/bun" "\$APP_ROOT/Resources/app/bunium/main.ts" "\$@"
EOF
chmod +x "$APP_BUNDLE/Contents/MacOS/$NAME"

# --- Frameworks: CEF framework + shim + subprocess, install names re-rewritten ---
ditto "$CEF_FW_SRC" "$APP_BUNDLE/Contents/Frameworks/Chromium Embedded Framework.framework"
cp "$BUNIUM_REPO/native/build/bunium_shim.dylib" "$APP_BUNDLE/Contents/Frameworks/"
cp "$BUNIUM_REPO/native/build/bunium_subprocess" "$APP_BUNDLE/Contents/Frameworks/"

FW_REL="@loader_path/Chromium Embedded Framework.framework/Chromium Embedded Framework"
for bin in bunium_shim.dylib bunium_subprocess; do
  target="$APP_BUNDLE/Contents/Frameworks/$bin"
  # otool -L lines are "\t<path> (compatibility version ...)"; the path itself
  # contains spaces, so take the whole line minus the trailing parenthesized
  # part rather than awk's whitespace-split $1 (which truncates at the first
  # space in "Chromium Embedded Framework").
  cur="$(otool -L "$target" | awk '/Chromium Embedded Framework\.framework\/Chromium Embedded Framework/ { l=$0; sub(/^[ \t]+/, "", l); sub(/ \(compatibility.*/, "", l); print l; exit }')"
  if [ -n "$cur" ]; then
    echo "rewriting $bin: $cur -> $FW_REL"
    install_name_tool -change "$cur" "$FW_REL" "$target"
  fi
done
# Same GPU-process fallback arrangement build.sh proved in dev: Chromium's
# GPU process looks for ANGLE's GL libs next to the executable that launched
# it (bunium_subprocess here, living in Contents/Frameworks).
cp "$CEF_FW_SRC/Libraries/"*.dylib "$APP_BUNDLE/Contents/Frameworks/"
cp "$CEF_FW_SRC/Libraries/"*.json "$APP_BUNDLE/Contents/Frameworks/"

# --- Phase 10: trim CEF resources (default on, --no-trim / --locales override) ---
if [ "$TRIM_CEF" -eq 1 ]; then
  FW_RES="$APP_BUNDLE/Contents/Frameworks/Chromium Embedded Framework.framework"
  trim_cef_framework "$FW_RES" "$APP_BUNDLE/Contents/Frameworks" "$LOCALES"
fi

# --- Resources: the app (dist/ + bunium/ + package.json) + a real (not
# symlinked) node_modules/bunium materialized from the bunium repo so
# "import { app } from 'bunium'" resolves inside the bundle. ---
resource_app="$APP_BUNDLE/Contents/Resources/app"
rsync -a --exclude node_modules --exclude .git "$APP_DIR/" "$resource_app/"
# materialize the bunium package itself (src/ + package.json only -- the
# native dylibs live in Frameworks/, reached via the launcher's env vars)
mkdir -p "$resource_app/node_modules/bunium"
rsync -a "$BUNIUM_REPO/src/" "$resource_app/node_modules/bunium/src/"
cp "$BUNIUM_REPO/package.json" "$resource_app/node_modules/bunium/package.json"

# --- macOS CEF helper apps ---
# CEF's sandbox bootstrap and dynamic framework loader require helper
# executables inside Contents/Frameworks, three levels below the framework.
HELPER_TYPES="base Renderer Alerts"
for htype in $HELPER_TYPES; do
  if [ "$htype" = "base" ]; then
    hname="bunium_subprocess"
    hbundle="$APP_BUNDLE/Contents/Frameworks/bunium_subprocess.app"
  else
    hname="bunium_subprocess ($htype)"
    hbundle="$APP_BUNDLE/Contents/Frameworks/$hname.app"
  fi
  hbin="$hbundle/Contents/MacOS/$hname"
  rm -rf "$hbundle"
  mkdir -p "$(dirname "$hbin")"
  cp "$BUNIUM_REPO/native/build/bunium_subprocess" "$hbin"
  cat > "$hbundle/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>$hname</string>
  <key>CFBundleExecutable</key><string>$hname</string>
  <!-- MUST equal the main app's CFBundleIdentifier: the helper child
       self-derives its MachPortRendezvous lookup name from its own bundle
       id (Chromium does not pass the browser's base-bundle-id here), so a
       "...Renderer" variant would look up a name the browser never
       registered and die with 1102. -->
  <key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>NSPrincipalClass</key><string>NSApplication</string>
</dict>
</plist>
EOF
  echo "helper: $hbundle"
done

# --- Info.plist ---
cat > "$APP_BUNDLE/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>$NAME</string>
  <key>CFBundleDisplayName</key><string>$NAME</string>
  <key>CFBundleExecutable</key><string>$NAME</string>
  <key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSPrincipalClass</key><string>NSApplication</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.developer-tools</string>
$( [ -n "$ICON" ] && printf '  <key>CFBundleIconFile</key><string>icon.icns</string>\n' )
</dict>
</plist>
EOF
if [ -n "$ICON" ]; then
  [ -f "$ICON" ] || { echo "error: icon not found: $ICON" >&2; exit 1; }
  cp "$ICON" "$APP_BUNDLE/Contents/Resources/icon.icns"
fi

# Ad-hoc sign so the bundle runs locally (arm64 macOS requires signed code;
# install_name_tool above invalidated the build-time signatures). Helper apps
# are nested in Contents/Frameworks and signed separately before the main app.
# Real distribution needs a
# Developer ID + notarization: out of scope here (needs Apple credentials)
# and documented as a follow-up in PLAN.md Phase 8.
for hbundle in "$APP_BUNDLE"/Contents/Frameworks/bunium_subprocess*.app; do
  if [ -d "$hbundle" ]; then
    codesign --force --deep --sign - "$hbundle"
  fi
done
codesign --force --deep --sign - "$APP_BUNDLE"
echo "codesign: ad-hoc signed $APP_BUNDLE + helper apps"

echo "verifying install names..."
otool -L "$APP_BUNDLE/Contents/Frameworks/bunium_shim.dylib" | grep "Chromium Embedded Framework" || true

if [ "$MAKE_DMG" -eq 1 ]; then
  DMG="$OUT_DIR/$NAME.dmg"
  rm -f "$DMG"
  # All CEF helpers are nested in the main app's Contents/Frameworks.
  DMG_STAGE="$OUT_DIR/.dmg-stage"
  rm -rf "$DMG_STAGE"
  mkdir -p "$DMG_STAGE"
  cp -R "$APP_BUNDLE" "$DMG_STAGE/"
  hdiutil create -volname "$NAME" -srcfolder "$DMG_STAGE" -ov -format UDZO "$DMG" >/dev/null
  rm -rf "$DMG_STAGE"
  echo "dmg:   $DMG"
fi
echo "app:   $APP_BUNDLE ($(du -sh "$APP_BUNDLE" | awk '{print $1}'))"
echo "helpers:"
ls -1 "$APP_BUNDLE"/Contents/Frameworks/bunium_subprocess*.app 2>/dev/null || true
