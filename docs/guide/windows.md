# Windows build + run guide

Status: **multi-process CEF window works on Windows** (2026-08-20). The port
lives in `native/win/` and shares `native/mac/` sources (shim, subprocess,
bsdiff bridge) compiled by clang-cl.

## Toolchain

- **clang-cl** from LLVM (>= 19 works; tested 22.1.8). The MSVC toolchain
  headers/libs are auto-detected by clang-cl — no Visual Studio install needed.
- **Git for Windows** (its bash is the blessed shell; the build scripts and
  this guide assume it).
- **bun** (`winget install Oven-sh.Bun` or the installer from bun.sh).

## Build

```sh
export PATH="/c/Program Files/LLVM/bin:$PATH"
bash native/win/build.sh
```

This compiles `libcef_dll_wrapper` itself (`native/win/wrap_direct.sh`) plus the
shim + subprocess, and copies CEF's runtime DLLs/resources next to them. Output:
`native/build/bunium_shim.dll`, `native/build/bunium_subprocess.exe`.

No cmake, no pre-built wrapper, no sandbox library, no Visual Studio.

### Why we build the wrapper ourselves — CEF_USE_BOOTSTRAP

The CEF Windows distro ships a cmake-based `libcef_dll_wrapper` build that
compiles with `CEF_USE_BOOTSTRAP` defined (check
`vendor/cef-windows-x64/build/libcef_dll_wrapper/libcef_dll_wrapper.vcxproj`).

**Children crash when the wrapper has that define.** Every browser-spawned
child (GPU, network, storage, renderer) dies within ~300 ms with a corrupt
vtable AV (0xC0000005, `bunium_subprocess+0xdf18`:
`mov (%rcx),%rax; call *(%rax)` through a garbage `this`). Diagnosed with
procdump minidumps + WinDbg cdb (`!analyze -v`), and a `/Zi` wrapper build for
symbolicated stacks. `wrap_direct.sh` compiles the wrapper **without**
bootstrap; the shim and subprocess then link it and children run cleanly.

If you ever reintroduce the cmake wrapper build, `build.sh`'s wrapper plumbing
breaks silently — keep `wrap_direct.sh` as the single wrapper source.

### DLL search-order gotcha for `bun`

`dlopen("native/build/bunium_shim.dll")` from bun fails with error 126 unless
`native/build` is on `PATH` (the DLL's dependencies — libcef.dll etc — resolve
by load order, not by the loader's directory). Always run examples like:

```sh
PATH="/c/Users/<you>/Documents/bunium/native/build:$PATH" \
  bun examples/basic-window.ts
```

The `bunium_shim.dll` itself lives next to `libcef.dll` in `native/build/`;
the browser subprocess is pointed at `native/build/bunium_subprocess.exe` by
`src/paths.ts`.

## Verified

- `bun examples/basic-window.ts` — window opens, `frameCount` grows, clean
  close + shutdown.
- `examples/scheme-handler-test.ts` — custom `bunium://` scheme + pixel
  readback (limegreen center pixel) — real rendering.
- `examples/transparent-window-test.ts` — corner pixel opaque red, middle
  pixel transparent.
- `native/win/bringup_test.c` (throwaway harness) — view creation + pumping
  caveat: it hardcodes this machine's paths; only useful on this dev box.

Known example gaps: a couple of examples hardcode the macOS dylib/helper paths
and are mac-only by design (`draggable-regions-test.ts` etc).

## Debugging children again

1. Grab a minidump: `procdump64 -accepteula -e -x dumps bunium_subprocess.exe`
   (or `-t` for clean-exit captures), then run the harness/example.
2. Symbolicate with the store WinDbg's cdb:
   `cdb -z dumps/<file>.dmp -y <build dir> -c "!analyze -v; kv; q"`
3. Rebuild the wrapper with `/Zi` (already on) and relink the exe with
   `/DEBUG` for named functions.

## Remote dev from macOS

You don't need to sit at a Windows box: see
[docs/guide/dev-from-mac.md](dev-from-mac.md) (GitHub Actions
`windows-latest` smoke + optional SSH remote runner). Docker is a dead end —
Windows containers don't run on macOS.