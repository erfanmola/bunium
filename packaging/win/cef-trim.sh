#!/usr/bin/env bash
# Phase 10 CEF resource trim for Windows, mirroring packaging/mac/cef-trim.sh
# and packaging/linux/cef-trim.sh (see those for the full SwiftShader
# rationale -- same lesson: dead weight on any platform where ANGLE already
# has a real GPU backend for the GPU process, which it does on Windows via
# D3D11/D3D9 as well as macOS' Metal and Linux's swrast/GL).
#
# CAVEAT (unlike the mac/Linux versions of this file): this machine has no
# vendor/cef-windows-x64/ to test against (Linux dev box, Windows packaging
# only runs on a real Windows host per packaging/win/package.sh's own
# header). The filenames below are the standard CEF Windows minimal-distro
# names for this stack (vk_swiftshader.dll, vulkan-1.dll,
# vk_swiftshader_icd.json) -- same trio mac/Linux ship, .dll extension
# instead of .dylib/.so -- but this has NOT been verified against a real
# vendored Windows CEF distro the way the mac/Linux trims were (both
# confirmed via `ls` against the actual vendored files before writing the
# removal list). Treat this as implemented-but-unverified-on-real-Windows;
# rm -f is silently a no-op on a missing file either way, so a wrong
# filename here fails safe (nothing removed, nothing broken) rather than
# erroring the packaging run.
#
# trim_cef_runtime <runtime_dir>
#   runtime_dir   packaging/win/package.sh's Runtime/ dir, where the CEF
#                 Release/ DLLs are copied flat (see that script).
trim_cef_runtime() {
  local runtime_dir="$1"

  echo "trimming CEF SwiftShader/software-Vulkan stack..."
  local f
  for f in vk_swiftshader.dll vulkan-1.dll vk_swiftshader_icd.json; do
    if [ -f "$runtime_dir/$f" ]; then
      echo "  removing: $f"
      rm -f "$runtime_dir/$f"
    fi
  done
}
