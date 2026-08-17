#!/usr/bin/env bash
# Builds bunium_shim.dylib + bunium_subprocess for macOS arm64.
# Requires vendor/cef-macosarm64/build/libcef_dll_wrapper/libcef_dll_wrapper.a
# to already exist (see vendor/cef-macosarm64/build, built via cmake once
# against the vendored CEF distribution).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CEF_ROOT="$REPO_ROOT/vendor/cef-macosarm64"
FRAMEWORK_DIR="$CEF_ROOT/Release"
FW="$FRAMEWORK_DIR/Chromium Embedded Framework.framework/Chromium Embedded Framework"
WRAPPER="$CEF_ROOT/build/libcef_dll_wrapper/libcef_dll_wrapper.a"
OUT_DIR="$REPO_ROOT/native/build"

if [ ! -f "$WRAPPER" ]; then
  echo "libcef_dll_wrapper.a not found -- run: cmake -S \"$CEF_ROOT\" -B \"$CEF_ROOT/build\" && cmake --build \"$CEF_ROOT/build\" --target libcef_dll_wrapper" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"

CXXFLAGS=(-std=c++20 -fno-rtti -fno-exceptions -fobjc-arc -fvisibility=hidden -mmacosx-version-min=12.0)
CCFLAGS=(-std=c11 -fvisibility=hidden -mmacosx-version-min=12.0)
BSDIFF_DIR="$REPO_ROOT/vendor/bsdiff"

# Vendored bsdiff/bspatch are C (not C++) -- fixed-size int64_t buffers etc.
# compile fine as C but trip over C++ void* rules, so build them as C objects.
# They also must not see the BSDIFF_EXECUTABLE/BSPATCH_EXECUTABLE paths
# (bzlib dependency) -- not defined here, so only the library API is built.
clang "${CCFLAGS[@]}" -c -o "$OUT_DIR/bsdiff.o" "$BSDIFF_DIR/bsdiff.c"
clang "${CCFLAGS[@]}" -c -o "$OUT_DIR/bspatch.o" "$BSDIFF_DIR/bspatch.c"

clang++ "${CXXFLAGS[@]}" \
  -I"$CEF_ROOT" -I"$BSDIFF_DIR" -F"$FRAMEWORK_DIR" -framework "Chromium Embedded Framework" -framework Cocoa \
  -framework Metal -framework QuartzCore -framework UserNotifications \
  -Wl,-headerpad_max_install_names \
  -dynamiclib -o "$OUT_DIR/bunium_shim.dylib" \
  "$SCRIPT_DIR/bunium_shim.cpp" "$SCRIPT_DIR/bunium_window_mac.mm" \
  "$SCRIPT_DIR/bunium_system_mac.mm" "$SCRIPT_DIR/bunium_system_notify_mac.mm" \
  "$SCRIPT_DIR/bunium_system_dialogs_mac.mm" \
  "$SCRIPT_DIR/bunium_bsdiff_wrap.mm" \
  "$OUT_DIR/bsdiff.o" "$OUT_DIR/bspatch.o" \
  "$WRAPPER"

clang++ "${CXXFLAGS[@]}" \
  -I"$CEF_ROOT" -F"$FRAMEWORK_DIR" -framework "Chromium Embedded Framework" \
  -Wl,-headerpad_max_install_names \
  -o "$OUT_DIR/bunium_subprocess" \
  "$SCRIPT_DIR/subprocess_main.cpp" \
  "$WRAPPER"

install_name_tool -change \
  "@executable_path/../Frameworks/Chromium Embedded Framework.framework/Chromium Embedded Framework" \
  "$FW" "$OUT_DIR/bunium_shim.dylib"
install_name_tool -change \
  "@executable_path/../Frameworks/Chromium Embedded Framework.framework/Chromium Embedded Framework" \
  "$FW" "$OUT_DIR/bunium_subprocess"

# Chromium's GPU process looks for ANGLE's GL libs next to the executable
# that launched it (bunium_subprocess here, not inside an app bundle where
# they'd normally live in Contents/Frameworks). Without these the GPU
# process crash-loops (~8x) before falling back to software compositing.
cp "$FRAMEWORK_DIR/Chromium Embedded Framework.framework/Libraries/"*.dylib "$OUT_DIR/"
cp "$FRAMEWORK_DIR/Chromium Embedded Framework.framework/Libraries/"*.json "$OUT_DIR/"

echo "built: $OUT_DIR/bunium_shim.dylib"
echo "built: $OUT_DIR/bunium_subprocess"
