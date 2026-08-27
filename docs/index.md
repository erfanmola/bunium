---
layout: home

hero:
  name: bunium
  tagline: Electron-like framework — Bun + CEF + TypeScript
  image:
    src: /icon.png
    alt: bunium
  actions:
    - theme: brand
      text: Getting started
      link: /guide/getting-started
    - theme: alt
      text: API reference
      link: /api/

features:
  - title: Real Chromium
    details: CEF (Chromium Embedded Framework) renders every window — no WebView shims, no system-browser inconsistencies.
  - title: Typed IPC
    details: One generic transport, discriminated-union message maps checked on both sides at compile time.
  - title: DOM <bunium-webview>
    details: A real custom element that composites as a native CAMetalLayer sublayer — clipped, z-ordered, hit-testable.
  - title: Vite dev + bunium:// prod
    details: Point loadURL at the dev server for HMR in dev; serve built output over a custom scheme in prod.
  - title: System features
    details: Native menu bar, tray, notifications, and dialogs — each a thin typed wrapper over a flat C ABI.
  - title: Auto-update
    details: bsdiff patch-or-full-manifest updater that never re-downloads the CEF layer, plus crash-journal self-repair.
---

## Status

Window/paint, typed IPC, `<bunium-webview>`, Vite dev + `bunium://` prod, native
system features (menu/tray/notifications/dialogs), packaging + codesigning,
auto-update, CEF resource trim, and per-platform npm packages are all implemented
and verified across **macOS, Linux, and Windows** — see
[Publishing](/guide/publishing) for the release pipeline.

Desktop-interactive behavior (real mouse drags, tray clicks, notification banners) is
verified by plumbing tests only — it needs a real desktop session to confirm visually.
