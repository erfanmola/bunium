#!/usr/bin/env bash
# Builds bunium_shim.so + bunium_subprocess for Linux (arm64 or x64). Run
# inside the bunium-linux-dev container (see docker/linux/) -- reuses
# native/mac/bunium_shim.cpp, subprocess_main.cpp and bunium_bsdiff_wrap.mm
# unchanged (already proven platform-agnostic by the Windows port, which
# compiles the same three files as-is). Only window creation
# (bunium_window_linux.cc, X11) is Linux-specific -- system tray/menu/
# notifications/dialogs (Phase 5) are not ported yet, same v1 scope as
# Phase 6's "repeat Phase 0-1" plan note.
#
# Arch-aware like docker/linux/fetch-cef.sh: `uname -m` by default,
# override with BUNIUM_LINUX_ARCH=arm64|x64. Requires
# vendor/cef-<linuxarm64|linux64>/build/libcef_dll_wrapper/libcef_dll_wrapper.a
# (see docker/linux/fetch-cef.sh) for the matching arch already built.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

case "${BUNIUM_LINUX_ARCH:-$(uname -m)}" in
  arm64 | aarch64) CEF_PLATFORM=linuxarm64 ;;
  x64 | x86_64 | amd64) CEF_PLATFORM=linux64 ;;
  *)
    echo "Unsupported arch: ${BUNIUM_LINUX_ARCH:-$(uname -m)} (expected arm64 or x64)" >&2
    exit 1
    ;;
esac

CEF_ROOT="$REPO_ROOT/vendor/cef-${CEF_PLATFORM}"
CEF_RELEASE="$CEF_ROOT/Release"
WRAPPER="$CEF_ROOT/build/libcef_dll_wrapper/libcef_dll_wrapper.a"
# Deliberately NOT native/build/ -- this script is meant to run inside the
# bunium-linux-dev container with the repo bind-mounted from a macOS (or
# other-platform) host, and native/build/bunium_subprocess has the exact
# same filename as the mac/win build's own subprocess binary (no platform
# suffix, unlike bunium_shim.{dylib,so,dll}). A real incident: running this
# script clobbered the host's mac bunium_subprocess with the Linux ELF
# binary, breaking `bun run examples/*.ts` on the mac host with silent
# "cannot execute binary file" + GPU-process-crash-loop symptoms until
# `bun run build:native:mac` was rerun to restore it. A separate output dir
# makes that class of collision structurally impossible instead of relying
# on remembering to rebuild mac afterward.
OUT_DIR="$REPO_ROOT/native/build-linux"
BSDIFF_DIR="$REPO_ROOT/vendor/bsdiff"
MAC_SRC="$SCRIPT_DIR/../mac"

if [ ! -f "$WRAPPER" ]; then
  echo "libcef_dll_wrapper.a not found -- run docker/linux/fetch-cef.sh" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"

# g++ (not clang++): the wrapper .a below is built via CEF's own cmake
# (docker/linux/fetch-cef.sh), which resolves to /usr/bin/c++ -> g++ on
# this image. Building bunium_shim.cpp/subprocess with clang++ against a
# g++-built libcef_dll_wrapper.a segfaulted immediately inside
# CefInitialize (confirmed via gdb: the by-value scoped_refptr<CefApp>
# parameter's hidden-reference pointer came through as null/garbage) --
# a cross-compiler C++ ABI mismatch, not a bunium bug. Verified the fix by
# reproducing with a minimal standalone repro compiled both ways. Matches
# the project's existing Windows lesson (native/win/build.sh) that the
# wrapper and the code linking against it must be built with the exact
# same toolchain -- there it was a bootstrap-flag mismatch, here it's
# compiler-vendor.
CXX="${CXX:-g++}"
CC="${CC:-gcc}"
CXXFLAGS=(-std=c++20 -fno-rtti -fno-exceptions -fvisibility=hidden -fPIC -DCEF_USE_SANDBOX=0)
CCFLAGS=(-std=c11 -fvisibility=hidden -fPIC)

"$CC" "${CCFLAGS[@]}" -c -o "$OUT_DIR/bsdiff.o" "$BSDIFF_DIR/bsdiff.c"
"$CC" "${CCFLAGS[@]}" -c -o "$OUT_DIR/bspatch.o" "$BSDIFF_DIR/bspatch.c"

