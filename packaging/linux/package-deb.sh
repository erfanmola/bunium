#!/usr/bin/env bash
# Wraps the flat directory produced by packaging/linux/package.sh into a
# real Debian binary package (.deb), installable via `dpkg -i` / apt.
#
# Debian packages are just an `ar` archive of {debian-binary,control.tar.*,
# data.tar.*} -- dpkg-deb builds this from a staging directory whose root
# *is* the target filesystem layout (i.e. usr/bin/foo in the staging dir
# becomes /usr/bin/foo on the installed system) plus a DEBIAN/ control
# subdirectory that is NOT installed (dpkg strips the DEBIAN/ prefix).
#
# Install layout chosen (standard FHS, not a self-contained relocatable
# bundle like the flat-dir package): everything the app needs -- launcher,
# bundled bun, Runtime/, app/ -- goes under /opt/<name>/ (the traditional
# place for a vendored, non-distro-packaged-dependency app that doesn't
# split into individual system libs/binaries), with a thin symlink from
# /usr/bin/<name> -> /opt/<name>/<name> so it's on $PATH, and a .desktop
# entry under /usr/share/applications/ so desktop-environment launchers
# (GNOME Shell, KDE app grid, etc.) can find it. This mirrors how most
# vendored-runtime apps (e.g. VS Code's .deb, Slack's .deb) are laid out.
#
# fakeroot is required for the dpkg-deb build step: file ownership inside
# a .deb's data.tar must be root:root (uid/gid 0) regardless of the build
# machine's actual user, and dpkg-deb refuses to fabricate that without
# either running as real root (unavailable/undesirable in a build script)
# or faking it via fakeroot's LD_PRELOAD-based getuid()/chown() shims.
#
# Usage:
#   packaging/linux/package-deb.sh -p <flat-package-dir> [-o out-dir]
#     [-m "Maintainer Name <email>"] [--verify]
#
# <flat-package-dir> is the `Out/Name` directory packaging/linux/package.sh
# already produced (this script does not rebuild the app -- run package.sh
# first). --verify installs into a throwaway root via `dpkg-deb -x` (no
# real root/apt needed) then runs the extracted launcher exactly like
# package.sh --verify does, requiring PACKAGED_APP_VERIFY:PASS.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

PKG_DIR=""
OUT_DIR="$REPO_ROOT/dist-app"
MAINTAINER="bunium <noreply@example.com>"
VERIFY=0

usage() {
  sed -n '2,35p' "$0" | grep -E '^#|^$' | sed 's/^# //; s/^#$//'
  exit 1
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    -p) PKG_DIR="$2"; shift 2 ;;
    -o) OUT_DIR="$2"; shift 2 ;;
    -m) MAINTAINER="$2"; shift 2 ;;
    --verify) VERIFY=1; shift ;;
    *) echo "unknown option: $1" >&2; usage ;;
  esac
done

[ -n "$PKG_DIR" ] || { echo "missing -p <flat-package-dir>" >&2; usage; }
[ -d "$PKG_DIR" ] || { echo "error: $PKG_DIR not found" >&2; exit 1; }
NAME="$(basename "$PKG_DIR")"
[ -x "$PKG_DIR/$NAME" ] || { echo "error: $PKG_DIR/$NAME launcher missing -- run packaging/linux/package.sh first" >&2; exit 1; }

command -v dpkg-deb >/dev/null 2>&1 || { echo "error: dpkg-deb not found (install dpkg)" >&2; exit 1; }
command -v fakeroot >/dev/null 2>&1 || { echo "error: fakeroot not found" >&2; exit 1; }

# Debian package names must be lowercase, no spaces (package.sh already
# forbids spaces in NAME); lowercase it for the .deb metadata/filename
# while keeping the on-disk app directory name (NAME) as-is for /opt/NAME.
PKG_NAME="$(echo "$NAME" | tr '[:upper:]' '[:lower:]')"
VERSION="1.0.0"
if [ -f "$PKG_DIR/app/package.json" ]; then
  v="$(grep -m1 '"version"' "$PKG_DIR/app/package.json" | sed -E 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/')"
  [ -n "$v" ] && VERSION="$v"
fi
ARCH="amd64"
case "$(uname -m)" in
  aarch64 | arm64) ARCH="arm64" ;;
  x86_64 | amd64) ARCH="amd64" ;;
esac

STAGE="$OUT_DIR/.deb-stage-$PKG_NAME"
echo "staging .deb payload -> $STAGE"
rm -rf "$STAGE"
mkdir -p "$STAGE/DEBIAN" "$STAGE/opt/$NAME" "$STAGE/usr/bin" "$STAGE/usr/share/applications"

# --- payload: the whole flat package under /opt/<name>/ ---
cp -a "$PKG_DIR/." "$STAGE/opt/$NAME/"

# --- /usr/bin symlink so the app is on PATH once installed ---
ln -s "/opt/$NAME/$NAME" "$STAGE/usr/bin/$PKG_NAME"

# --- .desktop entry: lets GNOME/KDE/etc. app launchers find it. No icon
# reference here (no bundled .png/.svg icon asset exists yet in this repo
# -- Icon= is left as the app name, which desktop environments fall back
# to a generic executable icon for; a real icon can be added later without
# changing this script's structure). ---
cat > "$STAGE/usr/share/applications/$PKG_NAME.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=$NAME
Exec=/opt/$NAME/$NAME
Icon=$PKG_NAME
Terminal=false
Categories=Utility;
EOF

# --- DEBIAN/control: the package metadata dpkg reads. Installed-Size is
# in KiB, computed from the staged payload (excludes DEBIAN/ itself,
# matching dpkg's own convention). ---
INSTALLED_SIZE_KB="$(du -sk "$STAGE" | awk '{print $1}')"
cat > "$STAGE/DEBIAN/control" <<EOF
Package: $PKG_NAME
Version: $VERSION
Section: utils
Priority: optional
Architecture: $ARCH
Installed-Size: $INSTALLED_SIZE_KB
Maintainer: $MAINTAINER
Description: $NAME (packaged with bunium)
 A bunium application, bundled with its own Bun runtime and CEF browser
 engine under /opt/$NAME -- no system dependency on a specific Bun/CEF
 version.
EOF

DEB_PATH="$OUT_DIR/${PKG_NAME}_${VERSION}_${ARCH}.deb"
rm -f "$DEB_PATH"
fakeroot dpkg-deb --build --root-owner-group "$STAGE" "$DEB_PATH"
echo "deb: $DEB_PATH ($(du -sh "$DEB_PATH" | awk '{print $1}'))"

if [ "$VERIFY" -eq 1 ]; then
  echo "verify: extracting .deb (no real install/root needed) and running the launcher..."
  EXTRACT="$OUT_DIR/.deb-verify-$PKG_NAME"
  rm -rf "$EXTRACT"
  mkdir -p "$EXTRACT"
  dpkg-deb -x "$DEB_PATH" "$EXTRACT"
  [ -x "$EXTRACT/opt/$NAME/$NAME" ] || { echo "verify: FAIL (extracted launcher missing/not executable)" >&2; exit 1; }
  VLOG="$OUT_DIR/.verify-deb-$PKG_NAME.log"
  "$EXTRACT/opt/$NAME/$NAME" > "$VLOG" 2>&1 || true
  cat "$VLOG"
  if grep -q "PACKAGED_APP_VERIFY:PASS" "$VLOG"; then
    echo "verify: PASS"
  else
    echo "verify: FAIL (no PACKAGED_APP_VERIFY:PASS in $VLOG)" >&2
    exit 1
  fi
fi
