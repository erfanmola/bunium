#!/usr/bin/env bash
# Phase 10 CEF resource trim for Linux, mirroring packaging/mac/cef-trim.sh
# (see that file for the full rationale -- same lesson applies here
# verbatim: SwiftShader's software-Vulkan stack is dead weight on any
# platform where ANGLE already has a real GPU backend to serve the GPU
# process, and it isn't).
#
# trim_cef_runtime <runtime_dir>
#   runtime_dir   the merged Runtime/ dir packaging/linux/package.sh lays
#                 out (bunium_shim.so, bunium_subprocess, libcef.so,
#                 icudtl.dat, v8_context_snapshot.bin, chrome_*.pak/
#                 resources.pak, locales/ -- see that script's header for
#                 why these all live in one flat dir on Linux).
#
# Effect: removes the SwiftShader software-Vulkan stack (libvk_swiftshader.
# so, libvulkan.so.1, vk_swiftshader_icd.json -- confirmed present in the
# vendored vendor/cef-linux64/Release/ distro, same three files as mac's
# .dylib/.json trio, ~14.9M+1.5M+107B here). Linux's vendored CEF distro
# does NOT ship a gpu_shader_cache.bin under Release/ or Resources/
# (checked -- mac's Frameworks/.../Resources/gpu_shader_cache.bin has no
# Linux equivalent in this distro layout), so there is nothing regenerable
# to remove on that front. Locale trimming is handled separately in
# package.sh itself (Linux's locales/*.pak keeplist loop), not here, since
# it's driven by the same --locales flag mac's trim_cef_framework also
# folds in -- kept as package.sh's own loop rather than moved here only
# because it predates this file and touches locales/ which lives beside,
# not inside, the SwiftShader files this function is responsible for;
# nothing wrong with that split, just noting it for anyone expecting one
# single trim entrypoint the way mac has it.
trim_cef_runtime() {
  local runtime_dir="$1"

  echo "trimming CEF SwiftShader/software-Vulkan stack..."
  local f
  for f in libvk_swiftshader.so libvulkan.so.1 vk_swiftshader_icd.json; do
    if [ -f "$runtime_dir/$f" ]; then
      echo "  removing: $f"
      rm -f "$runtime_dir/$f"
    fi
  done
}