# bunium_bsdiff_wrap.mm ships no Obj-C despite its extension (see the
# Windows build.sh comment) -- force C++ mode. Compiled to its own object
# (not passed inline with -x c++) because -x stays in effect for every
# later arg on the command line, including .o/.a files -- passing it inline
# earlier made clang try to parse libcef_dll_wrapper.a as C++ source.
"$CXX" "${CXXFLAGS[@]}" -x c++ -I"$CEF_ROOT" -I"$BSDIFF_DIR" \
  -c -o "$OUT_DIR/bunium_bsdiff_wrap.o" "$MAC_SRC/bunium_bsdiff_wrap.mm"

"$CXX" "${CXXFLAGS[@]}" \
  -I"$CEF_ROOT" -I"$BSDIFF_DIR" \
  -shared -fPIC -o "$OUT_DIR/bunium_shim.so" \
  "$MAC_SRC/bunium_shim.cpp" "$SCRIPT_DIR/bunium_window_linux.cc" \
  "$SCRIPT_DIR/bunium_system_linux_stub.cc" \
  "$OUT_DIR/bunium_bsdiff_wrap.o" \
  "$OUT_DIR/bsdiff.o" "$OUT_DIR/bspatch.o" \
  "$WRAPPER" -L"$CEF_RELEASE" -lcef -lX11 -lXext -lpthread \
  -Wl,-rpath,'$ORIGIN'

"$CXX" "${CXXFLAGS[@]}" \
  -I"$CEF_ROOT" \
  -o "$OUT_DIR/bunium_subprocess" \
  "$MAC_SRC/subprocess_main.cpp" \
  "$WRAPPER" -L"$CEF_RELEASE" -lcef -lpthread \
  -Wl,-rpath,'$ORIGIN'

# libcef.so + its resource/locale data are looked up via $ORIGIN-relative
# rpath above; copy libcef.so next to the built artifacts so dev-tree runs
# (no BUNIUM_FRAMEWORK_DIR override) resolve it without extra env setup,
# matching the ANGLE-libs-next-to-executable step in the mac build.
cp "$CEF_RELEASE/libcef.so" "$OUT_DIR/"

# Chromium's ICU/V8 init (base::i18n::InitializeICU, gin/v8_initializer)
# looks for icudtl.dat and v8_context_snapshot.bin next to the running
# executable as its actual load path on Linux -- CefSettings.resources_dir_
# path alone was NOT enough (confirmed empirically: without these copies,
# the browser process hard-crashed with "Invalid file descriptor to ICU
# data received" / "FATAL: Error loading V8 startup snapshot file" even
# though resources_dir_path correctly pointed at vendor/cef-linuxarm64/
# Resources, which does contain icudtl.dat but not the V8 snapshot at all
# -- that one only ships in Release/, not Resources/).
cp "$CEF_RELEASE/../Resources/icudtl.dat" "$OUT_DIR/"
cp "$CEF_RELEASE/v8_context_snapshot.bin" "$OUT_DIR/"

# Same DIR_MODULE-relative lookup issue, one layer further: Chrome-runtime's
# own resource-bundle init (chrome/browser/chrome_resource_bundle_helper.cc)
# resolves chrome_100_percent.pak/chrome_200_percent.pak/resources.pak (and
# the locale paks) relative to libcef.so's own directory via dladdr/
# PathService::Get(base::DIR_MODULE) -- NOT via CefSettings.resources_dir_
# path, which only governs CEF's own resource-bundle delegate. Confirmed
# empirically: with only icudtl.dat/v8_context_snapshot.bin copied, the
# browser process hard-crashed inside ChromeMainDelegate::
# PostEarlyInitialization -> LoadLocalState (a release CHECK, SIGTRAP, no
# stderr message) even though resources_dir_path correctly pointed at
# vendor/cef-linuxarm64/Resources, which does contain these paks. Matches
# native/win/build.sh's own already-working pattern (copies *.pak/locales/
# next to the DLL for the same reason) -- mirrored here for Linux.
cp "$CEF_RELEASE/../Resources/"*.pak "$OUT_DIR/"
cp -r "$CEF_RELEASE/../Resources/locales" "$OUT_DIR/"

echo "built: $OUT_DIR/bunium_shim.so"
echo "built: $OUT_DIR/bunium_subprocess"
