#!/usr/bin/env bash
# throwaway: build libcef_dll_wrapper with clang-cl directly (no cmake).
set -euo pipefail
export MSYS2_ARG_CONV_EXCL='*'
CL="/c/Program Files/LLVM/bin/clang-cl.exe"
ROOT="$(cygpath -w "$PWD")"
CEF="$ROOT/vendor/cef-windows-x64"
OBJ="$ROOT/native/build/wrapclang"
mkdir -p "$OBJ"

# Flags: /GR is mandatory (CEF's CefRefPtr/RTTI layout breaks under /GR-).
# NOTE on CEF_USE_BOOTSTRAP: the distro's cmake wrapper defines it, but
# child subprocesses crash (corrupt vtable AV) when the wrapper has it. A
# non-bootstrap wrapper yields healthy multi-process children (verified), so
# wrap_direct stays bootstrap-free. /Zi keeps obj debug info so cdb can
# symbolicate child crashes after relinking with /DEBUG.
FLAGS=(/std:c++20 /O2 /MT /GR /Zi /EHsc /DUNICODE /DUNICODE /D_WIN32_WINNT=0x0A00
       /DNOMINMAX /DCEF_USE_SANDBOX=0 /DWRAPPING_CEF_SHARED
       "-I$CEF" "-I$CEF/include" "-I$CEF/libcef_dll")

compile_one() {
  "$CL" "${FLAGS[@]}" /nologo /Fo"$OBJ/$(basename "$1" .cc).obj" "/c" "$1"
}

for d in base wrapper cpptoc ctocpp; do
  for f in "$CEF/libcef_dll/$d"/*.cc; do
    [ -f "$f" ] || continue
    compile_one "$f"
  done
done
compile_one "$CEF/libcef_dll/shutdown_checker.cc"
compile_one "$CEF/libcef_dll/transfer_util.cc"

# Static lib from the objs. obj debug streams survive into the final exe PDB
# when linked with /DEBUG, so function names stay available under cdb.
mapfile -t OBJLIST < <(ls "$OBJ"/*.obj 2>/dev/null)
/c/Program\ Files/LLVM/bin/llvm-lib.exe "/OUT:$OBJ/libcef_dll_wrapper.lib" "${OBJLIST[@]}"
echo "WRAPPER LIB: $OBJ/libcef_dll_wrapper.lib"