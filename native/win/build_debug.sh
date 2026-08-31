#!/usr/bin/env bash
# throwaway: debug-symbol build for bring-up crash analysis.
set -euo pipefail
export MSYS2_ARG_CONV_EXCL='*'
CL="/c/Program Files/LLVM/bin/clang-cl.exe"
OUT="$(cygpath -w "$PWD")/native/build"
ROOT="$(cygpath -w "$PWD")"
CEF="$ROOT/vendor/cef-windows-x64"
WRAP="$(cygpath -w "$PWD")/native/build/wrapclang/libcef_dll_wrapper.lib"

compile() { # out.obj src flags...
  local obj="$1"; shift
  local src="$1"; shift
  "$CL" "$@" /nologo /c "/Fo$obj" "$src"
}

FLAGS=(/std:c++20 /GR /EHs-c- /O2 /Zi /MT /D_UNICODE /DUNICODE
       "/D_WIN32_WINNT=0x0A00" "-I$CEF" "-I$ROOT/vendor/bsdiff")

compile "$OUT/dbg_bsdiff_c.obj" "$ROOT/vendor/bsdiff/bsdiff.c" /MT
compile "$OUT/dbg_bspatch_c.obj" "$ROOT/vendor/bsdiff/bspatch.c" /MT
compile "$OUT/dbg_shim.obj" "$ROOT/native/mac/bunium_shim.cpp" "${FLAGS[@]}"
compile "$OUT/dbg_win.obj" "$ROOT/native/win/bunium_window_win.cc" "${FLAGS[@]}"
compile "$OUT/dbg_sys.obj" "$ROOT/native/win/bunium_system_win.cc" "${FLAGS[@]}"
compile "$OUT/dbg_bsdiff.obj" "$ROOT/native/mac/bunium_bsdiff_wrap.mm" /TP "${FLAGS[@]}"

"$CL" /nologo /LD /Zi /DEBUG "/Fe$OUT/bunium_shim_dbg.dll" \
  "$OUT/dbg_shim.obj" "$OUT/dbg_win.obj" "$OUT/dbg_sys.obj" \
  "$OUT/dbg_bsdiff.obj" "$OUT/dbg_bsdiff_c.obj" "$OUT/dbg_bspatch_c.obj" \
  "$WRAP" "$CEF/Release/libcef.lib" user32.lib gdi32.lib dwmapi.lib \
  shell32.lib ole32.lib ws2_32.lib
echo "BUILT $OUT/bunium_shim_dbg.dll"