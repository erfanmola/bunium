#!/usr/bin/env bash
# Wraps the flat directory produced by packaging/linux/package.sh into an
# RPM binary package (.rpm), installable via `rpm -i` / dnf / zypper.
#
# rpmbuild works from an "rpmbuild tree" (BUILD/RPMS/SOURCES/SPECS/SRPMS)
# plus a .spec file describing what to install and where. Unlike dpkg-deb
# (which builds straight from a staged filesystem tree), rpmbuild wants a
# %install scriptlet that COPIES from %{buildroot} itself -- so this
# script's .spec %install step does the same "copy the flat package under
# /opt/<name>, symlink into /usr/bin, drop a .desktop" layout as
# package-deb.sh, just expressed as spec-file shell instead of a
# pre-staged tree. Same FHS placement choice as the .deb for consistency
# between the two package formats.
#
# No fakeroot needed here (unlike dpkg-deb) -- rpmbuild's %files section
# don't require host-root ownership tricks; a normal-user rpmbuild run
# produces a package whose payload is rewritten to root:root by rpm
# packaging convention automatically at build time.
#
# Usage:
#   packaging/linux/package-rpm.sh -p <flat-package-dir> [-o out-dir]
#     [--verify]
#
# <flat-package-dir> is the `Out/Name` directory packaging/linux/package.sh
# already produced (this script does not rebuild the app -- run package.sh
# first). --verify extracts the built RPM's cpio payload directly (via
# `rpm2cpio` if present, else `bsdtar`/`7z` fallback -- no real
# install/root needed) then runs the extracted launcher, requiring
# PACKAGED_APP_VERIFY:PASS.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

PKG_DIR=""
OUT_DIR="$REPO_ROOT/dist-app"
VERIFY=0

usage() {
  sed -n '2,30p' "$0" | grep -E '^#|^$' | sed 's/^# //; s/^#$//'
  exit 1
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    -p) PKG_DIR="$2"; shift 2 ;;
    -o) OUT_DIR="$2"; shift 2 ;;
    --verify) VERIFY=1; shift ;;
    *) echo "unknown option: $1" >&2; usage ;;
  esac
done

[ -n "$PKG_DIR" ] || { echo "missing -p <flat-package-dir>" >&2; usage; }
[ -d "$PKG_DIR" ] || { echo "error: $PKG_DIR not found" >&2; exit 1; }
# rpmbuild's %install scriptlet runs with its own cwd (deep inside
# _topdir/BUILD), so a relative PKG_DIR would resolve wrong there --
# canonicalize to an absolute path up front.
PKG_DIR="$(cd "$PKG_DIR" && pwd)"
NAME="$(basename "$PKG_DIR")"
[ -x "$PKG_DIR/$NAME" ] || { echo "error: $PKG_DIR/$NAME launcher missing -- run packaging/linux/package.sh first" >&2; exit 1; }

command -v rpmbuild >/dev/null 2>&1 || { echo "error: rpmbuild not found (install rpm-tools/rpm-build)" >&2; exit 1; }

# RPM package names conventionally lowercase too (not enforced by rpm the
# way dpkg enforces it, but kept consistent with the .deb naming).
PKG_NAME="$(echo "$NAME" | tr '[:upper:]' '[:lower:]')"
VERSION="1.0.0"
if [ -f "$PKG_DIR/app/package.json" ]; then
  v="$(grep -m1 '"version"' "$PKG_DIR/app/package.json" | sed -E 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/')"
  [ -n "$v" ] && VERSION="$v"
fi
RPM_ARCH="x86_64"
case "$(uname -m)" in
  aarch64 | arm64) RPM_ARCH="aarch64" ;;
  x86_64 | amd64) RPM_ARCH="x86_64" ;;
esac

TOPDIR="$OUT_DIR/.rpmbuild-$PKG_NAME"
echo "staging rpmbuild tree -> $TOPDIR"
rm -rf "$TOPDIR"
mkdir -p "$TOPDIR"/{BUILD,RPMS,SOURCES,SPECS,SRPMS,BUILDROOT}

