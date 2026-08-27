#!/usr/bin/env bash
# Packages a built bunium app (create-bunium-app output: bunium/main.ts +
# built dist/ + a "bunium" package.json dependency) into a Windows x64
# directory layout -- the Windows counterpart of packaging/mac/package.sh,
# with the dev-tree-native-path assumptions reworked for the packaged layout.
#
# MUST RUN ON WINDOWS (Git Bash): it needs clang-cl (to compile the EXE
# launcher), the Windows CEF distro, and a Windows bun.exe -- exactly the
# toolchain native/win/build.sh requires. The mac-side remote workflow
# (scripts/win-remote.sh pack) runs this on a Windows box and streams the
# logs back; CI runs it in .github/workflows/win-smoke.yml.
#
# Bundle layout produced (flat -- Windows has no bundle/framework concept;
# the launcher exports the BUNIUM_* path overrides src/paths.ts reads):
#   Out/Name/
#     Name.exe           compiled from launcher.c (GUI subsystem): exports
#                        BUNIUM_SHIM_PATH/BUNIUM_SUBPROCESS_PATH/
#                        BUNIUM_FRAMEWORK_DIR/BUNIUM_RESOURCES_DIR/
#                        BUNIUM_ROOT_CACHE_PATH, prepends Runtime/ to PATH
#                        (so bunium_shim.dll's libcef.dll import resolves,
#                        the dev-tree recipe), then spawns bun.exe on
#                        app/bunium/main.ts, inheriting std handles and
#                        propagating the exit code
#     bun.exe            the Bun binary itself (copied from $BUN_BIN)
#     bun.exe.manifest   comctl32 v6 SxS dependency -> the shim's
#                        TaskDialogIndirect now resolves in the packaged app
#                        (real TaskDialogs instead of the MessageBoxW
#                        fallback; the fallback stays when no manifest is
#                        active, e.g. dev processes). Deliberately no
#                        dpiAwareness element: per-monitor DPI awareness
#                        would change window-coordinate semantics vs the
#                        dev tree.
#     Runtime/           CEF Release/ contents (libcef.dll, chrome_elf.dll,
#                        ANGLE libs, d3dcompiler, vk_swiftshader, bootstrap
#                        crash-dialog exes) + icudtl.dat + the chrome_*.pak/
#                        resources.pak mirrors + bunium_shim.dll +
#                        bunium_subprocess.exe. The browser process finds
#                        libcef.dll via PATH; child processes find everything
#                        next to their own exe. (The distro ships no locales
#                        here -- those live under Resources/, which is what
#                        the shim's locales_dir_path resolves to.)
#     Resources/         CEF Resources/ (paks, icudtl.dat, locales/) -- the
#                        resources_dir_path handed to bunium_init (locales
#                        dir derived from it by the shim)
#     app/               dist/ + bunium/main.ts + package.json + a real
#                        (not symlinked) node_modules/bunium materialized
#                        from src/ + package.json
#
# No codesign (Windows' signing story is TLS code-signing for distribution;
# local use needs none), no per-type helper bundles (one
# bunium_subprocess.exe serves every CEF process type on Windows, unlike
# macOS' per-type helper apps), no DMG, no framework bundle (flat dist).
#
# Usage:
#   packaging/win/package.sh -a <app-dir> [-n Name] [-i com.example.name]
#     [-o out-dir] [-r bunium-repo] [-b /path/to/bun.exe] [-v 1.0.0]
#     [--locales en[,de,...]] [--verify] [--no-trim]
#
# --verify runs the freshly packaged <Name>.exe and requires the app to emit
# PACKAGED_APP_VERIFY:PASS before exiting (needs a desktop session -- the
# fixture opens a real window). The mac packaging fixture doubles as the
# Windows verifier: packaging/mac/fixture-app.
set -euo pipefail
export MSYS2_ARG_CONV_EXCL='*'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -W)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd -W)"
# Phase 10 CEF resource trim, shared with any future release pipeline
# (mirrors packaging/mac/package.sh's own `source .../cef-trim.sh`). See
# that file's header for the unverified-on-real-Windows caveat.
source "$SCRIPT_DIR/cef-trim.sh"

