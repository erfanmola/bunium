# Packaging

Phase 8 — macOS packaging, implemented and verified. Linux (Phase 6) and Windows
(Phase 7) packaging scripts are not written yet.

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
- **CI** — per-OS runners; Windows/Linux packaging scripts still to be written
  (Phase 8's NSIS / AppImage or deb/rpm intent).

## Debug env vars (keep, env-gated)

`BUNIUM_BUNDLE_DEBUG` (bundle identity dump), `BUNIUM_CEF_VERBOSE` (CEF
log_severity INFO + `[paint]`/`[load-_]`/`[scheme-_]` markers),
`BUNIUM_CEF_SWITCHES` (extra browser command-line switches — the real argv is
`bun <script>`, so Chromium's own switch parsing never sees post-script args).

Related: [Auto-update](/guide/updates) (uses the same launcher/restart shape),
[Publishing](/guide/publishing).