# rpmbuild's %install runs a shell scriptlet with cwd inside the build
# tree; it has no built-in "copy a pre-existing directory tree" primitive
# the way dpkg-deb just builds from a tree, so the flat package dir is
# passed in via an rpmbuild --define (absolute path) and %install cp -a's
# it directly -- avoids re-tarring into SOURCES only to un-tar again.
cat > "$TOPDIR/SPECS/$PKG_NAME.spec" <<EOF
Name: $PKG_NAME
Version: $VERSION
Release: 1
Summary: $NAME (packaged with bunium)
License: Proprietary
BuildArch: $RPM_ARCH
AutoReqProv: no

%description
A bunium application, bundled with its own Bun runtime and CEF browser
engine under /opt/$NAME -- no system dependency on a specific Bun/CEF
version.

%install
rm -rf %{buildroot}
mkdir -p %{buildroot}/opt/$NAME
cp -a %{_srcpkgpath}/. %{buildroot}/opt/$NAME/
mkdir -p %{buildroot}/usr/bin
ln -s /opt/$NAME/$NAME %{buildroot}/usr/bin/$PKG_NAME
mkdir -p %{buildroot}/usr/share/applications
cat > %{buildroot}/usr/share/applications/$PKG_NAME.desktop <<DESKTOP
[Desktop Entry]
Type=Application
Name=$NAME
Exec=/opt/$NAME/$NAME
Icon=$PKG_NAME
Terminal=false
Categories=Utility;
DESKTOP

%files
/opt/$NAME
/usr/bin/$PKG_NAME
/usr/share/applications/$PKG_NAME.desktop

%clean
rm -rf %{buildroot}
EOF

# --dbpath points rpmbuild at an isolated, throwaway rpm database instead
# of the host's real /var/lib/rpm -- avoids requiring root (the real DB is
# root-owned on most distros) and avoids ever touching the host's actual
# installed-package state, purely for the %install scriptlet's own
# bookkeeping (this script never registers the built package as
# "installed" anywhere).
RPMDB="$TOPDIR/rpmdb"
mkdir -p "$RPMDB"
rpmbuild \
  --define "_topdir $TOPDIR" \
  --define "_srcpkgpath $PKG_DIR" \
  --define "_binary_payload w2.xzdio" \
  --dbpath "$RPMDB" \
  -bb "$TOPDIR/SPECS/$PKG_NAME.spec"

BUILT_RPM="$(find "$TOPDIR/RPMS" -name '*.rpm' -print -quit)"
[ -n "$BUILT_RPM" ] || { echo "error: rpmbuild did not produce an .rpm" >&2; exit 1; }
RPM_PATH="$OUT_DIR/${PKG_NAME}-${VERSION}-1.${RPM_ARCH}.rpm"
cp "$BUILT_RPM" "$RPM_PATH"
echo "rpm: $RPM_PATH ($(du -sh "$RPM_PATH" | awk '{print $1}'))"

if [ "$VERIFY" -eq 1 ]; then
  echo "verify: extracting .rpm payload (no real install/root needed) and running the launcher..."
  EXTRACT="$OUT_DIR/.rpm-verify-$PKG_NAME"
  rm -rf "$EXTRACT"
  mkdir -p "$EXTRACT"
  if command -v rpm2cpio >/dev/null 2>&1; then
    (cd "$EXTRACT" && rpm2cpio "$RPM_PATH" | cpio -idm --quiet)
  elif command -v bsdtar >/dev/null 2>&1; then
    (cd "$EXTRACT" && bsdtar -xf "$RPM_PATH")
  else
    echo "verify: FAIL (need rpm2cpio+cpio or bsdtar to extract .rpm for verification)" >&2
    exit 1
  fi
  [ -x "$EXTRACT/opt/$NAME/$NAME" ] || { echo "verify: FAIL (extracted launcher missing/not executable)" >&2; exit 1; }
  VLOG="$OUT_DIR/.verify-rpm-$PKG_NAME.log"
  "$EXTRACT/opt/$NAME/$NAME" > "$VLOG" 2>&1 || true
  cat "$VLOG"
  if grep -q "PACKAGED_APP_VERIFY:PASS" "$VLOG"; then
    echo "verify: PASS"
  else
    echo "verify: FAIL (no PACKAGED_APP_VERIFY:PASS in $VLOG)" >&2
    exit 1
  fi
fi
