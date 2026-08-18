#!/usr/bin/env bash
# Phase 10 CEF resource trim, shared by the app packager
# (packaging/mac/package.sh) and the release-artifact pipeline
# (scripts/stage-release-artifacts.sh). Trims its inputs in place.
#
# trim_cef_framework <framework_dir> <flat_libs_dir> <locales>
#   framework_dir   the "Chromium Embedded Framework.framework" bundle; its
#                   Resources/ holds the *.lproj locale dirs and the
#                   regenerable gpu_shader_cache.bin.
#   flat_libs_dir   dir where the caller laid out the framework's
#                   Libraries/*.dylib|json (the ANGLE libs the GPU process
#                   looks for next to the subprocess executable). The
#                   SwiftShader software-Vulkan stack is removed from here;
#                   pass the bundle's own Libraries/ when that copy should
#                   be trimmed too.
#   locales         comma-separated .lproj keeplist, or "all" to keep every
#                   locale dir.
#
# Effect: removes *lproj dirs not on the keeplist, the SwiftShader
# software-Vulkan stack (macOS always has Metal; ANGLE's Metal backend
# serves the GPU process, SwiftShader only exists for exotic software
# Vulkan), the regenerable shader cache, and .DS_Store junk. Chromium
# falls back to en-US strings when a requested locale's .lproj is absent,
# so a trimmed framework still runs -- just with untranslated chrome.
trim_cef_framework() {
  local fw_dir="$1" flat_libs_dir="$2" locales="$3"
  local res="$fw_dir/Resources"

  echo "trimming CEF resources (locales: $locales)..."
  if [ "$locales" = "all" ]; then
    echo "  keeping all *.lproj locale dirs (--locales all)"
  else
    # keeplist syntax: comma-separated language codes, e.g. "en,de,fr".
    local keep d lang
    keep="$(echo "$locales" | tr ',' '\n')"
    for d in "$res/"*.lproj; do
      [ -d "$d" ] || continue
      lang="$(basename "$d" .lproj)"
      if ! echo "$keep" | grep -qx "$lang"; then
        echo "  removing locale: $(basename "$d")"
        rm -rf "$d"
      fi
    done
  fi

  local f
  for f in libvk_swiftshader.dylib libvulkan.dylib vk_swiftshader_icd.json; do
    rm -f "$flat_libs_dir/$f"
  done

  # regenerable runtime shader cache + Finder junk from the vendored tree
  rm -f "$res/gpu_shader_cache.bin"
  rm -f "$fw_dir/.DS_Store"
}
