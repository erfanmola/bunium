#!/usr/bin/env bash
# Wraps the flat directory produced by packaging/linux/package.sh into an
# AppImage -- a single self-contained, chmod +x executable file that runs
# on (almost) any Linux distro without installing anything, the closest
# Linux equivalent to macOS' .app-as-a-double-clickable-thing UX and the
# most "distribution-agnostic" of the three v1 Linux package formats (the
# .deb/.rpm scripts are each tied to one packaging ecosystem; this one
# isn't tied to any).
#
# An AppImage is a squashfs (or similar) filesystem image with a small ELF
# "runtime" stub prepended that mounts it via FUSE (or, when FUSE is
# unavailable -- common in containers/CI -- extracts-and-execs itself via
# --appimage-extract-and-run) and then execs AppRun inside. appimagetool
# builds this from an "AppDir" -- a directory whose layout AppImage itself
# mandates: AppRun (the entry point), <name>.desktop, and an icon, all at
# the AppDir root, plus arbitrary payload anywhere else in the tree.
#
# AppDir layout produced here:
#   AppDir/
#     AppRun                 -> execs Out/Name's own launcher unmodified
#                                (re-using package.sh's launcher rather
#                                than re-deriving the BUNIUM_*_PATH exports
#                                here keeps exactly one place that knows
#                                that env-var contract)
#     <name>.desktop          required by appimagetool; also what desktop
#                              integration tools (e.g. appimaged) read if
#                              the user chooses to integrate the AppImage
#     <name>.png               1x1-free real icon (generated via ImageMagick
#                              if not supplied) -- appimagetool refuses to
#                              build without one
#     opt/<name>/...           the entire flat package.sh output, verbatim
#
# Usage:
#   packaging/linux/package-appimage.sh -p <flat-package-dir> [-o out-dir]
#     [-t /path/to/appimagetool] [--verify]
#
# <flat-package-dir> is the `Out/Name` directory packaging/linux/package.sh
# already produced (this script does not rebuild the app -- run package.sh
# first). appimagetool is looked up on $PATH by default, or pass -t; it is
# NOT vendored/built by this repo (no distro-neutral static one-liner
# install exists -- see docs/guide/packaging.md for the download link).
# --verify runs the built AppImage directly with
# --appimage-extract-and-run (works with or without /dev/fuse -- CI
# runners and sandboxes frequently lack FUSE), requiring
# PACKAGED_APP_VERIFY:PASS.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

PKG_DIR=""
OUT_DIR="$REPO_ROOT/dist-app"
APPIMAGETOOL="$(command -v appimagetool || true)"
VERIFY=0

usage() {
  sed -n '2,34p' "$0" | grep -E '^#|^$' | sed 's/^# //; s/^#$//'
  exit 1
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    -p) PKG_DIR="$2"; shift 2 ;;
    -o) OUT_DIR="$2"; shift 2 ;;
    -t) APPIMAGETOOL="$2"; shift 2 ;;
    --verify) VERIFY=1; shift ;;
    *) echo "unknown option: $1" >&2; usage ;;
  esac
done

[ -n "$PKG_DIR" ] || { echo "missing -p <flat-package-dir>" >&2; usage; }
[ -d "$PKG_DIR" ] || { echo "error: $PKG_DIR not found" >&2; exit 1; }
NAME="$(basename "$PKG_DIR")"
[ -x "$PKG_DIR/$NAME" ] || { echo "error: $PKG_DIR/$NAME launcher missing -- run packaging/linux/package.sh first" >&2; exit 1; }
[ -n "$APPIMAGETOOL" ] || { echo "error: appimagetool not found on PATH (pass -t, or see docs/guide/packaging.md for the download link)" >&2; exit 1; }
[ -x "$APPIMAGETOOL" ] || { echo "error: $APPIMAGETOOL is not executable" >&2; exit 1; }

PKG_NAME="$(echo "$NAME" | tr '[:upper:]' '[:lower:]')"
ARCH="x86_64"
case "$(uname -m)" in
  aarch64 | arm64) ARCH="aarch64" ;;
  x86_64 | amd64) ARCH="x86_64" ;;
esac

APPDIR="$OUT_DIR/.appdir-$PKG_NAME"
echo "staging AppDir -> $APPDIR"
rm -rf "$APPDIR"
mkdir -p "$APPDIR/opt/$NAME"
cp -a "$PKG_DIR/." "$APPDIR/opt/$NAME/"

# --- AppRun: AppImage's mandated entry point. cd's into the payload's own
# launcher dir and execs it unmodified -- BUNIUM_ROOT_CACHE_PATH etc. are
# derived by that launcher exactly the same way as the flat/deb/rpm forms,
# so app behavior is identical across all four package formats. ---
cat > "$APPDIR/AppRun" <<EOF
#!/bin/sh
HERE="\$(cd "\$(dirname "\$0")" && pwd)"
exec "\$HERE/opt/$NAME/$NAME" "\$@"
EOF
chmod +x "$APPDIR/AppRun"

# --- icon: appimagetool requires a top-level icon file matching the
# .desktop's Icon= key. No bundled app icon asset exists yet in this repo,
# so synthesize a minimal placeholder PNG via ImageMagick if available;
# a real app icon can be dropped in later (e.g. via a future -c <icon.png>
# flag mirroring packaging/mac/package.sh's -c <icon.icns>) without
# changing this script's structure. ---
ICON_PATH="$APPDIR/$PKG_NAME.png"
if command -v convert >/dev/null 2>&1; then
  convert -size 256x256 xc:"#4a90d9" "$ICON_PATH"
elif command -v magick >/dev/null 2>&1; then
  magick -size 256x256 xc:"#4a90d9" "$ICON_PATH"
else
  echo "error: need ImageMagick (convert/magick) to synthesize a placeholder icon" >&2
  exit 1
fi

# --- .desktop: same content as package-deb.sh/package-rpm.sh's, minus the
# absolute Exec= path (AppImage convention is a bare command name, since
# AppRun is what actually runs; appimagetool warns/rejects absolute paths
# here). ---
cat > "$APPDIR/$PKG_NAME.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=$NAME
Exec=$PKG_NAME
Icon=$PKG_NAME
Terminal=false
Categories=Utility;
EOF

APPIMAGE_PATH="$OUT_DIR/${PKG_NAME}-${ARCH}.AppImage"
rm -f "$APPIMAGE_PATH"
# ARCH is read by appimagetool from $ARCH (env var), not a flag.
ARCH="$ARCH" "$APPIMAGETOOL" "$APPDIR" "$APPIMAGE_PATH"
echo "appimage: $APPIMAGE_PATH ($(du -sh "$APPIMAGE_PATH" | awk '{print $1}'))"

if [ "$VERIFY" -eq 1 ]; then
  echo "verify: running the AppImage (--appimage-extract-and-run, no FUSE required)..."
  VLOG="$OUT_DIR/.verify-appimage-$PKG_NAME.log"
  "$APPIMAGE_PATH" --appimage-extract-and-run > "$VLOG" 2>&1 || true
  cat "$VLOG"
  if grep -q "PACKAGED_APP_VERIFY:PASS" "$VLOG"; then
    echo "verify: PASS"
  else
    echo "verify: FAIL (no PACKAGED_APP_VERIFY:PASS in $VLOG)" >&2
    exit 1
  fi
fi
