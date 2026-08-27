# Packaging

macOS, Windows, and Linux packaging, all implemented and verified: a flat runnable
directory plus real `.deb`/`.rpm`/AppImage distribution formats on Linux.

## Usage

```sh
bun run pack:mac -a <app-dir> [-n Name] [-i com.example.name] [-o out] \
  [-r repo] [-b bun] [-v ver] [-c icon.icns] [--no-dmg]
```

Produces `dist-app/Name.app` with `Contents/{MacOS,Frameworks,Resources}`:

- The launcher (`Contents/MacOS/Name`) exports `BUNIUM_SHIM_PATH` /
  `BUNIUM_SUBPROCESS_PATH` / `BUNIUM_FRAMEWORK_DIR` /
  `BUNIUM_ROOT_CACHE_PATH` (a per-app CEF profile under
  `~/Library/Application Support/Name/`) then execs the bundled bun on
  `Resources/app/electron/main.ts`. `src/native.ts` reads the same env overrides
  in dev, so one path-resolution codebase serves both modes.
- **Helper apps** (`bunium_subprocess (Renderer).app` / `(Alerts).app`, siblings
  of the main .app) — Chromium launches the renderer and alert utility through
  per-type helper bundles named after the subprocess basename. Two constraints:
  the helper's `CFBundleIdentifier` **must equal the main app's** (the child
  derives its MachPortRendezvous lookup name from its own bundle id), and
  `install_name_tool` cannot open a file whose final path component contains
  spaces — rewrite a no-space temp copy and `mv` it into place.
