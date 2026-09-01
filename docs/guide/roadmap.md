# Roadmap

## Shipped

Window creation + OSR painting, transparency, frameless windows with
draggable regions and synthetic resize edges, macOS custom title bars
(`titleBarStyle`/`trafficLightPosition`), typed IPC, `<bunium-webview>`,
Vite dev + `bunium://` prod serving, native menu bar/tray/notifications/
dialogs, packaging (`.app`/`.exe`/`.deb`/`.rpm`/AppImage) with codesigning,
delta-patch auto-update with crash-journal self-repair, CEF resource
trimming, and per-platform npm packages — all implemented and passing
automated tests on macOS, Linux, and Windows.

## Near-term

- **Publish to npm.** The release pipeline (CI-built platform packages,
  staging scripts, install-consumer verification) is done; publishing
  itself is the last step. See [Publishing](/guide/publishing).
- **Windows platform package, real-hardware verification.** The staging
  and install-consumer scripts follow the same pattern already verified on
  macOS/Linux, but haven't had their first real run against a live Windows
  CEF build outside CI.
- **`-webkit-app-region: no-drag`.** Draggable regions currently swallow
  every click inside them — an override for interactive elements (buttons,
  inputs) nested in a drag region, matching Electron's convention.

## Under consideration

- **Wayland support on Linux** (X11 only today).
- **`<bunium-webview>` clip shapes** — `border-radius`/`clip-path` on a
  clipping ancestor (rectangular clipping only today).
- **Full CSS stacking-context semantics** for `<bunium-webview>` z-ordering
  (currently a flat `z-index` comparison, not nested contexts).
- **Sublayer alpha compositing** — sublayers currently paint opaque only.
- **Window vibrancy/dark-title-bar theming** (macOS `NSVisualEffectView`,
  Windows `DwmSetWindowAttribute` dark-mode caption) — not implemented yet,
  beyond the existing OS color-scheme sync for page content.
- **A cross-desktop global app menu on Linux** — no OS-level convention
  exists yet the way macOS/Windows have one; `Tray.setMenu()` is the
  current recommended substitute there.

## Contributing

This is an active solo project pre-1.0 — the public API can still move.
Issues and PRs are welcome; see [ARCHITECTURE.md](https://github.com/erfanmola/bunium/blob/main/ARCHITECTURE.md)
before touching native code, several approaches were deliberately tried and
rejected there.