NAME=""
BUNDLE_ID=""
VERSION="1.0.0"
APP_DIR=""
OUT_DIR="$REPO_ROOT/dist-app"
BUNIUM_REPO="$REPO_ROOT"
BUN_BIN="$(command -v bun)"
LOCALES="all" # comma list (e.g. "en") trims locales/ to a keeplist
VERIFY=0
# Phase 10 CEF resource trim (SwiftShader software-Vulkan stack -- see
# cef-trim.sh). Default on, matching mac's own default-on posture.
TRIM_CEF=1

usage() {
  sed -n '52,64p' "$0" | grep -E '^#|^$' | sed 's/^# //; s/^#$//'
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
    --locales) LOCALES="$2"; shift 2 ;;
    --verify) VERIFY=1; shift ;;
    --no-trim) TRIM_CEF=0; shift ;;
    *) echo "unknown option: $1" >&2; usage ;;
  esac
done

# Normalize MSYS paths to Windows form early (cd works with both forms).
mkdir -p "$OUT_DIR"
APP_DIR="$(cd "$APP_DIR" && pwd -W)"
OUT_DIR="$(cd "$OUT_DIR" && pwd -W)"
BUNIUM_REPO="$(cd "$BUNIUM_REPO" && pwd -W)"

[ -d "$APP_DIR/bunium" ] || { echo "error: $APP_DIR/bunium missing (main-process dir)" >&2; exit 1; }
[ -d "$APP_DIR/dist" ] || { echo "error: $APP_DIR/dist missing -- run the app's build first" >&2; exit 1; }
[ -f "$APP_DIR/bunium/main.ts" ] || { echo "error: $APP_DIR/bunium/main.ts missing" >&2; exit 1; }
[ -n "$NAME" ] || NAME="$(basename "$APP_DIR")"
case "$NAME" in
  *" "*) echo "error: app name must not contain spaces (launcher exe layout)". >&2; exit 1 ;;
esac
[ -x "$BUN_BIN" ] || { echo "error: bun binary not found at $BUN_BIN" >&2; exit 1; }
[ -f "$BUNIUM_REPO/native/build/bunium_shim.dll" ] || { echo "error: run bash native/win/build.sh first" >&2; exit 1; }
[ -f "$BUNIUM_REPO/native/build/bunium_subprocess.exe" ] || { echo "error: run bash native/win/build.sh first" >&2; exit 1; }

CEF_RELEASE="$BUNIUM_REPO/vendor/cef-windows-x64/Release"
CEF_RESOURCES="$BUNIUM_REPO/vendor/cef-windows-x64/Resources"
[ -f "$CEF_RELEASE/libcef.dll" ] || { echo "error: vendored CEF not found at $CEF_RELEASE" >&2; exit 1; }
[ -d "$CEF_RESOURCES" ] || { echo "error: vendored CEF resources not found at $CEF_RESOURCES" >&2; exit 1; }

CXX="${CXX:-clang-cl}"
command -v "$CXX" >/dev/null 2>&1 || {
  echo "error: $CXX not found on PATH -- add LLVM's bin dir (same prereq as native/win/build.sh)" >&2
  exit 1
}

PACKAGE="$OUT_DIR/$NAME"
echo "packaging $APP_DIR -> $PACKAGE"
rm -rf "$PACKAGE"
mkdir -p "$PACKAGE/Runtime" "$PACKAGE/Resources" "$PACKAGE/app"

# --- Runtime: CEF Release/ contents + shim + subprocess (the DLL dir) ---
cp "$CEF_RELEASE/"*.dll "$PACKAGE/Runtime/"
cp "$CEF_RELEASE/"*.bin "$PACKAGE/Runtime/" 2>/dev/null || true
cp "$CEF_RELEASE/"*.dat "$PACKAGE/Runtime/" 2>/dev/null || true
# bootstrap[ c].exe: the crash-dialog helper exes the CEF distro ships.
cp "$CEF_RELEASE/"*.exe "$PACKAGE/Runtime/" 2>/dev/null || true
cp -R "$CEF_RELEASE/locales" "$PACKAGE/Runtime/" 2>/dev/null || true
# icudtl.dat lives in Resources/, not Release/, but CEF's Windows ICU loader
# wants it next to the DLL (DIR_MODULE) -- the dev tree satisfies this with
# its native/build copy; mirror it here.
cp "$CEF_RESOURCES/icudtl.dat" "$PACKAGE/Runtime/"
# Same DIR_MODULE-first lookup for the chrome_*.pak/resources.pak: Chromium
# probes the module dir before resources_dir_path, so mirror them next to
# libcef.dll too (dev native/build parity) or the probe prints an ERROR line.
cp "$CEF_RESOURCES/"*.pak "$PACKAGE/Runtime/" 2>/dev/null || true
cp "$BUNIUM_REPO/native/build/bunium_shim.dll" "$PACKAGE/Runtime/"
cp "$BUNIUM_REPO/native/build/bunium_subprocess.exe" "$PACKAGE/Runtime/"

