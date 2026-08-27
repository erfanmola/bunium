#!/usr/bin/env bash
# Windows counterpart of scripts/stage-release-artifacts.sh /
# stage-release-artifacts-linux.sh -- stages native artifacts into a
# publishable bunium-win32-x64 platform package matching the layout
# src/paths.ts's platformPackagePaths() resolves for installed Windows
# consumers:
#
#   shim/bunium_shim.dll
#   shim/bunium_subprocess.exe
#   framework/    libcef.dll + chrome_elf.dll + ANGLE/d3dcompiler DLLs +
#                 icudtl.dat + v8_context_snapshot.bin + chrome_*.pak/
#                 resources.pak + locales/  -- ALL merged into one dir
#                 (platformPackagePaths() sets both frameworkDir and
#                 resourcesDir to "$base/framework" on win32, same as
#                 Linux). bunium_shim.cpp's Windows branch derives
#                 locales_dir_path as "<resourcesDir>/locales", so
#                 locales/ MUST live directly under framework/ here.
#
# No install_name_tool/rpath-equivalent rewrite step is needed: Windows
# resolves bunium_shim.dll's libcef.dll import via the DLL search order
# (same directory first), so pure file copies into one flat shim/ +
# framework/ split are sufficient -- src/paths.ts's win32 resolver never
# needs the two dirs to be adjacent, only internally consistent.
#
# MUST RUN ON WINDOWS (Git Bash): needs native/win/build.sh's output
# (native/build/*.dll/*.exe) and the vendored Windows CEF distro, exactly
# like packaging/win/package.sh. Run via scripts/win-remote.sh or a
# Windows CI runner; there is no cross-build path from macOS/Linux.
#
# Usage:
#   scripts/stage-release-artifacts-win.sh [-v <version>] [-o <out-dir>] [-l <locales>]
#   -v  version stamp (default: package.json's version)
#   -o  output dir (default: dist-release/)
#   -l  locale pak keeplist, comma-separated BCP-47 names or "all" (default: en)
# Outputs:
#   dist-release/bunium-win32-x64/             npm-publishable package dir
#   dist-release/bunium-win32-x64-<v>.tar.gz   archive for a release host
set -euo pipefail
export MSYS2_ARG_CONV_EXCL='*'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -W 2>/dev/null || pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -W 2>/dev/null || pwd)"
source "$REPO_ROOT/packaging/win/cef-trim.sh"

VERSION="$(sed -n 's/^  "version": "\(.*\)",$/\1/p' "$REPO_ROOT/package.json" | head -1)"
OUT_DIR="$REPO_ROOT/dist-release"
LOCALES="en"

while [ "$#" -gt 0 ]; do
  case "$1" in
    -v) VERSION="$2"; shift 2 ;;
    -o) OUT_DIR="$2"; shift 2 ;;
    -l) LOCALES="$2"; shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
done

PLATFORM="win32"
ARCH="x64"
PKG_NAME="bunium-$PLATFORM-$ARCH"
STAGE="$OUT_DIR/$PKG_NAME"

BUILD_DIR="$REPO_ROOT/native/build"
CEF_RELEASE="$REPO_ROOT/vendor/cef-windows-x64/Release"
CEF_RESOURCES="$REPO_ROOT/vendor/cef-windows-x64/Resources"

[ -f "$BUILD_DIR/bunium_shim.dll" ] || { echo "error: $BUILD_DIR/bunium_shim.dll missing -- run bash native/win/build.sh first" >&2; exit 1; }
[ -f "$BUILD_DIR/bunium_subprocess.exe" ] || { echo "error: $BUILD_DIR/bunium_subprocess.exe missing -- run bash native/win/build.sh first" >&2; exit 1; }
[ -f "$CEF_RELEASE/libcef.dll" ] || { echo "error: vendored CEF not found at $CEF_RELEASE" >&2; exit 1; }
[ -d "$CEF_RESOURCES" ] || { echo "error: vendored CEF resources not found at $CEF_RESOURCES" >&2; exit 1; }

echo "staging $PKG_NAME v$VERSION -> $STAGE"
rm -rf "$STAGE"
mkdir -p "$STAGE/shim" "$STAGE/framework"

# --- shim + subprocess ---
cp "$BUILD_DIR/bunium_shim.dll" "$STAGE/shim/"
cp "$BUILD_DIR/bunium_subprocess.exe" "$STAGE/shim/"

# --- framework/: CEF Release/ DLLs + Resources/ paks/icudtl/locales, all
# merged into one directory (see header comment for why locales/ must sit
# directly under framework/, not framework/Resources/locales). ---
cp "$CEF_RELEASE/"*.dll "$STAGE/framework/"
cp "$CEF_RELEASE/"*.bin "$STAGE/framework/" 2>/dev/null || true
cp "$CEF_RELEASE/"*.exe "$STAGE/framework/" 2>/dev/null || true
cp "$CEF_RESOURCES/icudtl.dat" "$STAGE/framework/"
cp "$CEF_RESOURCES/"*.pak "$STAGE/framework/" 2>/dev/null || true
cp -R "$CEF_RESOURCES/locales" "$STAGE/framework/"

# --- Phase 10 trim (SwiftShader software-Vulkan stack) ---
trim_cef_runtime "$STAGE/framework"

# --- Locale trim (same keeplist semantics as packaging/win/package.sh) ---
if [ "$LOCALES" != "all" ]; then
  IFS=',' read -ra KEEP <<< "$LOCALES"
  for f in "$STAGE/framework/locales/"*.pak; do
    [ -f "$f" ] || continue
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

cat > "$STAGE/package.json" <<EOF
{
  "name": "$PKG_NAME",
  "version": "$VERSION",
  "os": ["$PLATFORM"],
  "cpu": ["$ARCH"],
  "files": ["shim/", "framework/"]
}
EOF

# --force-local: bsdtar on Git-for-Windows otherwise parses the drive-letter
# colon in an absolute -f path (D:/...) as a "host:path" remote-tar spec and
# tries to shell out to ssh/rsh -- a real CI failure, not theoretical.
tar --force-local -C "$OUT_DIR" -czf "$OUT_DIR/$PKG_NAME-$VERSION.tar.gz" "$PKG_NAME"

SIZE="$(du -sh "$STAGE" | awk '{print $1}')"
echo "staged: $STAGE ($SIZE)"
echo "archive: $OUT_DIR/$PKG_NAME-$VERSION.tar.gz"