- Ad-hoc codesign (`codesign --force --deep --sign -`) of the app **and each
  helper** (`--deep` doesn't reach siblings).
- DMG via `hdiutil create` (deprecation warning is cosmetic).
- **CEF resource trim (default ON)**: strips `*.lproj` except `en`, the
  SwiftShader software-Vulkan stack (`libvk_swiftshader.dylib`, `libvulkan.dylib`,
  `vk_swiftshader_icd.json`), regenerable `gpu_shader_cache.bin`, and `.DS_Store`.
  **401M → 335M (−16%)**, DMG 161M. Opt-outs: `--no-trim` (full original CEF),
  `--locales all`. Chromium falls back to en-US strings when a locale's `.lproj`
  is absent — a trimmed app runs with untranslated browser chrome.

## Linux (packaging/linux/package.sh + package-deb.sh/package-rpm.sh/package-appimage.sh)

```sh
bun run pack:linux -a <app-dir> [-n Name] [-o out] [-r repo] [-b bun] \
  [-v ver] [--locales en[,de,...]] [--verify] [--no-trim]
```

Produces `dist-app/Name/` (flat, X11/Wayland have no bundle concept):

- **`Name`** — a plain shell launcher (no console-flash/shebang-exec
  limitation on Linux the way Windows has, so no compiled launcher is
  needed — mirrors macOS' approach more than Windows'). Exports
  `BUNIUM_SHIM_PATH`/`BUNIUM_SUBPROCESS_PATH`/`BUNIUM_FRAMEWORK_DIR`/
  `BUNIUM_RESOURCES_DIR` + a per-app `BUNIUM_ROOT_CACHE_PATH`
  (`$XDG_CACHE_HOME/Name/CEF`), then execs the bundled `bun` on
  `app/electron/main.ts`.
- **`Runtime/`** — `bunium_shim.so` + `bunium_subprocess` + `libcef.so` +
  `icudtl.dat` + the V8 snapshot + `chrome_*.pak`/`resources.pak` + `locales/`,
  all merged into one directory (Chromium resolves these paths relative to
  `libcef.so`'s own directory via `dladdr`, independent of
  `CefSettings.resources_dir_path` — see `native/linux/build.sh` for the
  crash this caused when the two lookup paths first diverged). `bunium_shim.so`/
  `bunium_subprocess` use an `$ORIGIN`-relative rpath, so `libcef.so` resolves
  with no `LD_LIBRARY_PATH` needed. `libcef.so` is stripped
  (`strip --strip-unneeded`) at build time — the vendored CEF distro ships it
  unstripped with full DWARF debug info (1.4G vs 268M stripped; macOS' framework
  dylib ships already-stripped, so this asymmetry is Linux-specific).
- **`app/`** — the app + a materialized (un-symlinked) `node_modules/bunium`.

**CEF resource trim (default ON)**: removes the SwiftShader software-Vulkan
stack (`libvk_swiftshader.so`, `libvulkan.so.1`, `vk_swiftshader_icd.json` —
same trio mac trims, `.so` extension instead of `.dylib`). Opt out with
`--no-trim`. See `packaging/linux/cef-trim.sh`.

Real distribution formats, each wrapping the flat `Name/` package.sh output
(run package.sh first) rather than re-deriving it:

```sh
bun run pack:linux:deb -p dist-app/Name [-o out] [-m "Maintainer <email>"] [--verify]
bun run pack:linux:rpm -p dist-app/Name [-o out] [--verify]
bun run pack:linux:appimage -p dist-app/Name [-o out] [-t appimagetool] [--verify]
```

- **`.deb`** (`packaging/linux/package-deb.sh`) — installs the flat package
  under `/opt/<name>/`, symlinks `/usr/bin/<name>`, drops a `.desktop` entry.
  Built via `fakeroot dpkg-deb --build` (fakeroot fabricates root:root
  ownership in the payload without needing real root). `--verify` extracts
  via `dpkg-deb -x` (no install/root needed) and runs the launcher.
- **`.rpm`** (`packaging/linux/package-rpm.sh`) — same `/opt/<name>/` layout,
  built via `rpmbuild -bb` against a generated `.spec` and an isolated
  `--dbpath` (never touches the host's real rpm database, no root needed).
  `--verify` extracts the payload via `rpm2cpio | cpio` (or `bsdtar` fallback)
  and runs the launcher.
- **AppImage** (`packaging/linux/package-appimage.sh`) — the distribution-
  agnostic option (not tied to any one packaging ecosystem). Wraps the flat
  package into an `AppDir` (`AppRun` + `.desktop` + a placeholder icon
  synthesized via ImageMagick, since no bundled app-icon asset exists yet)
  and builds via `appimagetool` (not vendored by this repo — install from
  <https://github.com/AppImage/AppImageKit/releases>, tag `continuous`,
  `appimagetool-x86_64.AppImage`; no root/AUR/package-manager step required,
  it's a single standalone executable). `--verify` runs the built AppImage
  with `--appimage-extract-and-run`, which works even without `/dev/fuse`
  (common in containers/CI/sandboxes) — real FUSE-mounted execution
  (the default when double-clicked or run directly) was separately verified
  to also pass.

No icon asset ships in this repo yet for the `.desktop`/AppImage icon
fields — a real icon can be added later via a `-c <icon.png>` flag on
`package-appimage.sh`/`package-deb.sh` (mirroring `packaging/mac/package.sh`'s
`-c <icon.icns>`) without changing either script's structure.

Signing: none (no Linux-distribution-wide code-signing convention the way
Apple/Microsoft have one; distro packages are typically signed only when
published to a repo, which is out of v1 scope here).

## Windows (packaging/win/package.sh)

```sh
bun run pack:win -a <app-dir> [-n Name] [-o out] [-r repo] [-b bun.exe] \
  [--locales en[,de,...]] [--verify] [--no-trim]
```

Must run on Windows in Git Bash (needs the Windows CEF distro, clang-cl, and
a Windows bun.exe — same toolchain as `native/win/build.sh`). Run it from a
mac via [the remote runner](/guide/dev-from-mac) (`scripts/win-remote.sh
pack`) or the win-smoke CI job, which both package and verify.

Produces `dist-app/Name/` (flat, Windows has no bundle):

- **`Name.exe`** — a compiled launcher (`packaging/win/launcher.c`, clang-cl,
  subsystem so there's no console flash). It exports
  `BUNIUM_SHIM_PATH`/`BUNIUM_SUBPROCESS_PATH`/`BUNIUM_FRAMEWORK_DIR`/
  `BUNIUM_RESOURCES_DIR` + a per-app
  `BUNIUM_ROOT_CACHE_PATH` (`%LOCALAPPDATA%\Name\CEF`), prepends `Runtime/`
  to `PATH` so the shim's `libcef.dll` import resolves, then spawns the
  bundled `bun.exe` on `app/electron/main.ts`, passing through std handles
  and the exit code (CI/ssh still see output).
- **`Runtime/`** — CEF `Release/` contents + `bunium_shim.dll` +
  `bunium_subprocess.exe`. The browser process finds `libcef.dll` via PATH;
  child processes find everything next to their own exe. One subprocess exe
  serves every CEF process type (no macOS-style helper bundles).
  **CEF resource trim (default ON, `--no-trim` to opt out)**: removes the
  SwiftShader software-Vulkan stack (`vk_swiftshader.dll`, `vulkan-1.dll`,
  `vk_swiftshader_icd.json`), same trio mac/Linux trim. Implemented by
  inference from the mac/Linux filenames — not verified against a real
  Windows CEF distro (no Windows dev box for this); see
  `packaging/win/cef-trim.sh`'s header for the caveat. `rm -f` fails safe on
  a wrong filename (no-op, not an error).
- **`Resources/`** — CEF `Resources/` (`resources_dir_path`); `--locales en`
  trims the locale paks (Chromium falls back to en-US).
- **`app/`** — the app + a materialized (un-symlinked) `node_modules/bunium`.
- **`bun.exe.manifest`** — the comctl32 v6 SxS dependency that makes the
  shim's `TaskDialogIndirect` resolve inside the packaged app (real
  TaskDialogs; the dev-tree `MessageBoxW` fallback stays for processes with
  no manifest, by design).

Signing: none. Windows distribution signing is TLS-code-signing oriented;
local use needs nothing (SmartScreen may warn on hand-transferred builds —
clear Mark-of-the-Web on downloaded zips).

## Minimum app shape

The `-a` app dir must contain `electron/main.ts` (or `.js`) plus the built static
output the main process serves via `app.setAppRoot()` + `loadURL("bunium://app/")`
— see the [packaging fixture](https://github.com/bunium/bunium/tree/main/packaging/mac/fixture-app).

## Verification

`packaging/mac/fixture-app` loads `bunium://app/` and pixel-verifies the page
rendered green; exit 0 = PASS. The verifier polls for the green paint rather than
accepting the first frame (the first `OnPaint` can be the pre-paint white surface
on a cold profile). Verified PASS for a fresh package, cold wiped profile,
relocated app + helpers (no absolute-path leakage), and the dev-tree fixture run.

## Not done / not blocking locally

- **Notarization + real signing** — ad-hoc works locally; Developer ID +
  notarization needs Apple credentials (documented in `package.sh`'s header).
- **CI** — per-OS runners; Linux packaging (flat dir + deb/rpm/AppImage) is
  implemented and locally verified, and the flat-dir form is now CI-covered
  in `.github/workflows/linux-smoke.yml` (build + full `examples/` sweep +
  package/verify on every PR). deb/rpm/AppImage stay local-only (AppImage in
  particular would need `appimagetool` vendored into the runner image).
  Windows packaging is CI-covered in `win-smoke.yml` (package + verify the
  packaged EXE on every PR).
- **Linux native menu bar** — `tray.setMenu()` is real (served via a
  hand-rolled `com.canonical.dbusmenu` implementation on the tray's own
  D-Bus connection, see `native/linux/bunium_system_menu_linux.cc` +
  `bunium_system_tray_linux.cc`). `Menu.setApplicationMenu()` stays an
  honest no-op: there is still no cross-desktop application-level (not
  tray-attached) global-menu-bar convention the way SNI is a universal tray
  protocol, and `bunium`'s Linux window is raw Xlib with no GTK/Qt toplevel
  to attach an in-window menu bar to. A `Menu` built via the public API is
  still fully usable — attach it via `tray.setMenu()`, the supported v1 path.
- **Linux Wayland-native backend** — Xwayland compatibility is verified
  sufficient for v1; a Wayland-native backend is out of scope.

## Debug env vars (keep, env-gated)

`BUNIUM_BUNDLE_DEBUG` (bundle identity dump), `BUNIUM_CEF_VERBOSE` (CEF
log_severity INFO + `[paint]`/`[load-_]`/`[scheme-_]` markers),
`BUNIUM_CEF_SWITCHES` (extra browser command-line switches — the real argv is
`bun <script>`, so Chromium's own switch parsing never sees post-script args).

Related: [Auto-update](/guide/updates) (uses the same launcher/restart shape),
[Publishing](/guide/publishing).