# --- Phase 10: trim CEF resources (default on, --no-trim override). See
# cef-trim.sh's header for the unverified-filenames caveat on Windows. ---
if [ "$TRIM_CEF" -eq 1 ]; then
  trim_cef_runtime "$PACKAGE/Runtime"
fi

# --- Resources: the resources_dir_path. Optional locale keeplist trim
# (Chromium falls back to en-US strings when the requested locale is
# absent, so a trimmed app runs fine -- untranslated chrome only). ---
cp -R "$CEF_RESOURCES/." "$PACKAGE/Resources/"
if [ "$LOCALES" != "all" ]; then
  rm -rf "$PACKAGE/Resources/locales"
  mkdir -p "$PACKAGE/Resources/locales"
  IFS=',' read -ra KEEP <<< "$LOCALES"
  for l in "${KEEP[@]}"; do
    # Windows locale paks are BCP-47 codes (en-US.pak, de.pak); accept the
    # mac-style short form too ("en" -> en-US).
    if [ -f "$CEF_RESOURCES/locales/$l.pak" ]; then
      cp "$CEF_RESOURCES/locales/$l.pak" "$PACKAGE/Resources/locales/"
    elif [ -f "$CEF_RESOURCES/locales/$l-US.pak" ]; then
      cp "$CEF_RESOURCES/locales/$l-US.pak" "$PACKAGE/Resources/locales/"
    else
      echo "warn: locale '$l' not in distro (skipped)"
    fi
  done
fi

# --- app/: the user app (dist/ + bunium/ + package.json) + a real (not
# symlinked) node_modules/bunium materialized from the bunium repo so
# "import { app } from 'bunium'" resolves inside the package. tar instead of
# rsync: Git-for-Windows bash has no rsync, and tar's --exclude + stream
# works on both bsdtar and GNU tar. ---
resource_app="$PACKAGE/app"
tar -C "$APP_DIR" --exclude node_modules --exclude .git -cf - . |
  (cd "$resource_app" && tar -xf -)
mkdir -p "$resource_app/node_modules/bunium"
cp -R "$BUNIUM_REPO/src/." "$resource_app/node_modules/bunium/src/"
cp "$BUNIUM_REPO/package.json" "$resource_app/node_modules/bunium/package.json"

# --- bun.exe + comctl32 v6 SxS manifest ---
cp "$BUN_BIN" "$PACKAGE/bun.exe"
cat > "$PACKAGE/bun.exe.manifest" <<'EOF'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <dependency>
    <dependentAssembly>
      <assemblyIdentity type="win32" name="Microsoft.Windows.Common-Controls"
        version="6.0.0.0" processorArchitecture="*"
        publicKeyToken="6595b64144ccf1df" language="*"/>
    </dependentAssembly>
  </dependency>
</assembly>
EOF

# --- The launcher exe: compiled, not scripted -- Windows has no shebang
# exec, and a .cmd wrapper would flash a console and mangle exit codes. GUI
# subsystem = no console flash on double-click; the launcher passes its own
# console handles through when it has them. ---
EXE="$PACKAGE/$NAME.exe"
"$CXX" /nologo /O2 "/Fe$EXE" "$SCRIPT_DIR/launcher.c" /link /SUBSYSTEM:WINDOWS
[ -f "$EXE" ] || { echo "error: launcher compile failed" >&2; exit 1; }

echo "package: $PACKAGE ($(du -sh "$PACKAGE" | awk '{print $1}'))"
echo "  launcher: $EXE"

if [ "$VERIFY" -eq 1 ]; then
  echo "verify: running packaged app (real window; needs a desktop session)..."
  VLOG="$OUT_DIR/.verify-$NAME.log"
  "$EXE" 2>&1 | tee "$VLOG" || true
  if grep -q "PACKAGED_APP_VERIFY:PASS" "$VLOG"; then
    echo "verify: PASS"
  else
    echo "verify: FAIL (no PACKAGED_APP_VERIFY:PASS in $VLOG)" >&2
    exit 1
  fi
fi