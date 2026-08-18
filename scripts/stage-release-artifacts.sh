#!/usr/bin/env bash
# Stages the native artifacts a published "bunium" package needs at runtime
# into a publishable platform package (bunium-<platform>-<arch>, e.g.
# bunium-darwin-arm64), matching the layout src/paths.ts resolves for
# installed consumers:
#
#   shim/bunium_shim.dylib
#   shim/bunium_subprocess
#   shim/{libEGL,libGLESv2,libcef_sandbox}.dylib + *.json  (ANGLE libs --
#     the GPU process looks for these next to the executable that launched
#     it, the same arrangement build.sh/package.sh prove in dev + packaged)
#   framework/Chromium Embedded Framework.framework/        (CEF, trimmed)
#
# The shim + subprocess get their CEF install name re-aimed at
# @loader_path/../framework/... so the artifacts are location-independent:
# no dev-tree absolute paths leak into the published package.
#
# The "bunium" JS package declares the matching platform package as an
# optionalDependency (added at publish time); src/paths.ts falls back to it
# when neither the packaged-app env vars nor the dev tree are present.
#
# Usage:
#   scripts/stage-release-artifacts.sh [-v <version>] [-o <out-dir>] [-l <locales>]
#   -v  version stamp for the staged package/archive (default: package.json)
#   -o  output dir (default: dist-release/)
#   -l  .lproj locales keeplist, comma-separated or "all" (default: en)
# Outputs:
#   dist-release/bunium-darwin-arm64/             npm-publishable package dir
#   dist-release/bunium-darwin-arm64-<v>.tar.gz   archive for a release host
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
source "$REPO_ROOT/packaging/mac/cef-trim.sh"

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

PLATFORM="darwin"
ARCH="arm64"
PKG_NAME="bunium-$PLATFORM-$ARCH"
STAGE="$OUT_DIR/$PKG_NAME"

CEF_SRC="$REPO_ROOT/vendor/cef-macosarm64/Release/Chromium Embedded Framework.framework"
FW_BUNDLE="$STAGE/framework/Chromium Embedded Framework.framework"
FW_REL="@loader_path/../framework/Chromium Embedded Framework.framework/Chromium Embedded Framework"

[ -d "$CEF_SRC" ] || { echo "error: vendored CEF not found at $CEF_SRC" >&2; exit 1; }
[ -f "$REPO_ROOT/native/build/bunium_shim.dylib" ] || { echo "error: native/build/bunium_shim.dylib missing -- run bun run build:native:mac first" >&2; exit 1; }

echo "staging $PKG_NAME v$VERSION -> $STAGE"
rm -rf "$STAGE"
mkdir -p "$STAGE/shim" "$STAGE/framework"

# --- CEF framework, trimmed ---
ditto "$CEF_SRC" "$FW_BUNDLE"
trim_cef_framework "$FW_BUNDLE" "$FW_BUNDLE/Libraries" "$LOCALES"

# --- ANGLE libs + json next to the subprocess executable (GPU-process
# fallback arrangement). Exclude the SwiftShader stack explicitly -- the
# trim only removes it from the framework's own Libraries/ copy. ---
for f in "$CEF_SRC/Libraries/"*.dylib "$CEF_SRC/Libraries/"*.json; do
  case "$(basename "$f")" in
    libvk_swiftshader.dylib | libvulkan.dylib | vk_swiftshader_icd.json) continue ;;
  esac
  cp "$f" "$STAGE/shim/"
done

# --- Shim + subprocess, CEF install name re-aimed at the staged framework.
# The vendored build rewrote it to an absolute dev-tree path, which cannot
# ship; @loader_path of either binary (both live in shim/) is the shim dir,
# so ../framework/ reaches the sibling framework regardless of where the
# package is installed. Same otool-extraction trick package.sh uses (the
# path contains spaces, so whitespace-splitting $1 truncates). ---
cp "$REPO_ROOT/native/build/bunium_shim.dylib" "$STAGE/shim/"
cp "$REPO_ROOT/native/build/bunium_subprocess" "$STAGE/shim/"
for bin in bunium_shim.dylib bunium_subprocess; do
  target="$STAGE/shim/$bin"
  cur="$(otool -L "$target" | awk '/Chromium Embedded Framework\.framework\/Chromium Embedded Framework/ { l=$0; sub(/^[ \t]+/, "", l); sub(/ \(compatibility.*/, "", l); print l; exit }')"
  if [ -n "$cur" ]; then
    echo "rewriting $bin: $cur -> $FW_REL"
    install_name_tool -change "$cur" "$FW_REL" "$target"
  fi
done

# --- Publish metadata for the platform package dir itself. os/cpu make npm
# refuse installing it on the wrong platform (the "bunium" package's
# optionalDependency then just stays unresolved). ---
cat > "$STAGE/package.json" <<EOF
{
  "name": "$PKG_NAME",
  "version": "$VERSION",
  "os": ["$PLATFORM"],
  "cpu": ["$ARCH"],
  "files": ["shim/", "framework/"]
}
EOF

# --- Archive (for a release host / GitHub Release), staged dir stays
# publishable in place via `npm publish <dir>`. ---
tar -C "$OUT_DIR" -czf "$OUT_DIR/$PKG_NAME-$VERSION.tar.gz" "$PKG_NAME"

SIZE="$(du -sh "$STAGE" | awk '{print $1}')"
echo "staged: $STAGE ($SIZE)"
echo "archive: $OUT_DIR/$PKG_NAME-$VERSION.tar.gz"
