#!/usr/bin/env bash
# Downloads/verifies the CEF Linux distro (pinned to the same 151.3.16
# version as vendor/cef-macosarm64 and the Windows CI pin) and builds
# libcef_dll_wrapper. Run inside the bunium-linux-dev container -- vendor/
# is git-ignored and this reproduces it, same pattern as
# .github/workflows/release.yml for macOS.
#
# Arch-aware: uses `uname -m` by default (matches whatever the container
# itself is running as -- arm64 on Apple Silicon Docker Desktop without
# --platform, x64 under --platform linux/amd64 emulation or a real x64
# host/CI runner). Override with BUNIUM_LINUX_ARCH=arm64|x64 if the
# detected value is ever wrong for some exotic host.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CEF_VERSION="151.3.16+gbe1e15d+chromium-151.0.7922.109"

case "${BUNIUM_LINUX_ARCH:-$(uname -m)}" in
  arm64 | aarch64)
    ARCH=arm64
    CEF_PLATFORM=linuxarm64
    CEF_SHA1="f1a82ce3bde5ea4338da5a41e0bcae22265f36f9"
    ;;
  x64 | x86_64 | amd64)
    ARCH=x64
    CEF_PLATFORM=linux64
    CEF_SHA1="13042a73aeaf0e853a719d3ddad0751514665bb9"
    ;;
  *)
    echo "Unsupported arch: ${BUNIUM_LINUX_ARCH:-$(uname -m)} (expected arm64 or x64)" >&2
    exit 1
    ;;
esac

ARCHIVE="cef_binary_${CEF_VERSION}_${CEF_PLATFORM}_minimal.tar.bz2"
DEST="$REPO_ROOT/vendor/cef-${CEF_PLATFORM}"

if [ -d "$DEST" ]; then
  echo "vendor/cef-${CEF_PLATFORM} already present, skipping fetch"
else
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  URL="https://cef-builds.spotifycdn.com/${ARCHIVE}"

  # The network path in front of this environment caps a single response at
  # 10MB (curl error 18 "Transferred a partial file" at exactly 10485760
  # bytes, reproduced even outside Docker) -- fetch in 10MB Range chunks and
  # concatenate instead of one streamed GET.
  CHUNK=10485760
  total="$(curl -fsI "$URL" | tr -d '\r' | awk -F': ' 'tolower($1)=="content-length"{print $2}')"
  : > "$TMP/$ARCHIVE"
  offset=0
  while [ "$offset" -lt "$total" ]; do
    end=$((offset + CHUNK - 1))
    if [ "$end" -ge "$total" ]; then end=$((total - 1)); fi
    curl -fL --retry 5 --retry-all-errors -r "${offset}-${end}" \
      -o "$TMP/chunk" -s "$URL"
    cat "$TMP/chunk" >> "$TMP/$ARCHIVE"
    rm -f "$TMP/chunk"
    offset=$((end + 1))
  done

  actual="$(sha1sum "$TMP/$ARCHIVE" | awk '{print $1}')"
  if [ "$actual" != "$CEF_SHA1" ]; then
    echo "CEF sha1 mismatch: expected $CEF_SHA1 got $actual" >&2
    exit 1
  fi
  mkdir -p "$REPO_ROOT/vendor"
  tar -xjf "$TMP/$ARCHIVE" -C "$REPO_ROOT/vendor"
  mv "$REPO_ROOT/vendor/cef_binary_${CEF_VERSION}_${CEF_PLATFORM}_minimal" "$DEST"
fi

if [ ! -f "$DEST/build/libcef_dll_wrapper/libcef_dll_wrapper.a" ]; then
  # cef_variables.cmake infers PROJECT_ARCH from CMAKE_HOST_SYSTEM_PROCESSOR
  # STREQUAL "arm64" -- Ubuntu's uname is "aarch64", so it silently falls
  # into the x86_64 branch (-m64/-march=x86-64, rejected by an ARM clang) if
  # left to auto-detect. Passed explicitly for both arches to sidestep this
  # entirely rather than relying on the auto-detect working for x64 too.
  #
  # Deliberately no -DCMAKE_BUILD_TYPE=Release: that defines NDEBUG for the
  # wrapper only, while native/linux/build.sh (matching mac/win) never
  # defines NDEBUG for bunium_shim.cpp/bunium_subprocess -- the mismatch
  # left DCHECK_IS_ON()-gated fields in CEF's base/ templates present in one
  # object's view of a class and absent in the other's, corrupting virtual
  # dispatch (confirmed via gdb: CefInitialize segfaulted computing a
  # virtual-base vtable offset on a scoped_refptr<CefApp> copy -- garbage
  # offset read at vtable-64, classic ODR/struct-layout mismatch symptom).
  CMAKE_ARCH=$([ "$ARCH" = "arm64" ] && echo arm64 || echo x86_64)
  rm -rf "$DEST/build"
  cmake -S "$DEST" -B "$DEST/build" -GNinja -DPROJECT_ARCH="$CMAKE_ARCH"
  cmake --build "$DEST/build" --target libcef_dll_wrapper
fi

echo "CEF ${CEF_PLATFORM} ${CEF_VERSION} ready at $DEST"
