#!/usr/bin/env bash
# Linux counterpart of scripts/stage-release-artifacts.sh (which is
# hardcoded to darwin/arm64) -- stages native artifacts into a publishable
# bunium-linux-<arch> platform package matching the layout src/paths.ts's
# platformPackagePaths() resolves for installed Linux consumers:
#
#   shim/bunium_shim.so
#   shim/bunium_subprocess
#   framework/    libcef.so + icudtl.dat + v8_context_snapshot.bin +
#                 chrome_*.pak/resources.pak + locales/  -- ALL merged into
#                 one dir (src/paths.ts's platformPackagePaths() sets both
#                 frameworkDir and resourcesDir to "$base/framework", same
#                 as Windows). This mirrors native/build-linux/'s own
#                 layout and packaging/linux/package.sh's Runtime/ -- see
#                 those for why libcef.so + locales/ must stay colocated
#                 (CEF's default locale/pak resolution is relative to
#                 libcef.so's own directory, not resources_dir_path).
#
# No install_name_tool-equivalent rewrite step is needed here (unlike mac's
# staging script): native/linux/build.sh already links bunium_shim.so and
# bunium_subprocess with an $ORIGIN-relative rpath, so libcef.so resolves
# from whatever directory the binaries are copied into -- pure file copies
# are sufficient for relocatability.
#
# Usage:
#   scripts/stage-release-artifacts-linux.sh [-v <version>] [-o <out-dir>] [-l <locales>]
#   -v  version stamp (default: package.json's version)
#   -o  output dir (default: dist-release/)
#   -l  locale pak keeplist, comma-separated BCP-47 names or "all" (default: en)
# Outputs:
#   dist-release/bunium-linux-<arch>/             npm-publishable package dir
#   dist-release/bunium-linux-<arch>-<v>.tar.gz   archive for a release host
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

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

case "$(uname -m)" in
  aarch64 | arm64) ARCH="arm64"; CEF_PLATFORM="linuxarm64" ;;
  x86_64 | amd64) ARCH="x64"; CEF_PLATFORM="linux64" ;;
  *) echo "error: unsupported arch $(uname -m)" >&2; exit 1 ;;
esac

PLATFORM="linux"
PKG_NAME="bunium-$PLATFORM-$ARCH"
STAGE="$OUT_DIR/$PKG_NAME"

BUILD_DIR="$REPO_ROOT/native/build-linux"
CEF_RESOURCES="$REPO_ROOT/vendor/cef-$CEF_PLATFORM/Resources"

[ -f "$BUILD_DIR/bunium_shim.so" ] || { echo "error: $BUILD_DIR/bunium_shim.so missing -- run bun run build:native:linux first" >&2; exit 1; }
[ -f "$BUILD_DIR/bunium_subprocess" ] || { echo "error: $BUILD_DIR/bunium_subprocess missing -- run bun run build:native:linux first" >&2; exit 1; }
[ -d "$CEF_RESOURCES" ] || { echo "error: vendored CEF resources not found at $CEF_RESOURCES" >&2; exit 1; }

echo "staging $PKG_NAME v$VERSION -> $STAGE"
rm -rf "$STAGE"
mkdir -p "$STAGE/shim" "$STAGE/framework"

# --- shim + subprocess (already $ORIGIN-rpath'd, no rewrite needed) ---
cp "$BUILD_DIR/bunium_shim.so" "$STAGE/shim/"
cp "$BUILD_DIR/bunium_subprocess" "$STAGE/shim/"

# --- framework/: libcef.so + everything Chrome-runtime resolves relative
# to its own dir, merged into one directory (see header comment) ---
cp "$BUILD_DIR/libcef.so" "$STAGE/framework/"
cp "$BUILD_DIR/icudtl.dat" "$STAGE/framework/"
cp "$BUILD_DIR/v8_context_snapshot.bin" "$STAGE/framework/"
cp "$BUILD_DIR/"*.pak "$STAGE/framework/"
cp -R "$CEF_RESOURCES/locales" "$STAGE/framework/"

# --- Locale trim (same keeplist semantics as packaging/linux/package.sh
# and packaging/win/package.sh -- Chromium falls back to en-US strings for
# a missing locale, not a crash) ---
if [ "$LOCALES" != "all" ]; then
  IFS=',' read -ra KEEP <<< "$LOCALES"
  for f in "$STAGE/framework/locales/"*.pak; do
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

tar -C "$OUT_DIR" -czf "$OUT_DIR/$PKG_NAME-$VERSION.tar.gz" "$PKG_NAME"

SIZE="$(du -sh "$STAGE" | awk '{print $1}')"
echo "staged: $STAGE ($SIZE)"
echo "archive: $OUT_DIR/$PKG_NAME-$VERSION.tar.gz"
