#!/usr/bin/env bash
# Builds bunium_shim.dll + bunium_subprocess.exe for Windows x64.
# Run from a Windows environment with:
#   - clang-cl (LLVM; MSVC toolchain headers/libs via clang-cl's own
#     vcvars detection -- plain cl.exe + vcvars also works with CXX=cl
#     style adjustment, but clang-cl is the blessed path) -- add LLVM's
#     bin dir to PATH
#   - vendor/cef-windows-x64 with the libcef_dll_wrapper built once via
#     cmake (same as the mac flow): cmake -S vendor/cef-windows-x64
#     -B vendor/cef-windows-x64/build -G "Visual Studio 17 2022" -A x64
#     && cmake --build vendor/cef-windows-x64/build --target libcef_dll_wrapper
#   - vendor/bsdiff (shared with the mac build)
set -euo pipefail

# Git-Bash/MSYS mangles leading-slash compiler flags into path args; the
# compile lines below mix real Windows paths (kept in pwd -W form) with
# clang-cl /flags, so disable MSYS argument conversion for this script.
export MSYS2_ARG_CONV_EXCL='*'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -W)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd -W)"
CEF_ROOT="$REPO_ROOT/vendor/cef-windows-x64"
CEF_RELEASE="$CEF_ROOT/Release"
WRAPPER="$CEF_ROOT/build/libcef_dll_wrapper/Release/libcef_dll_wrapper.lib"
OUT_DIR="$REPO_ROOT/native/build"
BSDIFF_DIR="$REPO_ROOT/vendor/bsdiff"
MAC_SRC="$SCRIPT_DIR/../mac"
WIN_SRC="$SCRIPT_DIR"

CXX="${CXX:-clang-cl}"
if ! command -v "$CXX" >/dev/null 2>&1; then
  echo "$CXX not found on PATH -- add LLVM's bin dir (see header comment)" >&2
  exit 1
fi

if [ ! -f "$WRAPPER" ]; then
  echo "libcef_dll_wrapper.lib not found -- build it first (see header comment)" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"

# clang-cl + MSVC ABI. /GR- /EHs-c- (-fno-rtti/-fno-exceptions) match the
# mac flags and CEF's own build. The CEF headers need _WIN32_WINNT to opt
# into modern APIs (GetDpiForWindow etc.).
COMMON_FLAGS=(
  /std:c++20 /GR /EHs-c- /O2 /D_UNICODE /DUNICODE
  /D_WIN32_WINNT=0x0A00 "-I$CEF_ROOT" "-I$BSDIFF_DIR"
)

# Vendored bsdiff/bspatch are C -- compile as C objects (same as mac).
"$CXX" /nologo /c "/Fo$OUT_DIR/bsdiff.obj" "$BSDIFF_DIR/bsdiff.c"
"$CXX" /nologo /c "/Fo$OUT_DIR/bspatch.obj" "$BSDIFF_DIR/bspatch.c"

# Each TU gets its own /Fo (clang-cl rejects one /Fo across several
# sources), then a single link pass stitches the DLL together.
"$CXX" "${COMMON_FLAGS[@]}" /nologo /c "/Fo$OUT_DIR/bunium_shim.obj" \
  "$MAC_SRC/bunium_shim.cpp"
"$CXX" "${COMMON_FLAGS[@]}" /nologo /c "/Fo$OUT_DIR/bunium_window_win.obj" \
  "$WIN_SRC/bunium_window_win.cc"
"$CXX" "${COMMON_FLAGS[@]}" /nologo /c "/Fo$OUT_DIR/bunium_system_win.obj" \
  "$WIN_SRC/bunium_system_win.cc"
# The bsdiff bridge is plain C++ despite its .mm extension (it predates the
# Windows port and ships no Obj-C) -- force C++ mode so clang-cl doesn't
# try an Obj-C++ compile.
"$CXX" "${COMMON_FLAGS[@]}" /nologo /c /TP \
  "/Fo$OUT_DIR/bunium_bsdiff_wrap.obj" "$MAC_SRC/bunium_bsdiff_wrap.mm"

"$CXX" /nologo /LD "/Fe$OUT_DIR/bunium_shim.dll" \
  "$OUT_DIR/bunium_shim.obj" "$OUT_DIR/bunium_window_win.obj" \
  "$OUT_DIR/bunium_system_win.obj" "$OUT_DIR/bunium_bsdiff_wrap.obj" \
  "$OUT_DIR/bsdiff.obj" "$OUT_DIR/bspatch.obj" \
  "$WRAPPER" "$CEF_RELEASE/libcef.lib" user32.lib gdi32.lib dwmapi.lib \
  shell32.lib ole32.lib

"$CXX" "${COMMON_FLAGS[@]}" /nologo /c \
  "/Fo$OUT_DIR/subprocess_main.obj" "$MAC_SRC/subprocess_main.cpp"
"$CXX" /nologo "/Fe$OUT_DIR/bunium_subprocess.exe" \
  "$OUT_DIR/subprocess_main.obj" \
  "$WRAPPER" "$CEF_RELEASE/libcef.lib"

# CEF Windows ships its runtime DLLs + resources flat in Release/ -- the GPU
# and renderer subprocesses find them via the executable's directory, so
# mirror them next to our outputs (like the mac ANGLE dylib copy below).
cp "$CEF_RELEASE/"*.dll "$OUT_DIR/" 2>/dev/null || true
cp "$CEF_RELEASE/"*.bin "$OUT_DIR/" 2>/dev/null || true
cp "$CEF_RELEASE/"*.dat "$OUT_DIR/" 2>/dev/null || true
cp "$CEF_RELEASE/"*.pak "$OUT_DIR/" 2>/dev/null || true
cp "$CEF_RELEASE/locales/" "$OUT_DIR/" 2>/dev/null || true

echo "built: $OUT_DIR/bunium_shim.dll"
echo "built: $OUT_DIR/bunium_subprocess.exe"