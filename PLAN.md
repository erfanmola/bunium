# bunium — phased plan

Electron-like framework: Bun + CEF + TS, DOM-integrated `<webview>`, Vite dev, SolidJS boilerplate,
cross-platform packaging/signing/updates, extensible (tray/menu/system features).

Read `ARCHITECTURE.md` first — it has the load-bearing technical decisions from Phase 0. Don't
redo work it already settled.

Each phase gets broken into `TaskCreate` items only when actively started (keeps context lean —
don't pre-generate 80 tasks now). Update this file's checkboxes as phases complete; that's the
cross-session memory of where things stand.

## Repo/tooling status (2026-08-10)

- Git initialized (`master` branch), `.gitignore` excludes `vendor/` (388M CEF distro),
  `node_modules/`, `native/build/`, `poc/` (historical, superseded by `native/mac/` + `src/`).
  No commits made yet -- not asked to commit, just init.
- Biome added as linter/formatter (`bun run lint` = `biome check .`), config at `biome.json`
  (2-space indent to match existing style, `noNonNullAssertion` off -- the codebase's `!` usage
  is deliberate, from `noUncheckedIndexedAccess`-driven narrowing and known-non-null FFI results
  after success checks, not lazy escapes). Clean as of this point; keep it that way.
- **Repo pushed to GitHub (2026-08-18):** `github.com/erfanmola/bunium` (private, branch
  `main`), first commit. CI + Pages in `.github/workflows/`: `ci.yml` (bun install →
  `bun run lint` → `bun run typecheck` on push/PR; examples deliberately excluded -- they
  need the git-ignored native shim + 388M CEF distro a fresh clone can't build) and
  `docs.yml` (build VitePress docs with `BUNIUM_DOCS_BASE=/bunium/` → upload →
  deploy-pages on push to main; needs Pages > Source > "GitHub Actions" set in repo
  settings). Docs site once deployed: `https://erfanmola.github.io/bunium/`.

## Standing cross-cutting requirements (apply to every phase, not a phase themselves)

- **Fully typed TS, strict mode.** `tsconfig.json` has `strict: true`. Every public API in `src/`
  exports its types (already true for `BuniumWindowOptions`) — keep it that way as the API grows.
  No `any` in `src/` without a comment justifying it. Check with `bunx tsc --noEmit` before
  considering a `src/` change done, not just "it ran once."
- **Docs site: VitePress.** Public-facing docs (once there's enough API surface to document — not
  worth setting up for a single class) go in a VitePress site, not scattered markdown. Tracked
  under Phase 11 below; don't start it prematurely while the API is still churning weekly.
- **A real typed IPC layer, not more ad-hoc bridges.** Phase 2 built `window.__bunium.reportBounds()`
  as a one-off `CefProcessMessage` bridge for a single purpose (bounds sync). That was the right
  call for proving the mechanism, but it does not generalize — every future feature needing
  renderer↔main communication (draggable regions, `<bunium-webview>` control messages, future
  Phase 5 system APIs like menu click callbacks) would otherwise grow its own bespoke
  `CefV8Handler`/`CefProcessMessage` pair. Before Phase 2's DOM-tracking work goes much further
  (draggable regions especially, which the Phase 1 window-options entry above already flagged as
  wanting to reuse "the same IPC bridge"), design one typed IPC primitive: message names and
  payload shapes defined once in TS (a shared type, checked on both the "send" and "handle" side
  at compile time — e.g. a discriminated union of message types), with a single generic
  `CefProcessMessage` transport underneath instead of one bespoke V8 binding per feature. Event
  listening (main → renderer push, e.g. "menu item clicked", "webview navigated") needs the same
  treatment: a typed emitter pattern, not raw `ExecuteJavaScript` string-building per callsite.
  This is infrastructure worth building once, deliberately, rather than accreting per-feature —
  don't add a 2nd bespoke bridge for draggable regions before this exists.
  **[DONE 2026-08-10]:** built as `window.__bunium.send(name, JSON.stringify(payload))` (renderer)
  → generic `CefProcessMessage` (name `bunium-send`, distinct from `reportBounds`'s own message,
  which was deliberately left untouched rather than risk regressing verified Phase 2 tests) → a
  thread-safe per-view inbox (`BuniumClient::PopMessage`, `bunium_common.h`) → drained every pump
  tick and dispatched via `BuniumWindow<M>.on(name, handler)` — the `M` generic type parameter
  (`BuniumMessageMap`) gives compile-time-typed payloads per message name, satisfying "a shared
  type checked on both sides." Verified end-to-end with ordered multi-message delivery and typed
  payloads (`examples/typed-ipc-test.ts`). **[DONE 2026-08-10] Native → renderer push also
  built:** `BuniumWindow<M>.emit(name, payload)` → `CefProcessMessage` (PID_RENDERER) →
  `BuniumApp::OnProcessMessageReceived` (renderer side) looks up the target frame's `CefV8Context`
  (tracked per-frame in `OnContextCreated`/`OnContextReleased`) and calls
  `window.__bunium.__dispatch(name, payload)` directly, which fans out to whatever
  `window.__bunium.on(name, handler)` listeners the page registered (pure JS, injected once via
  `CefFrame::ExecuteJavaScript` in `OnContextCreated` alongside the native `reportBounds`/`send`
  functions). Verified end-to-end via DOM/pixel-color change
  (`examples/typed-ipc-emit-test.ts`). The typed IPC layer is now genuinely bidirectional —
  renderer↔main, both directions typed via the same `BuniumMessageMap` generic.
  **Real bug caught and fixed along the way:** `FFIType.cstring` in `bun:ffi` returns a truthy
  `CString` _object_ wrapper even when the underlying native pointer is `NULL` (objects are always
  truthy in JS, regardless of what they stringify to) — a `for(;;) { if (!x) break; }` drain loop
  using it never terminates. Switched to `FFIType.ptr` + explicit `=== null` check + manual
  `new CString(ptr)` construction, the same pattern `bunium_get_frame` already used. Worth
  remembering for any future nullable-string-returning ABI function — don't use `FFIType.cstring`
  for anything that can return `NULL`.
- **Native OS color scheme (light/dark) support, like a real browser.** Pages loaded in bunium
  should see `prefers-color-scheme` match the actual OS appearance and update live when the user
  toggles it — the same behavior Safari/Chrome give web pages. Chromium/CEF doesn't necessarily
  pick this up automatically in an embedded/OSR context the way it does when run as a normal
  browser process; needs verification (does `NSApp.effectiveAppearance` need to be read and
  pushed into Chromium's color-scheme preference explicitly, and does it need
  `NSApp`/`NSAppearance` change notifications forwarded on toggle?). Tracked as a concrete Phase 1
  window-level feature, not deferred to later — see below.
- **Keep writing/updating Claude Code skill files as features land**, not just at big milestones.
  `.claude/skills/bunium-dev/SKILL.md` exists; extend it (or add feature-specific skills once a
  subsystem is big enough to warrant its own, e.g. a packaging-specific skill once Phase 8 starts)
  as the codebase grows, so future sessions resume with accurate guidance rather than a skill file
  that's drifted from what the code actually does.
- **No native ABI function may take more than 8 arguments.** Found empirically while building
  resizable/min-max window options: a 10-arg function had its 10th argument silently arrive as
  `0` on the native side, consistent with a `bun:ffi` bug/limitation in arm64 stack-argument
  passing (first 8 args go in registers, the rest spill to the stack). Not filed/confirmed
  upstream, but methodically isolated (JS-side value confirmed correct, every native signature
  confirmed matching, only the 9th+ argument corrupted) — treat as real. Split any function
  needing more inputs into multiple ≤8-arg calls (as done for window creation vs. constraints),
  or pack values into a buffer passed via `FFIType.ptr` if splitting doesn't fit naturally. See
  `ARCHITECTURE.md` §18.

## Phase 0 — Feasibility POC (DONE)

- [x] Confirm CEF exports pure C API directly (`nm -gU`)
- [x] Confirm `bun:ffi` can `dlopen` the CEF framework bundle
- [x] Build `libcef_dll_wrapper` via CMake
- [x] Write C++ shim (flat C ABI) + subprocess executable, compile clean
- [x] Full pipeline smoke test: init → create view → load page → paint (exit 0)
- [x] Capture `OnPaint` buffer → PNG, visually confirm pixel-correct render
- [x] Scroll timing smoke test (~17ms inter-frame gap while content changes)
- [x] Resolved: GPU compositing measurably _slower_ than software OSR for this workload (~34ms
      vs ~22ms avg frame gap, reproduced twice) — likely GPU→CPU readback overhead inherent to
      the current `OnPaint`-based OSR path. `--disable-gpu`/`--disable-gpu-compositing` now
      shim defaults. Real GPU-accelerated shared-texture OSR (`OnAcceleratedPaint`) is a
      different, faster path not yet implemented — see `ARCHITECTURE.md` §6.

Artifacts: `poc/shim/*.{h,cpp}`, compiled `.dylib`/executable, `test_shim.ts`, `test_scroll.ts`,
`frame.png`. All macOS arm64 only.

## Phase 1 — Real runtime skeleton (macOS first)

Goal: replace the throwaway test scripts with an actual `bunium` package structure. A real
`NSWindow`, CEF OSR painted into it via a Metal/CoreAnimation layer (not just captured to a
buffer and discarded), basic main-process JS API (`BuniumWindow`, `loadURL`, lifecycle events).
This is where the shim graduates from POC code to library code.

**Progress (2026-08-10):**

- [x] Confirmed a bare `bun`-loaded dylib can create/show a real `NSWindow` (no `.app` bundle
      needed) via `NSApplication` + non-blocking event pump (`test_window.mm`/`.ts`) — verified
      visually via screenshot.
- [x] Wired `BuniumClient::OnPaint` to push frames into the window's `CALayer` via `CGImageCreate`
      (`bunium_window_mac.mm`, new ABI: `bunium_create_native_window` /
      `bunium_attach_window` / `bunium_pump_native_events` / `bunium_window_get_id` /
      `bunium_close_native_window`).
- [x] Fixed a real bug caught mid-session: `CGDataProviderCreateWithData` was referencing CEF's
      `OnPaint` buffer directly instead of copying it — CG can read asynchronously after CEF
      reuses/frees that memory. Now copies + frees via a `CGDataProviderReleaseDataCallback`. See
      `ARCHITECTURE.md` §8.
- [x] Combined pump loop (CEF message loop + Cocoa event pump) runs 6s, no crash, clean exit.
- [x] **Visual confirmation — resolved by the Phase 8 fixture verifier (2026-08-17); the
      sandbox screenshot gap from Phase 1 no longer matters.** `packaging/mac/fixture-app`
      now pixel-verifies a real page render in the packaged app (polls OnPaint pixels for
      the expected color, exit 0=PASS), and the `[paint]` markers under
      `BUNIUM_CEF_VERBOSE=1` confirm frames reach the screen in every example run. The
      old `poc/test_live_window.ts` path is superseded.
- [x] Task #7 resolved: software OSR is now the deliberate default (measurably faster than
      GPU-composited OSR for this workload, see `ARCHITECTURE.md` §6), not a fallback we're
      stuck with.
- [x] `CGImageCreate`-per-frame replaced with `CAMetalLayer` + `MTLTexture.replaceRegion`
      presentation (CPU rasterization unchanged -- Metal is presentation-only here, not a second
      attempt at GPU-composited OSR). Measured improvement: avg inter-frame gap dropped from
      ~22ms to ~17.4ms, reproduced twice, no regressions in any other example. Also fixed a
      latent use-after-free risk as a side effect: `replaceRegion` copies synchronously, unlike
      the old `CGDataProviderCreateWithData` path (see `ARCHITECTURE.md` §8).
      True zero-copy accelerated OSR (`OnAcceleratedPaint`/IOSurface) remains Phase 2 scope --
      tangled up with the windowed-vs-OSR compositor decision, not worth doing speculatively
      now.
- [x] Real package structure: `native/mac/` (canonical shim source, `build.sh`),
      `vendor/cef-macosarm64/` (CEF distribution, moved out of `poc/`), `src/` (`native.ts`,
      `app.ts`, `window.ts`, `index.ts`), `package.json`. `poc/` is now historical reference only.
- [x] Real `BuniumWindow` JS API: `new BuniumWindow({ url, width, height, title })`,
      `.frameCount`, `.resize()`, `.close()`, `app.init()`/`app.shutdown()` singleton owning the
      CEF+Cocoa pump loop. Verified end-to-end via `examples/basic-window.ts` (exit 0, frames
      painted).
- [x] `.loadURL()` after construction (`bunium_navigate` ABI, `CefFrame::LoadURL`), verified
      navigating away from initial URL produces new painted frames
      (`examples/loadurl-test.ts`).
- [x] `tsconfig.json` strict mode + `bun run typecheck` (`tsc --noEmit`), passes clean as of this
      point in the project. Keep it that way per the standing cross-cutting requirement.
- [x] Resize-on-OS-window-resize wiring: `bunium_window_get_size` ABI polled every pump tick per
      registered window (`app.ts` `TrackedWindow`/`registerWindow`/`pollWindowSizes`), forwards to
      `BuniumWindow.onNativeResize` → existing `resize()` path. ABI plumbing exercised
      crash-free across ~100 ticks; actually dragging a window edge to see it live needs a real
      desktop (same category as the earlier CALayer visual-confirmation gap).
- [x] Close events: `NSWindowDelegate.windowWillClose:` flips an atomic flag on
      `BuniumWindowHandle`, polled via `bunium_is_native_window_closed` each pump tick
      alongside the size poll. `BuniumWindow.onClose(listener)` fires on both user-initiated
      (red button) and programmatic `.close()`. Double-close is a safe no-op. Verified
      programmatic path + listener firing + double-close in `examples/close-event-test.ts`;
      actually clicking the red button needs a real desktop to confirm (same category as
      earlier visual-confirmation gaps).
- [x] **Fixed real Retina blur bug**, reported by the user: CEF was rasterizing at 1.0 device
      scale factor unconditionally (never told otherwise), then that 1x buffer got upscaled onto
      a physically-2x `CAMetalLayer` — textbook blur. Fixed via `CefRenderHandler::GetScreenInfo`
      reporting the real scale (`BuniumClient::SetDeviceScaleFactor`, called from
      `bunium_attach_window` using a new `bunium_window_get_scale`/`bunium_get_native_window_scale`
      ABI reading `NSWindow.backingScaleFactor`). Verified: a 400×300 logical window now produces
      an 800×600 physical paint buffer (exact 2.00x) instead of a 400×300 buffer stretched onto a
      2x layer. New public API: `BuniumWindow.innerSize` (logical), `.renderedSize` (physical),
      `.devicePixelRatio`, `.captureScreenshot()` (raw BGRA, no bundled PNG encoder — intentional,
      keep the framework lean and let consumers pick an image lib).
      **Explicitly scoped out for now, tracked as future work:** DPR override (rendering at a
      different scale than the display, e.g. for a fixed-resolution screenshot), and video
      recording (would sequence `captureScreenshot()`'s same buffer-read primitive over time — no
      encoding pipeline built).
- [x] **Found and fixed a real, separate bug while testing the above — root cause confirmed:
      yabai.** Freshly-created resizable windows were observed getting resized by something
      _outside_ bunium's own code (confirmed via a bare Cocoa window with zero CEF involvement,
      ~150-250ms after creation). The user runs yabai (tiling WM); yabai auto-tiles new windows
      into its layout grid, matching exactly what was observed. Fixed at the yabai level with
      `yabai -m rule --add app="^bun$" manage=off` (verified: window stayed exactly the requested
      size afterward) — not persisted automatically since the user's yabai config location wasn't
      known and guessing wrong risked corrupting an unrelated file; the user needs to add that
      rule to their own config for it to survive a yabai restart. Separately, kept the
      `BuniumApp.RESIZE_SETTLE_MS` (1000ms) guard in `app.ts` regardless — other users may run
      different tiling WMs (Amethyst, Rectangle, AeroSpace) bunium can't special-case one by one,
      so not blindly trusting an OS-reported resize in the first second after window creation is
      good hardening on its own merits, not just a yabai workaround. See `ARCHITECTURE.md` §14.
- [x] **`transparent` and `frame: false` window options — built and verified.**
      `transparent`: `window.opaque = NO` + `clearColor` background + `CAMetalLayer.opaque = NO` + `CefBrowserSettings.background_color` alpha=0 (CEF's documented switch for enabling
      transparent painting on windowless browsers — it's binary, not a general translucency
      slider). Verified precisely: a page painting an opaque red square in one corner and
      nothing elsewhere produced alpha=255 at the square and alpha=0 everywhere else, read back
      via `captureScreenshot()` (`examples/transparent-window-test.ts`).
      `frame: false`: `NSWindowStyleMaskBorderless` instead of `Titled`. Verified crash-free with
      the view still painting correctly (`examples/frameless-window-test.ts`) — actually seeing
      the title bar gone needs a real desktop, same category as other Cocoa-visual gaps.
      Changing `bunium_create_view`/`bunium_create_native_window`'s native signatures required
      updating every raw-FFI example script directly calling them (7 files) — caught during
      regression testing, not left broken.
- [x] **Draggable regions — built with full Electron-compatible auto-detection, not a
      manual-reporting API.** CSS `-webkit-app-region: drag` (same property Electron uses) is
      scanned automatically: a script injected into every page (alongside the `on`/`send`
      bootstrap) queries all elements' computed style, finds matches, reports their
      `getBoundingClientRect()`-shaped rects via the typed IPC layer's transport
      (`window.__bunium.send('__bunium_drag_regions', ...)`, a reserved name `BuniumWindow`
      intercepts before the typed `.on()` dispatch — not something app code sees). Re-scans on
      `load`, `resize`, and DOM mutation (via `MutationObserver`, debounced to one scan per
      animation frame). Native: `BuniumClient` stores the regions, `BuniumContentView`'s
      `mouseDown:` checks draggability _before_ forwarding to CEF — a hit calls
      `performWindowDragWithEvent:` and skips CEF dispatch entirely (known v1 limitation: the
      whole region is non-interactive, no Electron-style `app-region: no-drag` override for
      buttons inside a drag region yet).
      Verified precisely: a synthetic titlebar strip's exact rect was detected, and
      `bunium_is_window_point_draggable` correctly matched inside/outside points
      (`examples/draggable-regions-test.ts`). Actually dragging the window via a real OS mouse
      gesture is untestable here — same category as other Cocoa-interactive gaps, and notably
      _worse_ than most: even the raw-FFI dispatch trick used for click/keyboard verification
      doesn't reach this code path, since the drag check lives in the real Cocoa `mouseDown:`
      handler, not in the dispatch function tests call directly.
      **Two real bugs caught and fixed while building this:** (1) the injected script tried to
      `MutationObserver.observe(document.documentElement, ...)` before `documentElement` existed
      (V8 context is created before the DOM is parsed) — deferred to `DOMContentLoaded`. (2)
      `CefDictionaryValue::GetDouble()` silently returns `0`, not an auto-converted value, when a
      JSON number was parsed as `VTYPE_INT` rather than `VTYPE_DOUBLE` — whole numbers like `400`
      or `0` (which `getBoundingClientRect()` produces constantly) hit this. A type-checking
      `GetJsonNumber()` helper fixes it; **any future CEF JSON-dictionary numeric read should use
      it, not raw `GetDouble()`.**
- [x] **Custom resize-bar hit-testing for `frame: false` (borderless) windows.** AppKit gives
      free edge-drag resizing to _titled_ windows via `NSThemeFrame`, but a borderless window
      (`NSWindowStyleMaskBorderless`) loses it entirely even with `NSWindowStyleMaskResizable`
      set -- there's no chrome for the window manager to track. Replicated manually in
      `BuniumContentView`'s `mouseDown:`/`mouseDragged:`/`mouseUp:` (`native/mac/bunium_window_mac.mm`):
      a new `ResizeEdgeAtPoint` hit-tests a 6px border on each edge of the content view (in its
      flipped, top-left-origin space, same convention the rest of the mouse dispatch code uses),
      and `ApplyResizeDelta` computes the new window frame from the screen-space mouse delta since
      drag start, clamped to `contentMinSize`/`contentMaxSize` with the _opposite_ edge always
      anchored (only the dragged edge's origin compensates when a clamp kicks in). Gated on two
      conditions checked via `styleMask` at the top of `mouseDown:` (`shouldUseSyntheticResizeEdges`):
      window must be borderless (`frame:false`) _and_ resizable (`resizable:true`, the default) --
      titled windows and non-resizable frameless windows are completely unaffected, zero regression
      risk. Resize-edge detection takes priority over draggable-region dragging in `mouseDown:`
      (the border is a thin strip that can overlap a full-width custom titlebar drag region;
      grabbing right at the physical window edge should always mean "resize", matching how native
      titled windows also let the resize border win over the draggable titlebar beneath it). No
      new native ABI/FFI surface needed -- this is pure Cocoa-internal `.mm` code, nothing crosses
      into JS.
      **Verified:** `examples/frameless-resize-test.ts` confirms `frame:false` + `resizable:true`,
      `frame:false` + `resizable:false`, and `frame:true` windows all create/paint/close cleanly
      with the new styleMask-gated code path present (i.e. `shouldUseSyntheticResizeEdges` doesn't
      crash for any of the three configs). Regression-tested against
      `examples/draggable-regions-test.ts` and `examples/resizable-constraints-test.ts` -- both
      still pass unchanged.
      **Known gap, same category as draggable-region hit-testing above (arguably worse):** the
      resize-edge check lives inside the real Cocoa `mouseDown:`/`mouseDragged:` handlers, which
      aren't reachable through the raw-FFI dispatch trick used for click/keyboard verification
      (that trick calls `bunium_dispatch_mouse_click` directly, bypassing `mouseDown:` entirely --
      exactly the code path that needs testing here). Confirming the resize actually happens
      visually when a user drags a real mouse at a real window edge needs a real desktop session;
      not verifiable in this sandboxed environment. No cursor change (`NSCursor` resize cursors) on
      hover yet either -- nice-to-have for matching native resize-bar UX, not required for the
      feature to function.
- [x] **Native OS color scheme sync (light/dark) — already works, zero code needed.** Tested
      before building anything: a page using `@media (prefers-color-scheme: dark)` correctly
      resolved to dark while the OS was in Dark mode at window creation
      (`examples/color-scheme-test.ts`), AND updated live in an already-open window (no
      reload/recreate) when the OS was toggled from light to dark mid-session
      (`examples/color-scheme-live-test.ts`, self-contained — forces a deterministic
      light→dark transition and restores whatever the OS was originally set to). Chromium's
      `NativeTheme` apparently syncs automatically with the real `NSApplication` bunium already
      runs — no `NSApp.effectiveAppearance` reading or forwarding needed. Good example of
      checking before building: this looked like real work and turned out to be already solved
      by running a proper `NSApplication` in the first place.

## Phase 2 — DOM-integrated `<webview>` tag (hardest, highest-risk phase)

Goal: the actual "acts like a real DOM element, buttery smooth" requirement. Compositor strategy
decided by the (now-resolved) GPU-backend finding: OSR composited into native `CAMetalLayer`
sublayers, not windowed child views (which is what makes Electron's own `<webview>` janky).

**Progress (2026-08-10):**

- [x] Proved the mechanical core: two independent CEF views (separate renderer processes) can
      composite as sibling `CAMetalLayer`s inside one native window, positioned via
      `bunium_create_sublayer`/`bunium_sublayer_set_frame`. No JS/DOM involvement yet — the
      sublayer's position was hardcoded in a test script. See `examples/multi-layer-test.ts`,
      new ABI in `native/mac/bunium_window_mac.mm` (`bunium_create_sublayer`,
      `bunium_sublayer_set_frame`, `bunium_close_sublayer`) and `bunium_shim.cpp` passthrough.
      Not yet public `src/` API — this is native-layer plumbing only.

- [x] **The IPC bridge itself, working end-to-end and verified with real value matching (not
      just no-crash):** `window.__bunium.reportBounds(x, y, w, h)` injected into every page via
      `CefRenderProcessHandler::OnContextCreated` + a `CefV8Handler`
      (`BuniumV8Handler::Execute`), sends a raw `CefProcessMessage` (chosen over
      `CefMessageRouter` — one-way fire-and-forget fits a per-frame push better than
      request/response) to the browser process, where `BuniumClient::OnProcessMessageReceived`
      forwards it to a tracked sublayer via `bunium_sublayer_set_frame`. New ABI:
      `bunium_view_track_sublayer`, `bunium_get_native_sublayer_frame` (readback, verification
      only). Proven in `examples/ipc-bounds-test.ts`: called `reportBounds(200, 120, 300, 180)`
      from renderer JS, read back the exact same 4 values from the native sublayer.

**Next, not started:**

- The test above calls `reportBounds` once with hardcoded numbers — no real
  `getBoundingClientRect()`/`ResizeObserver`/`requestAnimationFrame` loop tracking an actual DOM
  element yet, and no `<bunium-webview>` custom element registering itself automatically.
- [x] **Latency measured, initially looked bad (~140-200ms), turned out to be a measurement bug,
      real number is good.** First test conflated one-time page-startup latency with per-frame
      lag (constant offset math produces a fake "constant lag" that looks like a real problem —
      see `ARCHITECTURE.md` §10 for the full explanation). Added `OnConsoleMessage` forwarding
      (page `console.log` → our stderr, previously silently lost, kept permanently) to diagnose,
      found rAF itself jitter-free at ~16.35ms avg, which didn't fit the throttling theory. Fixed
      the test to fit a regression instead of trusting an assumed T0: real steady-state jitter is
      **~4.5ms avg, ~12-16ms max** — comfortably inside a 60Hz frame budget. `WasHidden(false)`
      was also added (harmless, possibly still correct to have even though it wasn't the fix).
      Still unproven: real user input (not synthetic rAF animation), visual on-screen
      confirmation, `ResizeObserver`/scroll-triggered updates (only rAF-triggered tested).
- [x] Mouse click/move forwarding to the **primary** view: custom `BuniumContentView` (NSView
      subclass, `isFlipped=YES` to match CEF's top-left origin directly) overrides
      `mouseDown:`/`mouseUp:`/`rightMouseDown:`/`rightMouseUp:`/`mouseMoved:`/`mouseDragged:`,
      forwards via new ABI `bunium_dispatch_mouse_click`/`bunium_dispatch_mouse_move` to
      whichever `CefBrowser` is attached to the window (reverse-lookup map in `bunium_shim.cpp`).
      Verified real click delivery end-to-end: dispatched a synthetic click via the ABI directly
      (not a real OS click — untestable in this sandboxed environment, same category as other
      visual gaps), page's `onclick` handler fired, background color changed red→green,
      confirmed via exact pixel readback (`examples/mouse-click-test.ts`).
- [x] Keyboard forwarding: `keyDown:`/`keyUp:` on `BuniumContentView` → `bunium_dispatch_key_event`
      → `CefBrowserHost::SendKeyEvent` (RAWKEYDOWN + CHAR + KEYUP). Known simplification: macOS
      `NSEvent.keyCode` used directly as both `windows_key_code`/`native_key_code` rather than a
      real Windows-VK mapping table -- fine for basic typing, not for full correctness, and no
      IME/composition support (`NSTextInputClient`, unimplemented). Verified end-to-end: dispatched
      a synthetic 'A' keypress via the ABI, a page's `keypress` listener fired, background color
      changed red→green, confirmed via pixel readback (`examples/keyboard-test.ts`).
- [x] **Sublayer hit-testing — the actual "webview receives its own input" requirement.**
      `bunium_dispatch_mouse_click`/`_move` now hit-test registered sublayers (topmost
      last-inserted first, `g_window_sublayers` registry in `bunium_shim.cpp`) before falling back
      to the window's primary view, converting window-local coordinates to sublayer-local before
      forwarding. Keyboard events route via `g_last_focused_target` ("whichever view most recently
      received a click" -- not a full focus-manager, but covers the common case). Verified with two
      independently clickable pages (outer view + a positioned sublayer): a click inside the
      sublayer's rect flipped only the _inner_ view's color, a click outside flipped only the
      _outer_ view's, both confirmed via independent pixel readback per view
      (`examples/sublayer-hit-test.ts`). Also fixed a real bug caught while wiring this up: closing
      a sublayer left a dangling pointer in the hit-test registry, a future click would have
      `bunium_sublayer_get_frame`'d freed memory -- now cleaned up in `bunium_close_native_sublayer`.
- [x] **Clipping: `overflow: hidden`/`auto`/`scroll` ancestor clipping for `<bunium-webview>`
      sublayers — built and verified.** A sublayer positioned under a DOM ancestor with
      non-`visible` overflow now actually gets visually clipped to match, the same as a real child
      element would. Two-part implementation: (1) **JS side** (`_syncClip`, `WEBVIEW_ELEMENT_JS`
      macro in `bunium_common.h`, called from `_sync()` alongside the existing bounds-tracking
      logic): walks `parentElement` upward from the element to (not including) `<body>`/
      `<html>` — the window itself is already the outermost clip and needs no native clip layer
      for it — checking `getComputedStyle(node).overflowX/overflowY !== 'visible'` on each
      (either axis, matching real DOM clipping semantics, not just literal `overflow: hidden`),
      intersecting each qualifying ancestor's `getBoundingClientRect()` into a running clip rect.
      Sends `__bunium_webview_clip` (a 5th reserved message name, same generic
      `window.__bunium.send()` channel as the other 4) with `{clipped: true, x, y, width, height}`
      only when the intersection actually shrinks the element's own rect, or `{clipped: false}`
      when no clipping ancestor applies (or the element already fits fully inside every one) --
      diffed against the last-sent payload the same way `_sync()` already diffs bounds updates,
      so steady state costs nothing. (2) **Native side**
      (`bunium_sublayer_set_clip`/`bunium_sublayer_clear_clip`, `bunium_window_mac.mm`, exposed via
      `bunium_set_native_sublayer_clip`/`bunium_clear_native_sublayer_clip` in `bunium_shim.cpp` and
      `src/native.ts`, driven by `WebviewManager.updateClip` in `window.ts`): lazily reparents the
      sublayer's `CAMetalLayer` under a new invisible masking `CALayer` (`masksToBounds = YES`)
      sized to the clip rect, added as a sibling in the sublayer's original host layer -- the CEF
      content itself is never re-rasterized or resized by this, only what's visually on-screen
      changes, exactly matching how a real overflow-clipped child works. `BuniumWindowHandle`
      gained `hostLayer`/`clipLayer`/`absFrame` fields to support this: `absFrame` is the
      sublayer's true window-relative frame regardless of clip state (needed because `layer.frame`
      itself becomes clip-relative once a clip is active) -- a new `BuniumSublayerReposition`
      helper re-derives `layer.frame` from `absFrame` + the active clip any time either changes,
      so bounds updates and clip updates can't fight over which one owns `layer.frame`.
      **Real bug caught and fixed while building this:** `bunium_sublayer_get_frame` (used by both
      `HitTestSublayer`'s hot path and JS verification reads) originally read `h->layer.frame`
      directly -- correct before this feature, but wrong once a clip is active, since `layer.frame`
      is then relative to `clipLayer`'s origin, not the window. Fixed to return `absFrame` instead
      whenever the handle is a sublayer (`h->hostLayer` set) -- window handles still read
      `layer.frame` directly since they never clip. Left uncaught, this would have silently broken
      hit-testing coordinates for any clipped sublayer.
      **Verified** with `examples/webview-clip-test.ts`: an element placed inside a 150×150
      `overflow: hidden` container, positioned so only its left portion overlaps the container,
      correctly computes and applies a native clip whose visible rect is the exact geometric
      intersection (verified via a new test-only readback, `bunium_sublayer_get_clip`/
      `bunium_get_native_sublayer_clip`); a second, unrelated element outside any clipping ancestor
      correctly has no active clip. Regression-tested against `examples/webview-element-test.ts`,
      `examples/webview-hit-test.ts`, `examples/sublayer-hit-test.ts`, and
      `examples/ipc-bounds-test.ts` -- all still pass, confirming the `bunium_sublayer_get_frame`
      fix didn't change behavior for the (much more common) unclipped case. As with the earlier
      `WEBVIEW_ELEMENT_JS` bug, the new macro content was verified to parse as valid JS via
      string-literal extraction _before_ trusting the native build, then re-confirmed end-to-end by
      actually running the example and checking for `[console]`-forwarded syntax errors -- none
      appeared.
      **Also fixed as a natural byproduct:** `bunium_close_sublayer` now also removes a live
      `clipLayer` if one exists (previously would have leaked an orphaned empty `CALayer` still
      attached to the host on every clipped element's teardown).
      **Still not started (at time of writing):** stacking/z-order between sibling sublayers;
      clip-aware hit-testing (see next item below, now done); border-radius/CSS `clip-path` on a
      clipping ancestor (only its rectangular bounding box is used, not its actual visual shape).

- [x] **Clip-aware hit-testing -- closes the gap left by the clipping feature above.**
      Once a `<bunium-webview>` sublayer could be visually clipped by an `overflow: hidden`
      ancestor, `HitTestSublayer` in `bunium_shim.cpp` was still purely rect-based against the
      sublayer's _nominal_ (unclipped) frame -- a click landing in the clipped-away portion of a
      sublayer's rect still registered as "inside" and routed to that sublayer, which is wrong: it
      should fall through to whatever's visually underneath, matching real DOM behavior.
      **Mechanism:** `HitTestSublayer` still iterates candidate sublayers topmost-first (reverse
      insertion order, unchanged), but for each candidate it now also calls
      `bunium_sublayer_get_clip`; if the sublayer currently has an active clip, the hit-test
      boundary check uses the clipped/visible rect instead of the nominal frame. Critically, once a
      point is confirmed inside the (possibly-clipped) bounds, the local coordinates handed to CEF
      are still computed relative to the sublayer's _true unclipped origin_ (re-fetched via
      `bunium_sublayer_get_frame`) -- only the hit-test boundary check needed clip-awareness, CEF's
      own view coordinate space is unaffected by the native clip and still expects
      unclipped-relative coordinates.
      **Verified** with a new `examples/webview-clip-hit-test.ts`: a `<bunium-webview>` positioned
      so its nominal rect straddles the edge of an `overflow: hidden` ancestor, leaving part of the
      element clipped away. A synthetic click inside the clipped-away portion of the nominal rect
      correctly falls through to the outer page (confirmed via pixel readback -- webview
      untouched); a synthetic click inside the still-visible portion correctly reaches the webview
      normally (sanity control). Regression-tested against `examples/sublayer-hit-test.ts`,
      `examples/webview-element-test.ts`, `examples/webview-hit-test.ts`,
      `examples/webview-clip-test.ts`, `examples/draggable-regions-test.ts`,
      `examples/resizable-constraints-test.ts`, `examples/frameless-resize-test.ts`, and
      `examples/ipc-bounds-test.ts` -- all still pass. `bunx tsc --noEmit` clean (this was a
      native-only change, no `src/` or injected-JS bootstrap edits required).
      **Still not started:** stacking/z-order between sibling sublayers (see next item below, now
      done); border-radius/CSS `clip-path` on a clipping ancestor (only its rectangular bounding
      box is used, not its actual visual shape).

- [x] **Stacking/z-order sync between sibling `<bunium-webview>` elements.**
      Before this, `g_window_sublayers` (`bunium_shim.cpp`) ordered sublayers purely by creation
      order (CALayer's own `addSublayer:` insertion order at `bunium_create_native_sublayer` time)
      -- both for visual paint order and for `HitTestSublayer`'s topmost-first hit-testing. Nothing
      synced that to a `<bunium-webview>` element's actual DOM/CSS stacking position, so two
      overlapping elements with CSS `z-index` set would paint and hit-test in creation order
      regardless of which one was actually supposed to be "on top" -- wrong for any app embedding
      more than one webview with overlapping bounds.
      **Mechanism:** rather than tracking a full ordered index, a single `bunium_sublayer_raise_to_top`
      primitive was added (`bunium_window_mac.mm`) that moves one sublayer's `CALayer` (or its
      `clipLayer`, if clipping is active -- raising `clipLayer` itself, since `layer`'s position
      _within_ `clipLayer` is irrelevant once it's `clipLayer`'s only child) to the end of its
      superlayer's sublayers array via `removeFromSuperlayer` + `addSublayer:`. A new
      `bunium_raise_native_sublayer(window_handle, layer_handle)` (`bunium_shim.cpp`) calls that and
      _also_ moves the same handle to the back of `g_window_sublayers`' vector for that window, so
      the hit-test registry and the visual paint order can never drift apart. Calling this once per
      element, in ascending desired stacking order (bottom element first), reproduces the full
      requested order using only "raise to top" as a primitive -- no separate "insert at index"
      needed.
      **JS side:** a new `BuniumWebview._syncOrder()` static method (`WEBVIEW_ELEMENT_JS`,
      `bunium_common.h`) recomputes the full ascending stacking order from scratch on every `_sync()`
      tick of _any_ connected element (not just its own) -- `document.querySelectorAll('bunium-webview')`,
      filtered to already-`_created` elements, sorted by `getComputedStyle(el).zIndex` (numeric,
      `NaN`/`auto` treated as `0`, so unset `z-index` falls back to DOM/creation order via `Array.sort`'s
      stability). Diffed against `BuniumWebview._lastOrder` (a class-level, not instance-level, field --
      shared across all elements) and only sent as the new reserved message `__bunium_webview_order`
      (`{order: [id, id, ...]}`) when it actually changed, same cheap-steady-state pattern as bounds/clip
      diffing. Also invoked once from `disconnectedCallback` (element removed -- order needs recomputing
      even though the removed element itself won't tick again) and once right after a new element's own
      `create` message (so a freshly-added element gets folded into the order immediately, not after its
      next tick).
      **Deliberate approximation:** true CSS stacking-context semantics (stacking contexts nest,
      `z-index` only compares siblings _within_ the same stacking context, `position` /
      `isolation` / `opacity<1` / etc. can all create new stacking contexts) are not reproduced --
      `_syncOrder` treats every connected `<bunium-webview>` in the whole document as one flat list
      sorted by raw `z-index` value. This matches Electron's own documented behavior for its
      `<webview>` tag (also flat, not stacking-context-aware) and covers the common case (a handful
      of possibly-overlapping embedded webviews on one page) without the complexity of a full
      stacking-context tree walk; documented here as a known simplification rather than a bug.
      **`src/window.ts`:** new `WEBVIEW_ORDER_MESSAGE_NAME` constant, `WebviewOrderPayload` type,
      `WebviewManager.updateOrder()` (calls `bunium_raise_native_sublayer` once per id in the given
      order, skipping any id not currently tracked -- e.g. one just destroyed, racing this message),
      wired into the `pollMessages()` reserved-message dispatch alongside the existing
      create/bounds/navigate/destroy/clip messages.
      **Verified** with a new `examples/webview-stacking-test.ts`: two fully-overlapping
      `<bunium-webview>` elements (`z-index: 1` and `z-index: 2`), a click at their shared center
      correctly reaches only the `z-index: 2` element (confirmed via independent pixel readback per
      view -- the other stays untouched). The lower element's `z-index` is then raised above the
      other's at runtime (via `win.emit()` -> a small injected page-side listener -> a style change,
      exercising the full `_syncOrder` -> IPC -> `bunium_raise_native_sublayer` round-trip after
      initial creation, not just at creation time), and a second click at the same point now
      correctly reaches the newly-topmost (formerly bottom) element instead. Regression-tested
      against `examples/sublayer-hit-test.ts`, `examples/webview-element-test.ts`,
      `examples/webview-hit-test.ts`, `examples/webview-clip-test.ts`,
      `examples/webview-clip-hit-test.ts`, `examples/draggable-regions-test.ts`,
      `examples/resizable-constraints-test.ts`, `examples/frameless-resize-test.ts`, and
      `examples/ipc-bounds-test.ts` -- all still pass. `bunx tsc --noEmit` clean. As with prior
      injected-JS bootstrap edits, the new `WEBVIEW_ELEMENT_JS` macro content was verified to parse
      as valid JS (string-literal extraction piped into `new Function(src)`) _before_ trusting the
      native build, then re-confirmed end-to-end by actually running the example.
      **Still not started:** border-radius/CSS `clip-path` on a clipping ancestor (only its
      rectangular bounding box is used, not its actual visual shape); true nested stacking-context
      semantics (see "Deliberate approximation" above).

All of the above brings the standing "Still not started" line from earlier progress notes fully
current -- clipping, clip-aware hit-testing, and stacking/z-order sync are all done;
border-radius/clip-path shape support (and full stacking-context semantics, a much larger and
lower-priority undertaking) remain open, tracked above.

- [x] **`<bunium-webview>` custom element — built, the actual headline Phase 2 deliverable.**
      App code just writes `<bunium-webview src="...">` in HTML, no manual bounds-reporting API.
      Implemented as a real `customElements.define('bunium-webview', ...)` injected once per page
      (`WEBVIEW_ELEMENT_JS` macro, `bunium_common.h`, appended into the same `ExecuteJavaScript`
      bootstrap call that already injects `reportBounds`/`send`/`on`/drag-region scanning — one
      injection point, not a second one). Position tracking uses a `requestAnimationFrame` loop
      reading `getBoundingClientRect()` every frame (not just `ResizeObserver`, which misses
      scroll/reflow-driven moves without a size change), sending an update only when the rounded
      rect actually changed. Reuses the existing generic `window.__bunium.send()` channel — 4
      reserved message names (`__bunium_webview_create/_bounds/_navigate/_destroy`), no new native
      ABI or `CefProcessMessage` type needed, consistent with the standing typed-IPC-layer
      requirement (don't add a bespoke bridge per feature). New `src/` class `WebviewManager`
      (`window.ts`, private to `BuniumWindow`) owns one `bunium_create_native_sublayer` +
      `bunium_create_view` + `bunium_attach_window` triple per live element, keyed by the
      per-element id the injected element generates; `updateBounds` drives
      `bunium_set_native_sublayer_frame` + `bunium_resize`, `navigate` drives `bunium_navigate`,
      `destroy`/`destroyAll` tear down via `bunium_close_view` + `bunium_close_native_sublayer`
      (the latter also called from `BuniumWindow.close()`/`onUserClosed()`, since a page's own
      `disconnectedCallback` won't fire once its own CEF view is itself being torn down). Only new
      native-side additions: `bunium_get_native_sublayer_frame`/`bunium_set_native_sublayer_frame`
      exposed through `src/native.ts` (the sublayer ABI itself already existed from the earlier
      manual-wiring work, just wasn't in the shared `lib` binding yet). Verified end-to-end,
      without any manual bounds-reporting from the test itself (unlike `ipc-bounds-test.ts`/
      `sublayer-hit-test.ts`, which wire the sublayer/view pair by hand): declaring the element in
      an outer page's HTML alone caused a real native sublayer + CEF view to be created and paint
      (`hasPixels: true`), the sublayer's frame exactly matched the element's initial
      `getBoundingClientRect()`, and an in-page style mutation (via `BuniumWindow.emit` telling the
      page to move/resize the element) live-updated the sublayer's frame to match
      (`examples/webview-element-test.ts`). Existing sublayer/IPC/drag-region examples re-run
      clean (no regressions) after this change.
      **Real bug caught and fixed while building this:** appending the `WEBVIEW_ELEMENT_JS` macro
      directly onto the tail of the existing bootstrap's last string literal silently dropped that
      literal's own closing `"});"` (which closes the `DOMContentLoaded` callback function body
      and the outer `addEventListener` call) — the whole injected bootstrap script (including
      unrelated, previously-working `reportBounds`/`send`/`on`/drag-region code) failed to parse
      as a result, breaking every page silently (only visible via `OnConsoleMessage`'s forwarded
      "Uncaught SyntaxError" — another point in favor of that Phase 1 addition being worth
      keeping). Fixed by restoring the missing closing string before the macro. Caught by actually
      running the new example rather than trusting a clean `tsc --noEmit`/native build — neither
      compiler catches C-string-literal-concatenation logic bugs like this; **always execute new
      injected-JS bootstrap changes end-to-end, don't just confirm they compile.**
      **Hit-testing/input forwarding for auto-created `<bunium-webview>` sublayers — now
      verified.** `WebviewManager.create()` calls the same `bunium_create_native_sublayer` that
      `sublayer-hit-test.ts` uses for hand-wired sublayers, which already registers into the
      `g_window_sublayers` hit-test registry generically -- no `<bunium-webview>`-specific
      hit-test code needed, it composes for free. Confirmed with `examples/webview-hit-test.ts`
      (combines the `webview-element-test.ts` pattern -- declare the element in HTML, let the rAF
      loop auto-create its sublayer/view -- with the `sublayer-hit-test.ts` pattern -- dispatch a
      synthetic click and verify by independent pixel readback per view): a click inside the live
      `<bunium-webview>`'s on-screen rect flips only the embedded page's background, a click
      outside flips only the outer page's, both directions confirmed. Required adding
      `bunium_dispatch_mouse_click` to the shared `src/native.ts` binding (previously only wired
      ad hoc in test scripts' own raw `dlopen()` calls) -- test-only in practice today since real
      clicks arrive through the native `BuniumContentView` mouse handlers, not this binding.
      **Done:** public TS-facing type for `<bunium-webview>` -- `src/webview-element.d.ts`
      declares a global `HTMLBuniumWebviewElement` (with `src`) and augments
      `HTMLElementTagNameMap`, so renderer code with DOM types gets full editor/compiler
      awareness of the tag. It references DOM types deliberately and is left out of the root
      `src/` typecheck (no DOM lib) via `skipLibCheck`; it's ambient in `src/`, so it ships
      with the package when the consumer-facing `types` wiring is set up in Phase 11. Not a
      runtime change -- the element itself was already injected into pages by WEBVIEW_ELEMENT_JS.
      (Stacking-order sync between sibling `<bunium-webview>`
      sublayers, previously listed here as open, is now done -- see the clipping/stacking
      entries above.)

## Phase 3 — Vite dev integration

Dev: `loadURL` pointing at the Vite dev server, HMR works for free since it's just a real browser
tab under the hood. Prod: load built static files via `file://` or a custom scheme handler
(custom scheme likely needed to avoid CORS/relative-path issues — check CEF's
`CefSchemeHandlerFactory`).

**Done: prod static-file serving via a custom `bunium://` scheme.** Went with a custom
scheme rather than `file://` — CEF's `CEF_SCHEME_OPTION_LOCAL` doc comment explicitly warns
"normal pages cannot link to or access local URLs," which would break ordinary relative
`<script src>`/`fetch()`/`<link>` references the way real built Vite output uses them. Instead:

- Registered `bunium` as a standard custom scheme (`OnRegisterCustomSchemes`, called in every
  CEF process per `CefApp`'s contract) with
  `CEF_SCHEME_OPTION_STANDARD | CORS_ENABLED | FETCH_ENABLED | CSP_BYPASSING` so relative
  imports, `fetch()`, and `<script type="module">` behave like a real site rather than a
  restricted local scheme.
- Registered a `CefSchemeHandlerFactory` (`BuniumSchemeHandlerFactory` in
  `native/mac/bunium_common.h`) in `OnContextInitialized` (browser-process only — needs CEF's
  IO thread, which doesn't exist yet during `OnRegisterCustomSchemes`). It resolves
  `bunium://app/<path>` against a single global root directory (`g_bunium_scheme_root`), set
  once via the new `bunium_set_app_root(root_dir_path)` ABI call — one global root, not
  per-window, matching Electron's single-app-root convention (`app.getAppPath()`-style); no
  multi-root use case yet.
- `BuniumSchemeResourceHandler` reads the requested file synchronously (`fopen`/`fread`) — fine
  for local static assets, no need for CEF's async resource-handler machinery here — resolves
  MIME type via `CefGetMimeType()` off the file extension, and 404s cleanly (not a crash) when
  the file doesn't exist. Empty/`/` paths default to `index.html`. Any path containing `..` is
  explicitly rejected as defense in depth on top of CEF's own URL-canonicalization, which
  already collapses most `..` sequences before the handler ever sees them.
- Public API: `app.setAppRoot(rootDirPath)` in `src/app.ts`, calling the new
  `bunium_set_app_root` ABI export (`src/native.ts`). Call once before any window
  `loadURL()`s a `bunium://` URL — e.g. pointed at Vite's `dist/` for a prod build.
- Verified end-to-end in `examples/scheme-handler-test.ts` via a temp directory + real
  `BuniumWindow` + pixel readback (not just "didn't crash"): `index.html` defaulting on an
  empty path, a same-directory `<script src="app.js">` relative reference actually executing
  (proves both correct path resolution and correct MIME type — some browsers refuse to execute
  a script served with the wrong content type), a 404 on a missing file completing without
  crashing, and a `../../../etc/passwd`-style traversal request completing without crashing or
  leaking files. Full existing example suite (`sublayer-hit-test`, `webview-*-test`,
  `draggable-regions-test`, `resizable-constraints-test`, `frameless-resize-test`,
  `ipc-bounds-test`) re-run after the native changes with no regressions, since
  `bunium_common.h`/`bunium_shim.cpp` are shared by every window/view.

**Done: dev half via `loadURL` against a real Vite dev server.** No new native code needed —
`loadURL` already existed, and a bunium window is a real Chromium tab, so a Vite dev server
just works the same as any other browser pointed at it, HMR included. Verified in
`examples/vite-dev-test.ts` against a real `bunx vite` dev server (not mocked), spawned as a
child process against the fixture in `examples/vite-dev-fixture/` (plain `index.html` +
`main.js` + a `vite.config.js` pinned to a fixed `strictPort` so the test can hardcode the URL
rather than scrape vite's stdout for the chosen port):

- `loadURL("http://localhost:5199/")` against the running dev server renders the page
  correctly (pixel readback confirms `main.js` executed).
- Editing `main.js` on disk while the window stays open causes the page to update in place via
  Vite's injected HMR client, with **zero further bunium-side calls** (no `loadURL`/`reload()`
  from the test script) — confirmed via a second pixel readback polling loop that only the
  on-disk edit could have triggered. (This particular edit changes top-level script statements
  Vite can't hot-swap as a pure module patch, so its client falls back to a full reload rather
  than a true in-place patch — still proves the dev-server-drives-the-page path end-to-end,
  same mechanism either way from bunium's perspective.)

With both halves done, **Phase 3 is complete**: prod apps call `app.setAppRoot()` +
`loadURL("bunium://app/")` against built static output; dev apps `loadURL()` a running Vite
dev server directly. No bunium-specific dev-server plugin or config needed for either mode.

## Phase 4 — `create-bunium-app` scaffolding (multi-framework, TS + JS)

Scaffolding CLI once Phase 1-3 APIs are stable enough to not immediately churn the templates.

**Scope (per user request 2026-08-10):** not just SolidJS — templates for **React, Solid, and
Vue**, each available in **both TypeScript and JavaScript** variants, all on **Vite**. That's up
to 6 template combinations. Practically: one shared Vite+bunium base config/plugin, with
per-framework template dirs layered on top (framework-specific dev-server glue, if any, plus the
component syntax) rather than 6 fully-independent copies — reduces the maintenance surface when
the core `BuniumWindow`/IPC API changes later. Don't build all 6 upfront the moment this phase
starts; get one framework × one language working end-to-end first, then generalize the templating
mechanism from that, same "prove it once, then generalize" pattern used throughout this project so
far.

**Done: first template proven end-to-end (`solid-ts`).** `create-bunium-app/` at the repo root:

- `create-bunium-app/index.ts` — the CLI itself (`#!/usr/bin/env bun`, run directly, no build
  step). Copies `templates/<name>/` to the target dir, substituting two placeholders
  (`__PROJECT_NAME__`, `__BUNIUM_VERSION__`) in text files as a plain string-replace pass — not
  a templating engine, deliberately, since the placeholder set is tiny. `TEMPLATES` is a single
  array to extend as more templates land; the copy/render logic is already template-agnostic,
  so adding e.g. `react-ts` later is just a new `templates/react-ts/` dir plus one array entry.
  Usage: `create-bunium-app <dir> --template=solid-ts` (template flag optional, defaults to
  `solid-ts` since it's the only one that exists yet).
- `create-bunium-app/templates/solid-ts/` — a real Vite + Solid + TypeScript app wired to
  bunium: `electron/main.ts` is the app's main-process entry, branching on `NODE_ENV` between
  dev (`loadURL("http://localhost:5173/")` against the Vite dev server started by the `dev`
  script) and prod (`app.setAppRoot(distDir)` + `loadURL("bunium://app/")` against the built
  `dist/`, per the Phase 3 mechanism) — exactly the two modes Phase 3 proved out
  independently, now wired together as a real app shape for the first time. `package.json`
  scripts: `dev` (`concurrently` running `vite` + `bun run --watch electron/main.ts`), `build`
  (`tsc -b && vite build`), `start` (run the built app's main process directly, assumes `build`
  already ran).
- **Pinned to Solid 2.0 RC** (`solid-js@2.0.0-rc.0`) per explicit user request (2026-08-16),
  since 2.0 had just entered RC — not the stable 1.x line. This mattered beyond just a version
  bump: Solid 2.0 splits the web-specific runtime out of the core package, so `render()` now
  comes from a separate **`@solidjs/web`** package (was `solid-js/web` in 1.x) — added as an
  explicit direct dependency (not left as a transitive dep of `vite-plugin-solid`, which is not
  safe to rely on for app code) and `tsconfig.json`'s `jsxImportSource` points at
  `@solidjs/web` (was `solid-js`) accordingly. Plugin side: `vite-plugin-solid` only got Solid
  2.0 support on its `next` dist-tag (`3.0.0-next.x`, depending on `@solidjs/vite-plugin`) —
  the `latest`/2.x plugin line only supports Solid 1.x, so the template pins
  `vite-plugin-solid@3.0.0-next.27` explicitly rather than a `^` range (a `next`-tagged
  pre-release won't be picked up by caret ranges resolving against `latest` anyway). Verified
  the whole chain actually works, not just "versions listed in package.json": scaffold →
  `bun install` → `tsc -b` (typechecks clean with the corrected `jsxImportSource`) →
  `vite build` → loaded the built output through `bunium://app/` and confirmed via
  `captureScreenshot()` + `[console]`-forwarded-error check that it rendered with zero errors.
  If a Solid 2.0 RC compatibility issue surfaces later (pre-1.0-final churn risk), fall back to
  `solid-js@^1.9` + `solid-js/web` + `vite-plugin-solid@^2.11` — noted inline in the template's
  `vite.config.ts` comment.
- **Verified for real, not just "files exist":** scaffolded a project via the CLI into a temp
  dir, `bun install`ed it against this repo via a `file:` dependency (confirms `bunium` is
  importable as a package name, not just via relative `../src/index` like every `examples/*.ts`
  file uses), ran `tsc -b && vite build` to produce a real `dist/`, then loaded that `dist/`
  through a throwaway script calling `app.setAppRoot()` + `loadURL("bunium://app/")` — confirmed
  via `captureScreenshot()` that the built Solid app actually rendered (correct frame
  dimensions, no `[console]`-forwarded JS errors, matching the same verification rigor as
  `examples/scheme-handler-test.ts`). Scratch verification script deleted after use; not part of
  the shipped CLI.

**Done: all 6 template combinations built and verified (2026-08-16).** Generalized the
`solid-ts` mechanism above to the remaining 5: `react-ts`, `react-js`, `solid-js`, `vue-ts`,
`vue-js`. `TEMPLATES` in `create-bunium-app/index.ts` now lists all 6; `TEXT_EXTENSIONS` gained
`.vue`, and a `TEXT_FILENAMES` set (`.gitignore`) was added since dotfiles-with-no-extension
don't survive the naive `lastIndexOf(".")` extension-slice check the placeholder-substitution
pass uses to decide text vs. binary copy.

- **The shared `electron/main.{ts,js}` pattern held up unchanged across all 6** — same
  `NODE_ENV` dev/prod branch, same `app.setAppRoot()` + `bunium://app/` prod mechanism, same
  Vite dev server port/`strictPort` convention, only the `.ts`/`.js` variable-declaration syntax
  differs (e.g. `let win: BuniumWindow;` vs. `let win;`). Validates the "one shared base, layered
  per-framework templates" design goal from the top of this Phase actually generalizes, not just
  a claim proven on one template.
- **Solid 2.0 RC pin applies to both `solid-ts` and `solid-js`** — same `solid-js@2.0.0-rc.0` +
  `@solidjs/web@2.0.0-rc.0` + `vite-plugin-solid@3.0.0-next.27` pin and `@solidjs/web` import
  rationale as documented above for `solid-ts`, just carried over verbatim to the JS variant.
- **Package versions pinned for the React/Vue templates** (checked current as of 2026-08-16 via
  `bun pm view <pkg> version`): `react@^19.2.8`, `react-dom@^19.2.8`,
  `@vitejs/plugin-react@^6.0.4`; `vue@^3.5.40`, `@vitejs/plugin-vue@^6.0.8`, `vue-tsc@^3.3.8`,
  `@vue/tsconfig@^0.9.1` (the Vue TS template extends `@vue/tsconfig/tsconfig.dom.json` rather
  than hand-writing Vue's recommended `tsconfig` compiler options, same "don't reinvent what the
  framework's own tooling already maintains" reasoning as everywhere else `tsconfig` bases are
  extended in this project).
- **Verified for real, same rigor as `solid-ts`, for every one of the 5 new templates:**
  scaffold → `bun install` against this repo via a `file:` dependency → `tsc -b`/`vue-tsc -b`
  (TS templates) → `vite build` → load the built `dist/` through `bunium://app/` →
  `captureScreenshot()` + `[console]`-forwarded-error check confirming zero JS errors and
  correct frame dimensions. All 6 passed clean.
- **One class of bug found and fixed during this pass, isolated to `.vue`/`.html` files:** the
  file-write tooling used while authoring the Vue templates twice corrupted content containing
  HTML/Vue-template-style angle-bracket tags (a duplicated/garbled `<script setup lang="ts">`
  opening line in both `vue-ts/src/App.vue` and `vue-js/src/App.vue`; a doubled closing tag
  (`</html</html>>`) in `vue-js/index.html`) — not a bunium code defect, a content-authoring
  tooling quirk specific to that markup shape. Fixed by rewriting the affected files whole via a
  shell heredoc instead of the structured file-edit tool, then re-verified byte-for-byte via a
  full sweep (`sed -n` over the opening and closing lines of every `.html`/`.vue`/`.tsx`/`.jsx`/
  `.ts`/`.js`/`.json` file across all 6 template dirs) before considering the phase done. Noting
  this here in case the same tooling quirk resurfaces in a later phase touching Vue-template or
  raw-HTML content.

**Still open:** publishing `create-bunium-app` (and `bunium` itself) to npm — right now the only
verified install path is a local `file:` dependency; a real publish needs `vendor/` (388M CEF
distro) excluded from the package via `files`/`.npmignore`, which hasn't been set up yet.

## Phase 5 — Extensibility surface (tray, menu, system features)

Design a plugin/module registration pattern early enough that it doesn't require breaking changes
later — but don't build it speculatively before Phase 1 proves what the main-process API even
looks like.

**A dedicated low-level utils package** (`src/system/` or a separate `@bunium/system` package
once the monorepo layout is decided — TBD, see "not yet decided" below) for things that don't fit
`BuniumWindow`: native menu bar (`NSMenu`), system tray (`NSStatusItem`), OS notifications, native
dialogs (open/save file, message boxes). Same native-ABI-plus-thin-TS-wrapper pattern as
`BuniumWindow` — flat C ABI functions in `native/mac/`, typed classes in `src/`. Each of these is
its own small vertical slice (menu ≠ tray ≠ notifications), don't build one giant "system" god
object — mirrors how `BuniumWindow` itself grew one ABI function at a time rather than as a
single upfront design.

**Progress (2026-08-16): menu bar + system tray built and verified end-to-end.** First two
Phase 5 vertical slices land, sharing one new native->JS event plumbing rather than two bespoke
bridges (mirroring the standing typed-IPC requirement, at the app level).

- [x] **`src/system/` package** (`menu.ts`, `tray.ts`, `events.ts`, `index.ts`) -- `Menu`
      (builder over `NSMenu`: flat items with numeric `id`s, nested submenus, separators),
      `Tray` (`NSStatusItem`, title + optional status menu), `events.ts` (`SystemEventBus`
      singleton drained by the app pump). No single System god object: menu and tray are
      independent classes wired to a shared event bus, per this phase's own design note.
- [x] **New native module `native/mac/bunium_system_mac.mm`** (added to `build.sh`), ten new
      C ABI symbols (`bunium_system_menu_create/_add_item/_add_submenu/_add_separator/`
      `_set_application_menu`, `bunium_system_tray_create/_set_title/_set_menu/_destroy`, and
      `bunium_poll_system_event`). Same envelope pattern as `bunium_poll_message`.
      `nm -gU`-verified all ten are exported from the rebuilt dylib.
- [x] **Menu clicks reaching main-process JS without an extra ffi callback surface:** a single
      shared `BuniumMenuDispatcher` target (identified by `NSMenuItem.tag`) pushes
      `bunium-menu-click` events (`{id}`) into a mutex-guarded native inbox, drained each app
      pump tick by `app.ts` (new `systemEvents.drain()` alongside `pollWindows`). The
      renderer->main inbox pattern from Phase 2 generalizes to app-level system events.
- [x] **`src/native.ts` bindings + `src/index.ts` exports** (`Menu`, `Tray`, `systemEvents`, and
      `MenuItemSpec` type). `bunx tsc --noEmit` clean, `bun run lint` clean.
- [x] **Compiled the native shim for real** (not just authored): `native/mac/build.sh` builds
      clean against the vendored CEF wrapper (only deprecation warnings for `NSStatusItem.title`,
      which is a deliberate v1 simplification -- tray is text-only for now).
- [x] **Smoke test `examples/system-menu-tray-test.ts` runs clean end-to-end** (exit 0): builds a
      nested menu, sets it as the application menu bar, creates a tray with a status menu,
      pumps the loop, tears down. Confirms the new ABI links, the drain spins, and nothing
      crashes.

**Progress (2026-08-17): OS notifications + native dialogs land as the next two vertical
slices**, each with its own `.mm` module plus thin typed wrappers in `src/system/`, sharing the
menu/tray event bus via the new `native/mac/bunium_system_events.h` (`PushSystemEvent`,
previously `static` in `bunium_system_mac.mm`, now shared).

- [x] **Notifications (`native/mac/bunium_system_notify_mac.mm` + `src/system/notifications.ts`):**
      `Notification` class (`title`/`body`/`id`, `show()`, per-instance `onClick`) over a dual
      backend chosen by bundle presence -- `UNUserNotificationCenter` for bundled/packaged apps
      (the current API), `NSUserNotification` fallback for unbundled dev binaries. Backend
      choice is load-bearing: referencing UN from an unbundled process throws
      `NSInternalInconsistencyException` and crashed the whole Bun runtime (observed, then
      fixed by gating on `[NSBundle mainBundle].bundleIdentifier`), so the legacy center is a
      deliberate dev-path choice, not a simplification. Clicks from either path push
      `bunium-notification-click {"id":N}` on the shared bus.
- [x] **Native dialogs (`native/mac/bunium_system_dialogs_mac.mm` + `src/system/dialogs.ts`):**
      `showOpenDialog`/`showSaveDialog`/`showMessageBox` promise API. All three are
      completion-handler driven (`beginWithCompletionHandler:` on panels, alert sheet on the
      key/main window) so dialog calls never block the JS pump; results arrive as
      `bunium-dialog-result {"requestId":N, "result":{...}}` events (paths JSON-encoded via
      `CefWriteJSON`, not string concatenation -- paths can contain quotes/backslashes) and the
      TS side matches on requestId to resolve its promise.
- [x] **Four new ABI symbols** (`bunium_system_notify`, `bunium_system_dialog_open/`
      `_save/` `_message`), `nm -gU`-verified in the rebuilt dylib; `-framework
UserNotifications` added to `build.sh`. `bunx tsc --noEmit` + `bun run lint` clean.
- [x] **Smoke tests `examples/system-notifications-test.ts` and `examples/system-dialogs-test.ts`
      run clean end-to-end** (exit 0, no `[console]` errors in stderr). Notifications exercised
      over the legacy dev path (no crash, clean teardown); dialogs kicked off open/save/message
      (message sheet auto-resolves to cancel headless; open/save completions need a real user).

**Progress (2026-08-17, same session): tray icons + tray clicks round out the tray slice.**
Same `bunium_system_mac.mm` module, four new ABI symbols, and the one shared dispatcher now
handles trays too.

- [x] **Tray icon support** -- `Tray.setIcon(path, template?)` (file-based, Electron-compatible)
      and `Tray.setSymbol(name)` (SF Symbol, asset-free) via `NSStatusBarButton.image`; template
      images adapt to menu bar appearance automatically. Also migrated title rendering from the
      deprecated `NSStatusItem.title` forwarding property to `item.button.title` -- the
      previously-noted deprecation warnings are gone (the build is now warning-free except the
      pre-existing CEF framework-version linker note). One ObjC++ gotcha: `image.template`
      dot-syntax does not parse in a .mm TU (`template` is a C++ keyword) -- must call
      `[image setTemplate:]`.
- [x] **Menu-less tray clicks** -- `Tray.onClick((id) => ...)`: `bunium_system_tray_set_click`
      wires the status button's target/action to the shared `BuniumMenuDispatcher` (new
      `trayClicked:` selector), buttons carry the tray handle in their tag, clicks push
      `bunium-tray-click {"id":T}` on the shared bus; `setMenu()` afterwards supersedes click
      delivery (matches Electron's context-menu behavior). `bunium_system_tray_get_id` exists
      because bun's ffi `Pointer` exposes no numeric accessor -- JS needs the handle-as-int both
      to filter per-tray events and to close the loop on which tray fired.
- [x] **Banner delivery + real tray clicks still not verifiable headlessly** -- same
      interactive-gap category as before; `examples/system-tray-icon-click-test.ts`
      verifies the icon loads (no "unknown SF Symbol" stderr), the click plumbing wires,
      and teardown is clean. Re-verified this session (exit 0).
- [x] **Banner delivery + real clicks still not verifiable headlessly** -- the same
      interactive gap as menu/tray: delivery needs either a bundled app (UN) or Notification
      Center honoring legacy delivers (dev), and clicking needs a live desktop user. Dialog
      panels show briefly on a real desktop when the smoke test runs -- inherent to
      completion-handler driven code. Both smoke tests re-verified this session (exit 0
      each, run sequentially).
- [x] **Still open:** The drag-region no-drag override on the tray/status side is N/A (drag
      regions are window content, handled in Phase 2). Native dialogs are file-open/save and
      message-box only for now (no multi-step custom panels). Packaging the `src/system`
      types for external consumers is Phase 11.

**Testing footnote (discovered this session):** bunium tests cannot be run in parallel --
CEF's per-profile `ProcessSingleton` (default `root_cache_path` = shared
`~/Library/Application Support/CEF/User Data`) aborts the second concurrent process with
"Failed to create a ProcessSingleton... Aborting now to avoid profile corruption".
Pre-existing, unrelated to the code (both runs pass when sequential). Not fixed because
real apps get a per-app `root_cache_path` at packaging (Phase 8) anyway.

## Phase 6 — Linux port

**Status: full examples/ sweep green (2026-08-22, Docker; re-validated on bare-metal real
Linux hardware in a later session), X11 windowing only (v1 scope, no Wayland).** Repeated
Phase 0-1 validation for this platform rather than assuming macOS/Windows findings transfer --
two real, Linux-specific bugs found and fixed along the way (below).

**Real-hardware re-validation (bare-metal Debian 12 arm64, no Docker):** everything documented
below as Docker-only also works unmodified directly on a real Linux host -- `docker/linux/
fetch-cef.sh` and `native/linux/build.sh` both ran successfully outside any container, and
`docker/linux/run-examples.sh` itself runs fine on bare metal too (it only needs Xvfb +
optionally a D-Bus session bus, not Docker itself). Sweep result matched the Docker baseline
exactly: 35/37 immediate PASS, `color-scheme-live-test.ts` fails as expected (mac-only
`osascript`), and `vite-dev-test.ts` passes once `bunx` has a warm cache for the `vite` package
(same "stone-cold container" caveat already documented below, confirmed to be the same root
cause on real hardware, not Docker-specific) -- true steady-state Linux pass rate 36/37, one
expected platform-skip. No new native-host-specific bugs found (X11 direct vs. Xvfb, real
D-Bus session bus vs. the fake test daemons -- all behaved identically). Docker remains a valid
option for reproducible/CI builds, but is no longer the only supported way to build/dev/test
Linux locally.

`docker/linux/` is the dev/build/test environment (arm64 Ubuntu 24.04 container -- matches
Docker Desktop's native platform on Apple Silicon, avoiding QEMU emulation for the CEF build):
`Dockerfile` (toolchain + X11/Chromium runtime deps + Xvfb), `fetch-cef.sh` (downloads/verifies
the pinned CEF linuxarm64/linux64 distro in 10MB chunks -- this network path caps a single
response at 10MB -- and builds `libcef_dll_wrapper` via cmake/ninja), `run-examples.sh` (runs
every `examples/*.ts` sequentially under Xvfb, one at a time -- same ProcessSingleton rule as
mac/win -- prints a PASS/FAIL summary).

`native/linux/build.sh` builds `bunium_shim.so` + `bunium_subprocess` from
`native/mac/bunium_shim.cpp`/`subprocess_main.cpp`/`bunium_bsdiff_wrap.mm` unchanged (already
proven platform-agnostic by the Windows port) plus Linux-only sources: `bunium_window_linux.cc`
(real Xlib top-level window + sublayers, XPutImage software blit, X11 Shape extension for
sublayer clipping, no DPI scaling yet), `bunium_system_events_linux.cc` (shared system-event
inbox), `bunium_system_notify_linux.cc` (real org.freedesktop.Notifications D-Bus client),
`bunium_system_dialogs_linux.cc` (real GTK file chooser/message dialogs),
`bunium_system_tray_linux.cc` (real org.kde.StatusNotifierItem D-Bus service), and
`bunium_system_linux_stub.cc` (menu only -- see the deferred-menu note below). Built with
`g++`/`gcc`, not clang -- see the compiler-vendor ABI mismatch note below.

**Two real bugs found and fixed during bring-up:**

- **Cross-compiler C++ ABI mismatch (build-time).** Building `bunium_shim.cpp` with clang++
  against `libcef_dll_wrapper.a` (built by CEF's own cmake, which resolves to `/usr/bin/c++` ->
  g++ on the Ubuntu image) segfaulted immediately inside `CefInitialize` -- confirmed via gdb:
  a by-value `scoped_refptr<CefApp>` parameter's hidden-reference pointer arrived null/garbage.
  Fixed by building with g++ throughout (matches the wrapper's own toolchain) -- the same class
  of bug as the Windows port's bootstrap-flag mismatch (`native/win/build.sh`), different root
  cause (compiler vendor vs. a CEF build define).
- **Chrome-runtime pak/locale files resolve DIR_MODULE-relative, not via
  `CefSettings.resources_dir_path` (startup crash).** Every window-creating example hard-crashed
  on launch with a release `CHECK` (SIGTRAP, no stderr message) inside
  `ChromeMainDelegate::PostEarlyInitialization -> LoadLocalState`. Root-caused via gdb backtrace
   - strace: `chrome_100_percent.pak`/`chrome_200_percent.pak`/`resources.pak`/locale paks were
     being looked up relative to **libcef.so's own directory** (`native/build-linux/`, where the
     shim copies it) via `base::PathService::Get(base::DIR_MODULE)`/dladdr -- `resources_dir_path` only
     governs CEF's own resource-bundle delegate, not Chrome-runtime's separate resource-bundle
     init. Fixed in `native/linux/build.sh`: copy `*.pak` + `locales/` from
     `vendor/cef-<platform>/Resources/` next to the built shim, same pattern
     `native/win/build.sh` already used (and had already solved this exact issue for Windows,
     just not yet recognized as the same root cause when Linux hit it independently). Also needed,
     matching the win build script: `icudtl.dat` + `v8_context_snapshot.bin` copied next to the
     shim for the same DIR_MODULE-relative reason (ICU/V8 init).
- **`src/paths.ts` had no Linux branch at all** (only `isWin` vs. a macOS-only else) --
  every dlopen attempted to load `bunium_shim.dylib` on Linux, failing with `ERR_DLOPEN_FAILED:
invalid ELF header`. Added `isLinux` + a `native/build-linux/bunium_shim.so` dev-tree branch
  (own output dir, not `native/build/` -- see the build-output-collision bug below) and a Linux
  platform-package branch
  (`bunium-linux-<arch>/shim/bunium_shim.so`) for Phase 11 parity. `frameworkDir`/`resourcesDir`
  mirror Windows' flat Release/Resources split (no framework bundle on Linux either) --
  `vendor/cef-linuxarm64/Release` + `.../Resources`, arch-derived dir name matching
  `native/linux/build.sh`'s own `cef-linuxarm64`/`cef-linux64` convention.
- **Build-output collision with the mac host -- a real incident, not hypothetical.**
  `native/linux/build.sh` originally wrote into `native/build/`, the same directory the mac
  build uses -- and `bunium_subprocess` has no platform-suffixed filename (unlike
  `bunium_shim.{dylib,so,dll}`), so running the Docker Linux build against this repo's
  bind-mounted checkout silently overwrote the host's mac subprocess binary with the Linux ELF
  one. Symptom on the mac host: `bun run examples/*.ts` started failing with
  `cannot execute binary file` + a GPU-process-exited/network-service-crashed loop, not an
  obvious "wrong binary" error. Fixed by moving Linux output to its own `native/build-linux/`
  dir (`.gitignore`d alongside `native/build/`) -- structurally prevents the collision instead
  of relying on remembering to rerun `bun run build:native:mac` afterward. **Anyone doing Linux
  Docker-based dev against a repo checkout also used for mac/win dev should know this class of
  bug exists** -- any future platform port sharing a bind-mounted checkout should give its
  build output its own directory from the start.

**Full `examples/` sweep (2026-08-22, linuxarm64 container, bun 1.4.0): 35/37 PASS.** Every
window/IPC/webview/system-stub/update example passes, including `webview-{clip,clip-hit,
element,hit,stacking}`, typed IPC both directions, `bsdiff`/`update-journal`/`update-e2e`/
`relaunch`. Two non-bugs, both environment-limited (same category as Windows' own exclusions):

- `color-scheme-live-test.ts` is inherently mac-only (shells out to `defaults`/`osascript`) --
  stays off the Linux run matrix, same as it already does for Windows.
- `vite-dev-test.ts` failed once on a stone-cold container (`bunx vite`'s first-ever invocation
  needs to resolve/download ~110 packages, blowing the test's 10s dev-server-ready timeout) --
  passed cleanly on a rerun with a warm `bunx` cache. Not a bunium bug; a real Linux dev machine
  running this after its own `bun install` already has the cache warm.
- This session's separate `OnBeforeContextMenu` fix (suppressing CEF's unsupported-in-OSR
  default context menu, which crashed the whole process on right-click) lives in the shared
  `bunium_common.h` with no platform guard, so it already applies to Linux for free -- no
  Linux-specific work needed. **Verified 2026-08-24 against a real right-click, not just by
  inspection** -- see the real-desktop verification section below.

**Phase 5 system surface (2026-08-22): notifications, dialogs, and tray are real; menu is
deferred.**

- **Notifications** (`native/linux/bunium_system_notify_linux.cc`) -- real
  org.freedesktop.Notifications D-Bus client (libdbus-1, no GTK dependency). `Notify()` sent
  non-blocking; a background thread owns the connection's read/write/dispatch loop for the
  process's lifetime; `ActionInvoked` signals translate the daemon's own notification id back to
  bunium's app-assigned id via a small map, delivered through the existing system-event bus.
  Degrades to a silent no-op when no session bus is reachable.
- **Dialogs** (`native/linux/bunium_system_dialogs_linux.cc`) -- real `GtkFileChooserDialog`
  (open/save) and `GtkMessageDialog` (message box), driven by the "response" signal (never
  `gtk_dialog_run()`, so nothing blocks the JS pump). **Real bug found and fixed:** an initial
  version spawned its own thread running `gtk_main()`, since GTK requires all UI calls on the
  thread that called `gtk_init()`. This crashed immediately (SIGTRAP inside
  `base::MessagePumpGlib::Run`, confirmed via gdb) -- CEF's own browser-process UI thread
  already runs a GLib-based message pump on the process's default `GMainContext` (bunium runs
  CEF with `multi_threaded_message_loop=false`, so dialog calls arrive on that same thread), and
  GLib aborts when two threads try to own the same default context concurrently. Fixed by not
  spawning a thread at all: `gtk_init()` once on the calling thread, widgets created
  synchronously (still non-blocking), and CEF's already-running GLib pump dispatches GTK's
  events for free. v1 simplification: GTK's `GtkFileChooserAction` is one enum value, not
  independent flags like mac's `canChooseFiles`/`canChooseDirectories`, so `canChooseDirectories`
  selects `GTK_FILE_CHOOSER_ACTION_SELECT_FOLDER` outright rather than a mixed picker.
- **Tray** (`native/linux/bunium_system_tray_linux.cc`) -- real org.kde.StatusNotifierItem D-Bus
  service: each tray registers a unique bus name + object path, serves its
  Category/Id/Title/Status/IconName/Menu properties via `org.freedesktop.DBus.Properties`, and
  handles Activate/SecondaryActivate/ContextMenu/Scroll methods, registering with
  `org.kde.StatusNotifierWatcher` on creation (best-effort -- no watcher exists without a real
  desktop panel). **Real bug found and fixed:** `dbus_bus_request_name()`/
  `dbus_bus_release_name()` are `*_and_block`-style blocking calls that do their own synchronous
  read loop -- calling them while the background dispatch thread also owns the connection's
  read/dispatch loop deadlocked every single time (reproduced consistently). Fixed by sending
  `RequestName`/`ReleaseName` as plain non-blocking messages instead, matching the
  fire-and-forget pattern `RegisterStatusNotifierItem` already used. v1 scope: `IconName` only
  (`setSymbol` -- a real freedesktop icon-theme name, won't resolve for the SF-Symbol-style names
  cross-platform example code passes, same "platform interprets its own idiom" precedent Windows
  already established). `setMenu` is a no-op since native menu is still stub-only (below).
  **Update (2026-08-25): `setIcon` (arbitrary image file) is now real, no longer a no-op.**
  See the dated entry below ("Tray `setIcon` implemented via GdkPixbuf") for the full writeup;
  this earlier note is left in place only to record that it _was_ originally deferred and why.
- **Menu is deliberately deferred, not just unimplemented-by-oversight.** Linux has no
  NSMenu/HMENU equivalent bunium can attach without real design work: `bunium_window_linux.cc`
  is a raw Xlib window (no GTK/Qt toolkit window at all), and there is no single cross-desktop
  "global application menu" convention the way macOS has one -- GNOME/Unity's own appmenu
  protocol (`com.canonical.AppMenu` via D-Bus) is GNOME-specific, and most other Linux DEs (KDE,
  XFCE, etc.) have no native equivalent at all, expecting an in-window `GtkMenuBar`/Qt menu bar
  instead. Building this properly means either (a) growing a real GTK/Qt toolkit window
  alongside the existing Xlib one just to host a menu bar, or (b) a DE-specific D-Bus protocol
  with no universal fallback -- both are real architectural decisions, not a quick vertical
  slice like notify/dialogs/tray were. Tracked as open Phase 6 v2 scope.
- **Deferral confirmed after deeper D-Bus protocol research (2026-08-23):** option (b) is
  _more_ fragmented than the tray's StatusNotifierItem precedent suggested it might be, not
  less. KDE's own AppMenu mechanism (`_KDE_NET_WM_APPMENU_SERVICE_NAME`/`_OBJECT_PATH` X11
  window properties + the `com.canonical.dbusmenu` D-Bus interface) only activates when the
  optional, non-default `kappmenu` KWin script/applet is enabled by the user -- it is not a
  bare-KDE-install guarantee the way SNI is a bare-KDE/GNOME guarantee for tray. GNOME has no
  support for this protocol at all; it has its own separate, extension-gated, incompatible
  `org.gtk.Menus`/`org.gtk.Actions` mechanism. Unity's `com.canonical.AppMenu` is dead
  (Unity itself is dead). There is no single D-Bus menu protocol with SNI-level broad native
  support -- implementing any one of them would be a narrow, single-DE, opt-in-applet-only
  slice, not the "real but DE-scoped, broadly useful" pattern tray achieved. **Decision: v1
  ships the honest no-op stub (`bunium_system_linux_stub.cc`), no D-Bus AppMenu attempt.**
  Revisit only if a future session decides an in-window GTK/Qt menu bar (option a) is worth
  the toolkit-window investment.
- **All three real (notify/dialogs/tray) verified end-to-end, not just no-crash**, via
  throwaway dev/test-only fake D-Bus services (not shipped, not built by
  `native/linux/build.sh`): `docker/linux/fake_notify_daemon.c` (owns
  `org.freedesktop.Notifications`, replies to `Notify()`, emits `ActionInvoked` -- proved
  click delivery round-trips into JS) and `docker/linux/fake_sni_watcher.c` (owns
  `org.kde.StatusNotifierWatcher`, captures the registered item, calls `Properties.GetAll`
  and `Activate()` back on it -- proved property serving and click delivery both round-trip).
  Full `examples/` sweep still 35/37 (same two environment-limited non-bugs as before).

**Real-hardware follow-on work (2026-08-22, bare-metal Debian 12 arm64):**

- **DPI/HiDPI scaling implemented.** `bunium_window_get_scale` now returns a real detected
  scale instead of hardcoded 1.0: `DetectX11Scale()` in `bunium_window_linux.cc` checks the
  `GDK_SCALE` env var first (GTK convention, int 1-4), else reads the `Xft.dpi`/`Xft.Dpi` X
  resource via `XrmGetResource` and computes `dpi/96.0` (96 = scale 1.0, matches Win32), clamped
  to `[0.5, 4.0]`, falling back to 1.0 if neither source is available (matches plain Xvfb/no-DE
  environments). Detected once at window-creation time, no live-DPI-change tracking. All native
  geometry call sites (`XCreateWindow`, `XSetWMNormalHints` size hints, `XMoveResizeWindow` for
  sublayers, `XShapeCombineRectangles` for clip regions, mouse-event coordinate forwarding)
  convert between logical (CSS) px -- the cross-platform JS-facing contract -- and physical px
  at the boundary, mirroring the pattern already used in `bunium_window_win.cc`
  (`PhysToLogical`/`LogRectToPhysical`). Validated on real hardware at scale 1.0 (no regressions,
  full sweep) and with `GDK_SCALE=2` (window physical size, mouse/click hit-testing at both
  sublayer and webview-clip levels, and screenshot pixel dimensions all confirmed correct at 2x).
- **Synthetic resize-edge + draggable-region hit-testing implemented for frameless windows,**
  using the EWMH `_NET_WM_MOVERESIZE` client-message convention (the same mechanism GTK/Qt's own
  client-side-decoration windows use) instead of mac's fully-synthetic drag-loop approach --
  `ResizeDirectionAtPoint()` in `bunium_window_linux.cc` does the same 6px-border geometry test
  as mac's `ResizeEdgeAtPoint`/win's `WM_NCHITTEST` edge math, and `SendNetWmMoveResize()` hands
  the actual move/resize off to the window manager entirely (gets snapping/multi-monitor/edge-
  resistance for free, same delegation model as mac's `performWindowDragWithEvent:`). Wired into
  `bunium_window_pump_events`'s `ButtonPress` case, frameless (`frame_enabled=false`) top-level
  windows only, same priority order as mac's `mouseDown:` (resize edge wins over an overlapping
  draggable region). Verified end-to-end -- not just no-crash -- via a standalone XTest-based
  harness (`native/linux/test-resize-moveresize.cc`, ad hoc build/run instructions in its header
  comment, not part of `build.sh`/the examples sweep) that synthesizes a real `ButtonPress` via
  `XTestFakeButtonEvent`/`XTestFakeMotionEvent` through the actual X server and confirms the
  expected `_NET_WM_MOVERESIZE` `ClientMessage` (or correctly, its absence for a non-edge/non-drag
  click) is observed on the root window after a real pass through `bunium_window_pump_events` --
  a stronger automated check than mac/win currently have for the equivalent code (both
  explicitly document in `frameless-resize-test.ts` that raw-FFI dispatch bypasses their real
  mouse handlers entirely). Actually completing a WM-driven drag/resize was not visually verified
  (no WM installed in the no-network-passwordless-sudo bare-host test environment used this
  session) -- remains a manual/visual follow-up, same category as mac/win's own acknowledged gap.
  **Resolved 2026-08-23, see below: this exposed a real bug.**

**WM-driven resize/drag + alpha compositing, verified against real openbox+picom (2026-08-23):**

- Installed openbox (WM) and picom (compositor) on the bare-metal Debian 12 arm64 host and ran
  Xvfb `:99` with `+extension COMPOSITE +extension RENDER` (needed for picom). This let two
  previously-synthetic-only-verified code paths finally be checked against real WM/compositor
  behavior instead of just XTest message injection or CEF's own internal buffer.
- **Found and fixed a real bug: frameless windows used `override_redirect=True` to hide
  decorations, which is fundamentally incompatible with WM-driven resize/drag.** Override-
  redirect windows are, by X11 definition, invisible to `SubstructureRedirect`, so a real WM
  never sees (and thus never responds to) the `_NET_WM_MOVERESIZE` ClientMessage that
  `SendNetWmMoveResize()` sends -- openbox silently ignored every resize/drag attempt on a
  frameless bunium window. This was undetectable by the prior XTest-only test
  (`test-resize-moveresize.cc`) because that test only proves the message is _sent_, never that
  anything _responds_. Fixed in `bunium_window_create` by replacing `override_redirect`
  toggling with the standard `_MOTIF_WM_HINTS` decoration-hiding mechanism (same one GTK/Qt use
  for client-side decorations: `MotifWmHints{flags=MWM_HINTS_DECORATIONS, decorations=0}` via
  `XChangeProperty`), which keeps the window WM-managed. Added a new real-WM-driven test,
  `native/linux/test-resize-real-wm.cc`, which synthesizes a full border-drag-with-motion
  sequence and checks _actual window geometry_ before/after (400px -> 460px width, confirmed) --
  the first proof in this project that resize-edge hand-off produces a real on-screen resize
  under a real WM, not just a correctly-sent protocol message.
- **Alpha compositing implemented for real (previously only alpha-byte-correct-but-never-
  displayed).** `bunium_window_linux.cc` always created windows with `DefaultVisual`/depth 24
  regardless of `transparent`, so the alpha channel painted by `BlitFrame` was silently
  discarded by the X server before it ever reached the screen -- `transparent-window-test.ts`
  still passed because it only reads CEF's own internal OSR buffer via `captureScreenshot()`,
  which never touches the X server/compositor at all (a real test-coverage gap, since fixed --
  see `native/linux/test-alpha-hold.ts` below). Fixed by adding `FindArgbVisual()` (uses
  `XGetVisualInfo` to find a 32-bit TrueColor visual, preferring one with a nonzero alpha mask)
  and, when `transparent=true`, creating the window with that visual + a matching `AllocNone`
  colormap + `border_pixel=0` (required for non-default-depth `XCreateWindow`) instead of the
  default; falls back gracefully to a normal opaque window if no ARGB visual exists (matches the
  file's existing pattern for missing environment capabilities, e.g. `DetectX11Scale`'s 1.0
  fallback). `BlitFrame` now builds its `XImage` at the window's actual resolved visual/depth
  instead of a hardcoded `DefaultVisual`/24, since `XPutImage` silently drops the alpha byte if
  the image depth doesn't match the window's. Verified against a real compositor: a plain
  solid-color X11 reference window placed behind the transparent bunium window, screenshotted
  via `import -window root` (ImageMagick, reads the true composited output through picom, unlike
  a raw `XGetImage` on the bare root window) and sampled -- the reference window's color shows
  correctly through the transparent area (not the opaque-black the pre-fix bug would have
  produced), while the opaque red square still renders correctly on top. New verification
  fixture: `native/linux/test-alpha-hold.ts` (uses the real `BuniumWindow`/`app.init()` path, so
  CEF init is handled automatically -- a from-scratch raw-dlopen C++ harness was tried first and
  crashed with a CEF-internal fatal error from skipping `bunium_init()`, and was abandoned in
  favor of this TS fixture) + `native/linux/test-alpha-bg-window.cc` (the solid-color reference
  window; painting the X11 root background directly was tried first but proved unreliable, since
  picom doesn't composite a bare root background the way a compositor-less `XClearWindow` does).
  Full `examples/` sweep re-run with no regressions.
- Both fixes are Linux-specific (`bunium_window_linux.cc` only); mac/win were not touched.

**Real-desktop verification (GNOME Shell 43.6, real gdm3/Xwayland session on `:0`, not
headless Xvfb), 2026-08-24:** this host also has a real logged-in GNOME desktop session
(`gdm3` on tty2, `gnome-shell` PID owning `:0` + `wayland-0`, real D-Bus session bus at
`/run/user/1000/bus`), which closed several previously-inspection-only or fake-daemon-only
gaps:

- **Notifications**: `dbus-monitor`'d the real session bus while running
  `examples/system-notifications-test.ts` against `:0` (not the Docker fake-daemon setup) --
  confirmed the real `org.freedesktop.Notifications.Notify` call is received and forwarded to
  GNOME Shell's actual handler (visible as a second internal `Notify` call tagged with
  `sender-pid`), not just accepted by a fake stub. Real delivery proven, not just no-crash.
- **Dialogs**: `examples/system-dialogs-test.ts` ran clean against the real X11 session -- real
  `GtkFileChooserDialog`/`GtkMessageDialog` created against the actual live GTK/desktop theme
  (not headless Xvfb), no crash.
- **Context menu**: new fixture `native/linux/test-context-menu.ts` (same
  `bunium_dispatch_mouse_click` ABI `examples/mouse-click-test.ts` already uses for left-clicks,
  `button=2` -> `MBT_RIGHT`) dispatches a real right-click through CEF's actual Views/GTK
  context-menu codepath on the live desktop -- process survives, page's own `contextmenu` JS
  handler still fires (proving `OnBeforeContextMenu` suppresses only CEF's native menu, not
  page-level handling), closing the previously-inspection-only gap noted above.
- **Tray click**: GNOME Shell 43 ships no built-in `org.kde.StatusNotifierWatcher` provider by
  default -- user installed `gnome-shell-extension-appindicator` (apt) + enabled it
  (`gnome-extensions enable ubuntu-appindicators@ubuntu.com`, required a logout/login under
  Wayland since GNOME Shell can't hot-reload newly-installed extensions like on X11). Once
  enabled, `org.kde.StatusNotifierWatcher` registers for real. New fixture
  `native/linux/test-tray-click.ts` proves the FULL click pipeline against the real watcher: (1)
  `dbus-monitor` confirms bunium's `RegisterStatusNotifierItem` call reaches the real watcher
  and it broadcasts `StatusNotifierItemRegistered`/`Unregistered` (genuine desktop-level
  registration, not a stub); (2) the fixture then calls `Activate(0,0)` directly on bunium's own
  registered `org.kde.StatusNotifierItem-<pid>-<id>` D-Bus service/object path -- this IS the
  real click-delivery mechanism a StatusNotifierWatcher-driven desktop (GNOME Shell+
  AppIndicator, KDE Plasma) uses on an actual physical click, not a shortcut -- and confirms
  `onClick()`'s JS callback fires with the correct tray id. Both notifications and tray-click
  gaps are now closed.

**Known v1 scope gaps (deliberate, matches the "repeat Phase 0-1, not full parity" plan note):**

- X11 only, no Wayland (Xwayland compat verified via the real-desktop testing above, but no
  Wayland-native backend exists or is planned for v1).
- X11 only, no in-window GtkMenuBar/Qt menu bar and no `Menu.setApplicationMenu()` -- see the
  dated entry below ("Linux menu bar shipped via tray-attached dbusmenu") for why this stays an
  honest no-op even after `setMenu` became real.

**Packaging (Phase 8 equivalent) — done (2026-08-23):** `packaging/linux/package.sh` produces
a flat `Name/{Name (shell launcher), bun, Runtime/, app/}` directory, modeled on
`packaging/win/package.sh`'s flat layout but with a plain shell-script launcher instead of a
compiled one (Linux has neither Windows' console-flash problem nor its shebang-exec
limitation, so a shell script is sufficient -- mirrors macOS' own launcher approach instead).
`Runtime/` merges `bunium_shim.so`/`bunium_subprocess`/`libcef.so`/`icudtl.dat`/
`v8_context_snapshot.bin`/paks/`locales/` into one directory, deliberately matching
`native/linux/build.sh`'s own `native/build-linux/` layout, because Chrome-runtime resolves
these relative to `libcef.so`'s own directory (`base::DIR_MODULE`), not
`CefSettings.resources_dir_path`. `--verify` reuses the shared `packaging/mac/fixture-app` (the
same fixture win already reuses) and was confirmed PASS against a real `Xvfb :99` on the bare
Debian arm64 host -- no WM install needed, since it's a screenshot pixel-check, not interactive
drag/resize. True `.deb`/AppImage/rpm distribution packaging is an explicitly deferred v2
follow-up (host has `dpkg-deb`+`fakeroot` but not `appimagetool`/`rpmbuild`) -- this flat
directory is the pragmatic v1, same "ship what's proven, document the gap" pattern as the menu
bar decision above.

**Investigated and resolved: no Linux-specific `locales_dir_path` branch needed in
`bunium_shim.cpp`'s `bunium_init()`** (unlike the existing `#if defined(_WIN32)` branch).
`cef_types.h`'s own doc comment states an empty `locales_dir_path` defaults to "the module
directory" (the dir `libcef.so`/`.dll` is loaded from) -- not "icudtl.dat's dir" as an earlier
code comment assumed. Windows needs the explicit override because its packaged layout splits
`libcef.dll` (`Release/`) from `locales/` (`Resources/`); Linux's dev tree, packaged app, and
platform package all keep `libcef.so` and `locales/` colocated in one directory, so CEF's
default resolution already works. This is a packaging-layout invariant now documented directly
in `bunium_init()` -- any future Linux layout that separates the two would need an explicit
`__linux__` branch added.

**Platform package (Phase 11 equivalent, `bunium-linux-<arch>`) — done (2026-08-23):**
`scripts/stage-release-artifacts-linux.sh` (parallel to the darwin-only
`scripts/stage-release-artifacts.sh`, arch-detected via `uname -m`) produces
`dist-release/bunium-linux-<arch>/{shim/,framework/}` + a gated `package.json` (`os`/`cpu`).
No `install_name_tool`-equivalent rewrite step is needed (Linux's `$ORIGIN`-relative rpath,
baked in at build time by `native/linux/build.sh`, already makes the binaries
location-independent) -- pure file copies suffice. `scripts/verify-platform-package-linux.sh`
(parallel to `scripts/verify-platform-package.sh`) proves the installed-consumer resolution
path end to end via a materialized `node_modules/bunium` + symlinked platform package, reusing
the same platform-agnostic `scripts/verify-platform-package-main.ts` fixture mac already uses.
Confirmed `PLATFORM-PACKAGE-SMOKE PASS` on the real host. `bunium-linux-<arch>` is not yet
added to root `package.json`'s `optionalDependencies` (deferred until an actual publish/release
decision is made -- the staging+verify scripts already prove the mechanism works without
touching the real consumer-facing dependency list).

**Tray `setIcon` implemented via GdkPixbuf (2026-08-25, Arch Linux x64):** previously
`bunium_system_tray_set_icon` in `native/linux/bunium_system_tray_linux.cc` just printed a
warning and did nothing -- only `setSymbol` (a freedesktop icon-theme name written to the SNI
`IconName` property) had a real effect. Implemented actual arbitrary-image-file support:
decodes the file via `gdk-pixbuf-2.0` (already transitively linked through the existing
`gtk+-3.0` pkg-config dependency -- no new build flags needed), converts it into the SNI spec's
`a(iiay)` `IconPixmap` D-Bus property (big-endian ARGB32, row-major, per-pixel repacking from
GdkPixbuf's R/G/B/A byte order), and wires the decoded pixmap into all three places a client can
observe it: the single-property `org.freedesktop.DBus.Properties.Get` path, the `GetAll` path,
and the introspection XML (`<property name="IconPixmap" type="a(iiay)" access="read"/>`).
`bunium_system_tray_set_icon` now stores the decoded pixmap in `TrayState` and emits a `NewIcon`
D-Bus signal (fire-and-forget, matching the file's existing non-blocking dispatch-thread-safe
pattern established by the `RequestName` deadlock fix above) so a live desktop panel refreshes
immediately. `is_template` remains ignored (a macOS-only concept -- Linux tray icons have no
light/dark-adaptive template-image convention). **Verified with a real byte-level D-Bus
fixture, not just no-crash:** `native/linux/test-tray-set-icon.ts` generates a tiny deterministic
2x3 PNG via ImageMagick's `convert`, calls `setIcon()`, then independently reads back the
`IconPixmap` property via a real `gdbus call ... org.freedesktop.DBus.Properties.Get` against
bunium's own registered SNI object -- parses the actual returned byte array and asserts exact
pixel values round-trip correctly (confirmed `TRAY-SET-ICON PASS` with correct ARGB bytes
`[255,255,0,0]` red and `[255,0,255,0]` green at the expected offsets). Full `examples/` sweep
re-run after this change: 36/36 real PASS, no regressions.

**Linux distribution packaging: `.deb`/`.rpm`/AppImage implemented (2026-08-25, Arch Linux
x64).** The previously-flat-only `packaging/linux/package.sh` output is now wrapped by three
new sibling scripts, each consuming the flat `Name/` directory package.sh already produces
rather than re-deriving it (single source of truth for the launcher/env-var contract):

- `packaging/linux/package-deb.sh` -- installs the flat package verbatim under `/opt/<name>/`
  (the conventional FHS location for a vendored-runtime app that doesn't split into individual
  system libs), symlinks `/usr/bin/<name>`, and drops a `.desktop` entry under
  `/usr/share/applications/`. Built via `fakeroot dpkg-deb --build --root-owner-group`
  (fakeroot's LD_PRELOAD getuid/chown shims fabricate root:root payload ownership, which a
  `.deb`'s `data.tar` requires, without needing the build machine to actually run as root).
  Package name/version derived from the flat package dir name (lowercased) and the app's
  `package.json` `version` field.
- `packaging/linux/package-rpm.sh` -- same `/opt/<name>/` layout, built via `rpmbuild -bb`
  against a generated `.spec` whose `%install` scriptlet `cp -a`'s the flat package dir
  directly (passed in as an absolute path via `--define _srcpkgpath`, since a relative path
  would resolve wrong from rpmbuild's own deep `_topdir/BUILD` cwd -- a real bug hit and fixed
  during verification). Uses an isolated `--dbpath` under the build's own `_topdir` rather than
  the host's real `/var/lib/rpm` -- the real DB is root-owned on most distros and rpmbuild
  otherwise fails with "cannot open Packages database" as a non-root user (also hit and fixed
  during verification).
- `packaging/linux/package-appimage.sh` -- the distribution-agnostic option (not tied to any one
  packaging ecosystem, closest Linux analog to macOS' double-clickable `.app` UX). Stages an
  `AppDir` (`AppRun` execing the flat package's own launcher unmodified, a `.desktop` file, and a
  placeholder icon synthesized via ImageMagick `convert -size 256x256 xc:"#4a90d9"` since no real
  app-icon asset exists in this repo yet) and builds via `appimagetool`. `appimagetool` is not
  vendored by this repo (no distro-neutral static one-liner install exists) -- downloaded
  directly from `https://github.com/AppImage/AppImageKit/releases/download/continuous/
appimagetool-x86_64.AppImage` to `~/.local/bin/appimagetool` + `chmod +x`, deliberately
  avoiding the AUR (`yay -S appimagetool-bin` was tried first and abandoned -- it hung waiting on
  an interactively-supplied sudo password that the automation had no way to provide; the direct
  GitHub-releases binary needs no root at all).

All three verified end-to-end on the real host, each via its own `--verify` flag, reusing the
shared `packaging/mac/fixture-app` (the same green-page pixel-verified fixture every other
packaging script in this repo reuses) under a real `Xvfb :99`:

- `.deb`: built (133M for `--locales` default/all), extracted via `dpkg-deb -x` (no real
  install/root needed for verification), launcher run from the extracted tree --
  `PACKAGED_APP_VERIFY:PASS`.
- `.rpm`: built (146M), extracted via `rpm2cpio | cpio` (both present on this host; `bsdtar` kept
  as a fallback in the script for hosts lacking `rpm2cpio`), launcher run --
  `PACKAGED_APP_VERIFY:PASS`.
- AppImage: built (178M), run two ways -- `--appimage-extract-and-run` (works without
  `/dev/fuse`, the path used by the script's own `--verify`, matters for CI/sandboxed
  environments that often lack FUSE) AND a direct invocation exercising the real FUSE-mount code
  path (`/dev/fuse` present on this host) -- both `PACKAGED_APP_VERIFY:PASS`.

New `bun run` scripts added to root `package.json`: `pack:linux:deb`, `pack:linux:rpm`,
`pack:linux:appimage` (alongside the existing `pack:linux`). `docs/guide/packaging.md` updated
with a full Linux section matching the existing mac/Windows sections' structure and detail
level. This closes the "True `.deb`/AppImage/rpm distribution packaging is an explicitly
deferred v2 follow-up" gap noted in the Packaging entry above -- that note is now historical
(kept for context on why the flat-directory form shipped first).

Not done: no icon asset ships in this repo yet, so `.deb`/`.rpm`'s `.desktop` `Icon=` fields
reference a name with no backing file (cosmetic -- falls back to a generic icon in most desktop
environments) and the AppImage's icon is a synthesized solid-color placeholder, not real branding
-- both scripts are structured to accept a real icon later (e.g. a future `-c <icon.png>` flag,
mirroring `packaging/mac/package.sh`'s `-c <icon.icns>`) without further changes. Also not done:
no CI job for any of the four Linux packaging forms yet (no `linux-smoke.yml` analogous to
`win-smoke.yml`) -- verification so far is local-only, on this one Arch x64 host.

**x64 bare-metal re-validation + a real bug found and fixed (2026-08-25, Arch Linux x64, no
Docker/VM, bun 1.4.0):** first from-scratch bring-up of this port on a fresh x64 host (all
prior Linux work was arm64 -- Docker on Apple Silicon or bare-metal Debian arm64). Installed
bun + `xorg-server-xvfb` via `pacman` (every other native dep from the Dockerfile's apt list was
already present), fetched `vendor/cef-linux64` via `docker/linux/fetch-cef.sh` (arch dispatch
worked unmodified), built via `native/linux/build.sh`. Full `examples/` sweep: 35/37 immediate
PASS, same two expected non-bugs as arm64 (`color-scheme-live-test.ts` mac-only,
`vite-dev-test.ts` cold-`bunx`-cache) -- 36/37 true pass rate once `bunx` had a warm cache,
matching the arm64 baseline exactly. No new example-level bugs; the port itself is arch-agnostic
as designed.

- **Real bug found: the vendored CEF linux64 (and presumably linuxarm64) minimal distro ships
  `libcef.so` UNSTRIPPED.** `file vendor/cef-linux64/Release/libcef.so` reports "with debug_info,
  not stripped" -- 1.4G on disk, vs. the macOS arm64 framework dylib's already-stripped ~213M
  (Phase 10's own audit). This had gone unnoticed through all prior arm64 Linux work because
  Phase 10's bundle-size pass was scoped to macOS only and never re-run for Linux. Impact was
  large and silent: every dev build (`native/build-linux/`), every packaged app
  (`packaging/linux/package.sh`), and every staged platform-package artifact
  (`scripts/stage-release-artifacts-linux.sh`) was carrying an extra ~1.1GB of DWARF debug info
  for a plain `dlopen`'d shared library nothing debugs at runtime. Fixed in
  `native/linux/build.sh`: `strip --strip-unneeded` on the copied `libcef.so` (not a bare
  `strip`, which can drop `.dynsym` entries some binutils versions still need for a shared
  object) -- `.dynsym`/dlopen-visible exports kept, `.debug_*`/`.symtab`/local symbols dropped.
  Result: 1.4G -> 268M (matches the mac framework's ballpark once accounting for the
  Resources/locales overhead mac's number already includes). Verified no regression: full
  `examples/` sweep re-run post-strip, 36/36 real PASS (1 expected mac-only skip) -- the shim's
  own dlopen of `libcef.so` and every CEF entry point it calls still resolve correctly stripped.
- **Re-staged + re-verified the full Linux release/packaging pipeline post-fix, all real,
  not just no-crash:** `scripts/stage-release-artifacts-linux.sh` now produces a 294M
  `bunium-linux-x64` platform package (was 1.4G+ pre-fix);
  `scripts/verify-platform-package-linux.sh` (installed-consumer simulation, dev tree
  unreachable) -- `PLATFORM-PACKAGE-SMOKE PASS`. `packaging/linux/package.sh` end-to-end app
  packaging + `--verify`, both with `--locales all` (419M) and `--locales en` (371M) --
  `PACKAGED_APP_VERIFY:PASS` both times, real window + pixel-verified paint. This is the first
  time the Linux packaging/staging pipeline has been run+verified on x64 (previously arm64-only)
  and the first time its output size was actually measured (no prior session had checked).

**Linux menu bar shipped via tray-attached dbusmenu (2026-08-26, Arch Linux x64):** `tray.
setMenu()` is now fully real, closing the last Linux tray no-op. Chosen design: serve the
`com.canonical.dbusmenu` wire protocol (the "AppIndicator" convention every SNI-consuming panel
-- GNOME Shell's AppIndicator extension, KDE Plasma, XFCE's indicator-application -- already
knows to fetch and render off a tray's `Menu` D-Bus property), NOT an in-window GtkMenuBar --
`bunium_window_linux.cc` is a raw Xlib window with no GTK/Qt toplevel to attach a widget menu
bar to, and (per the deferred-menu research above) there is still no single cross-desktop
application-level global-menu-bar convention. `Menu.setApplicationMenu()` therefore stays an
honest no-op; only the tray-attached path is real.

- **Real bug found and fixed: `libdbusmenu-glib`'s `DbusmenuServer` is unusable for this
  architecture.** First attempt published the menu object via `dbusmenu_server_new()`/
  `dbusmenu_server_set_root()`. This is wrong: `DbusmenuServer` opens its OWN private GDBus
  connection with its own unique bus name, entirely separate from the tray's raw-libdbus
  `DBusConnection`/well-known SNI bus name (`org.kde.StatusNotifierItem-<pid>-<id>`). Confirmed
  empirically via real `gdbus introspect`/`GetLayout` calls against a running instance: resolving
  the tray's advertised `Menu` object path against the tray's own SNI bus name (exactly what a
  real desktop panel does) got "not a valid bus name" / an empty introspection result, because
  the SNI object and the dbusmenu object lived on two completely different D-Bus connections.
  **The fix:** serve the dbusmenu wire protocol by hand, using raw libdbus
  (`dbus_connection_try_register_object_path` + a hand-rolled `GetLayout`/`Event`/`AboutToShow`/
  `Properties`/`Introspectable` handler, `HandleMenuObjectMessage` in
  `bunium_system_tray_linux.cc`), on the SAME `DBusConnection` the tray's own SNI object already
  uses. `libdbusmenu-glib`'s `DbusmenuMenuitem` (NOT `DbusmenuServer`) is still used, purely as
  an in-memory GObject tree data structure (property bag + child list) in the new
  `native/linux/bunium_system_menu_linux.cc` -- it never publishes itself over D-Bus; only
  `GetLayout`'s hand-rolled serializer (`SerializeMenuItem`) walks it. Menu clicks are delivered
  via the hand-rolled `Event(id, "clicked", ...)` method (pushes a `bunium-menu-click` system
  event), not via dbusmenu-glib's own `DBUSMENU_MENUITEM_SIGNAL_ITEM_ACTIVATED` signal (which
  would require the rejected `DbusmenuServer` to fire in the first place).
- **Verified end-to-end, not just no-crash**, via a new fixture `native/linux/test-tray-menu.ts`
  using real `gdbus call`/`ListNames` (not a fake stub): finds the tray's own registered SNI bus
  name, confirms `Menu`/`ItemIsMenu` properties resolve to a real object path, calls
  `GetLayout(0, -1, @as [])` on that path **using the same bus name as the SNI object itself**
  (the exact check that would have caught the `DbusmenuServer` bug immediately -- it now
  succeeds, since both objects share one connection), confirms the returned layout contains every
  item/submenu/nested-item/separator built via `Menu`, then calls `Event(101, "clicked", ...)`
  and confirms `Menu.onItemClicked` fires in JS with the correct id. `TRAY-MENU PASS`.
- Full `examples/` sweep re-run post-change: 36/37 (same one permanent mac-only skip,
  `color-scheme-live-test.ts`) -- no regressions. `test-tray-click.ts`/`test-tray-set-icon.ts`
  (pre-existing tray fixtures) re-verified passing too, confirming the `bunium_system_tray_
linux.cc` rewrite didn't regress click/icon delivery.
- `native/linux/bunium_system_linux_stub.cc` (the old honest-no-op menu stub) is deleted,
  replaced by the real `bunium_system_menu_linux.cc` above. `native/linux/build.sh` gained
  `dbusmenu-glib-0.4` pkg-config flags; `docker/linux/Dockerfile` and `.github/workflows/
linux-smoke.yml` both install `libdbusmenu-glib-dev`/`libdbusmenu-gtk3-dev`.

**Windows `TaskDialogIndirect` packaged-app manual check: closed out by the user directly, not
a project blocker.** The "verify in a packaged app" follow-up noted under Phase 7 below is the
user's own manual-check item (they have a real Windows desktop to click through it on) --
not re-attempted here.

**Linux CI added (2026-08-26): `.github/workflows/linux-smoke.yml`,** mirroring `win-smoke.
yml`'s structure -- `ubuntu-latest`, installs the same apt package list as `docker/linux/
Dockerfile` (now including `libdbusmenu-glib-dev`), fetches CEF via `docker/linux/fetch-cef.sh`,
builds via `native/linux/build.sh`, runs the full `docker/linux/run-examples.sh` sweep under
Xvfb (fails the job on anything beyond the one known `color-scheme-live-test.ts` mac-only skip),
then packages+verifies the flat-directory form via `packaging/linux/package.sh --verify`.
Triggers on `workflow_dispatch` + `main` pushes + PRs touching `native/**`/`src/**`/`package.
json`/`bun.lock`/`packaging/**`/the workflow file itself, matching `win-smoke.yml`'s own trigger
paths. AppImage packaging is deliberately NOT exercised in CI (would require vendoring
`appimagetool` into the runner image -- kept local-only, same posture as the mac side not
running notarization in CI).

## Phase 7 — Windows port

**Status: multi-process CEF window works (2026-08-20); real system surface +
full example sweep green (2026-08-21).**

`bash native/win/build.sh` (clang-cl only; see `native/win/wrap_direct.sh`) builds
`bunium_shim.dll` + `bunium_subprocess.exe`; `bun examples/basic-window.ts` opens a
window, frames fire, close + shutdown are clean (run it with
`native/build` on `PATH` for dlopen order, see `docs/guide/windows.md`).

Root-caused + fixed the original child-process crash (every GPU/network/storage/
renderer child died with a corrupt-vtable AV at 0xC0000005): the distro's
cmake-built `libcef_dll_wrapper` compiles with `CEF_USE_BOOTSTRAP`, and children
crash when the wrapper has that define. The clang-cl wrapper in `wrap_direct.sh`
(no bootstrap) yields healthy multi-process children. Debug trail: procdump
minidumps → cdb `!analyze`, `/Zi` wrapper build for symbolicated stacks.

### What works

- Browser + subprocess multi-process (renderer/GPU/network/storage all live).
- `bun examples/basic-window.ts` (frames + clean close).
- Full `examples/` sweep (2026-08-21, Windows 11 26100, bun 1.3.11):
   - Window/lifecycle: `close-event`, `loadurl`, `frameless-*`, `resize-plumbing`,
     `resizable-constraints`, `transparent-window`, `basic-window`.
   - Rendering/IPC: `scheme-handler`, `draggable-regions`, `ipc-bounds`,
     `ipc-latency`, `keyboard`, `mouse-click`, `multi-layer`, `raf-cadence-diag`,
     `sublayer-hit`, `dpr-and-screenshot`, `color-scheme`, `scroll-timing`.
   - webview: `webview-{clip,clip-hit,element,hit,stacking}`.
   - typed IPC both directions, `bsdiff`, `update-journal`, `update-e2e`,
     `relaunch`, `vite-dev`.
   - System surface (this session): `system-menu-tray` (submenu fix),
     `system-notifications` (balloons), `system-tray-icon-click` (symbol
     ignored on Windows by design). `system-dialogs` is interactive (modal
     native pickers) — verified manually; the TaskDialog message variant falls
     back to `MessageBoxW` when comctl32 v6 isn't available (no manifest
     in the dev host process).
   - Keyboard fix (real regression): OSR renderer dropped key input until the
     host claimed focus (`SetFocus` at attach + lazily in dispatch) and DOM
     `key` derived from `windows_key_code`, so CHAR events with a zero key code
     now fall back to the character itself (`e.key === 'A'` works again).
   - `vite-dev`: initial serve + post-edit pickup verified. HMR _push_ is
     best-effort — `bunx vite` under the Bun runtime on Windows drives a
     rolldown-vite whose watcher stays silent (OS `fs.watch` fires fine),
     so the test falls back to a plain `loadURL()` reload and warns.
   - Environment-limited: `color-scheme-live-test.ts` is mac-only
     (`defaults`/`osascript`) and stays off the Windows run matrix.
- Real `native/win/bunium_system_win.cc` (menu/tray/notify/dialogs) + shared
  header; spec-driven HMENU app menu per window, NOTIFYICONDATA v4 tray with
  `TrackPopupMenu`, shell-balloon notifications, IFileDialog/TaskDialog on
  detached worker threads (never blocks the JS pump). `comctl32.lib` static
  link avoided (ordinal-import breakage → runtime `LoadLibraryW` + probe).
- Windows smoke CI + mac-side remote runner: `docs/guide/dev-from-mac.md`,
  `.github/workflows/win-smoke.yml` (`PROGRAMFILES` case fixed),
  `scripts/win-remote.sh` (remote `$PATH`/`$HOME` expansion fixed).

### Remaining follow-ups

- Verify `TaskDialogIndirect` end-to-end in a packaged app: `bun.exe.manifest`
  (comctl32 v6) ships with the Windows package now, so the packaged
  `system-dialogs` message path should resolve the real TaskDialog -- needs a
  manual check on a desktop (the dev-tree `MessageBoxW` fallback is by design
  when no manifest is active).
- Packaged-app verification is wired into `win-smoke.yml` + `win-remote.sh
pack` (fixture pixel-check); a packaged Windows app has not yet been run on
  every `examples/` entry (dev-tree sweep only).

## Phase 8 — Packaging, signing, notarization, build pipeline

**Status: macOS packaging implemented + verified (2026-08-17).**

### What works

`bun run pack:mac -a <app-dir> [-n Name] [-i com.example.name] [-o out] [-r repo] [-b bun]
[-v ver] [-c icon.icns] [--no-dmg]` (packaging/mac/package.sh) produces:

- `dist-app/Name.app` with Contents/{MacOS, Frameworks, Resources} -- see the layout
  comment at the top of package.sh for the full tree. The launcher (`Contents/MacOS/Name`)
  exports `BUNIUM_SHIM_PATH`/`BUNIUM_SUBPROCESS_PATH`/`BUNIUM_FRAMEWORK_DIR`/
  `BUNIUM_ROOT_CACHE_PATH` (per-app CEF profile under `~/Library/Application Support/Name/`)
  then execs the bundled bun on `Resources/app/electron/main.ts`; `src/native.ts` reads the
  same env overrides in dev, so one path-resolution codebase serves both modes.
- **macOS helper apps** (`bunium_subprocess (Renderer).app` / `bunium_subprocess
(Alerts).app`, siblings of the main .app): Chromium launches the renderer + the
  notification-alerts utility through per-type helper bundles named after the subprocess
  basename when the main app is bundled (the Google Chrome "Google Chrome Helper
  (Renderer).app" convention). Missing helpers fail the renderer spawn with a silent ENOENT
  (release-build DLOG is a no-op) and the navigation dies with ERR_ABORTED -- this was the
  root-cause of the MachPortRendezvous blocker that stalled this phase. Two constraints
  discovered while fixing:
   - The helper bundle's `CFBundleIdentifier` MUST equal the main app's: the child
     self-derives its `bootstrap_look_up` name (`<BaseBundleID>.MachPortRendezvousServer.
<server-pid>`) from its own bundle id, Chromium does not propagate the browser's
     base-bundle-id here, so a "...Renderer"-suffixed id makes the child look up a name the
     browser never registered (1102 crash loop).
   - `install_name_tool`/otool-classic cannot open a file whose _final path component_
     contains spaces ("bunium_subprocess (Renderer)"); rewrite a no-space temp copy and
     `mv` it into place (the rewritten name is `@loader_path`-relative, so the file is
     location-independent). Same trick class as the existing "Chromium Embedded
     Framework" awk full-line-strip handling.
- Ad-hoc codesign (`codesign --force --deep --sign -`) of the main app AND each helper
  (helpers are siblings, `--deep` on the app doesn't reach them).
- DMG (staging dir = app + helpers, since the helpers must sit next to the app at
  runtime; `hdiutil create` emits a deprecation warning, cosmetic -- switch to
  `diskutil image create from` if it ever stops working).

### Verification

`packaging/mac/fixture-app/` is a nominal app (Vite `dist/` + `electron/main.ts`) that
loads `bunium://app/` and pixel-verifies the page rendered green; exits 0=PASS. The verifier
must poll for the green paint rather than accept the first frame -- the first OnPaint can be
the pre-paint white surface (especially on a cold profile right after packaging). Verified
PASS for: fresh package, cold wiped profile, relocated app + helpers (no absolute-path
leakage), and the dev-tree fixture run (unchanged dev behavior).

### Windows packaging (2026-08-21)

`packaging/win/package.sh` (run on the Windows box -- Git Bash + clang-cl + the
Windows CEF distro + a Windows bun.exe; mac devs drive it via
`scripts/win-remote.sh pack` or the win-smoke CI job) produces a flat `dist-app/Name/`
layout:

- `Name.exe` -- compiled launcher (`packaging/win/launcher.c`, clang-cl,
  /SUBSYSTEM:WINDOWS so there is no console flash). Exports the same BUNIUM_* path
  overrides src/paths.ts reads (SHIM/SUBPROCESS/FRAMEWORK into `Runtime/`,
  `Resources/`, per-app root cache at `%LOCALAPPDATA%\<Name>\CEF`), prepends
  `Runtime/` to PATH so bunium_shim.dll's libcef.dll import resolves (the exact
  dev-recipe search order), then spawns the bundled `bun.exe` on
  `app/electron/main.ts`, inheriting std handles and propagating the exit code (so
  CI/ssh runs see fixture output and its 0/1 verdict).
- `Runtime/` = CEF `Release/` contents (libcef.dll, chrome_elf, ANGLE, d3dcompiler,
  vk_swiftshader, bootstrap crash-dialog exes, locales) + bunium_shim.dll +
  bunium_subprocess.exe. Browser process resolves via PATH; children resolve next to
  their own exe. Windows needs no per-type helper bundles: one subprocess exe serves
  every CEF process type (unlike macOS' (Renderer)/(Alerts) helper apps), confirmed
  by the Phase 7 multi-process sweep.
- `Resources/` = CEF `Resources/` (the resources_dir_path); `--locales` keeplist opt-in.
- `app/` = app dir + materialized (un-symlinked) node_modules/bunium (tar stream, not
  rsync -- Git-for-Windows bash has no rsync).
- `bun.exe.manifest` -- comctl32 v6 SxS dependency embedded next to bun.exe, which is
  the one thing that activates real TaskDialogIndirect in the packaged app. The
  MessageBoxW fallback stays by design for processes with no manifest (dev tree).
  (Deliberately no dpiAwareness element: per-monitor DPI awareness would change
  window-coordinate semantics vs the dev tree.)

Verification: the mac fixture-app doubles as the Windows verifier -- `--verify`
runs the packaged `Name.exe`, which opens a real window, pixel-checks the
limegreen page via the same poll-for-paint logic, prints
PACKAGED_APP_VERIFY:PASS, and exits 0. Wired into `win-smoke.yml` (package +
verify on every PR) and `scripts/win-remote.sh pack`.
Ignored for now (documented, not blocking): Windows distributable signing (TLS
code-signing orientation, needs a cert; nothing needed for local use), custom
.ico launcher icon, NSIS installer.

### Remaining follow-ups (not blocking the local path)

- **Notarization + real signing**: ad-hoc works locally; Developer ID + notarization needs
  Apple credentials (documented as out of scope in package.sh's header).
- **CI**: per-OS runners (can't cross-build a signed DMG from Linux CI); Linux
  packaging still to be written (Phase 8's AppImage or deb/rpm intent). Windows
  packaging is CI-covered (win-smoke) as of 2026-08-21.
- **Windows arm64 (future, not blocking)**: the x64 package already runs on
  arm64 Windows via built-in emulation (Prism). For true native arm64, Parallels
  on an M-series Mac runs arm64 Windows natively (Apple Virtualization
  framework, not a second emulation layer) -- the natural build/test env: real
  hardware, no cross-compile. Recipe when we take it: arm64 CEF distro
  (`cef_binary_*_windowsarm64_minimal.zip`) + clang-cl
  `--target=aarch64-pc-windows-msvc` + bun win-arm64 runtime (verify bun
  publishes one before committing) + `bunium-win32-arm64` package. Win CI then
  adds an arm64 runner step; Parallels stays the pre-CI validation box.
- **Debug env vars added while diagnosing** (keep, env-gated): `BUNIUM_BUNDLE_DEBUG`
  (mainBundle identity dump in browser + subprocess), `BUNIUM_CEF_VERBOSE` (CEF
  log_severity INFO + [paint]/[load-_]/[scheme-_] markers + renderer
  OnContextCreated), `BUNIUM_CEF_SWITCHES` (extra browser command-line switches -- the
  real argv is `bun <script>`, so Chromium's switch parsing never sees post-script args;
  injection via CefMainArgs is the only way to pass them). Also
  `packaging/mac/spawn_interpose.mm` (DYLD_INSERT_LIBRARIES posix_spawn interposer; use
  `__DATA,__interpose` + link-time `&posix_spawn` -- dlsym(RTLD_NEXT) deadlocks or
  recurses inside bun's spawn path) and `packaging/mac/bootstrap_probe.m` for
  inspecting the MachPortRendezvous name the browser registered.

## Phase 9 — Auto-update mechanism

Update server protocol + client updater. Decide delta-patching vs full-download tradeoff.

**Specific concern flagged by the user:** the CEF distribution is large (this project's minimal
macOS arm64 distro alone is ~130MB compressed, more per-platform once all three OSes are
bundled). A small app-code-only patch (the actual `src/`/bundled web assets) forcing a full
re-download of the entire CEF-inclusive package would be a bad update experience. Needs an
**optional lighter-weight updater path** that can ship app-code-only patches without touching the
already-installed CEF binary when CEF itself hasn't changed -- i.e. the updater needs to
distinguish "app layer changed" from "CEF layer changed" and only re-fetch what's different, not
treat every release as one monolithic blob. Design this distinction in from the start rather than
bolting it on after a naive full-bundle updater already exists.

**Inspiration: Electrobun's bsdiff-based updater** (researched 2026-08-16, per user request --
see https://github.com/blackboardsh/electrobun and its docs at
https://framework.blackboard.sh/electrobun/guides/updates). Electrobun (a similar Bun+native-
webview framework, notably also CEF-optional/system-webview-first, the inverse of bunium's
CEF-first stance) ships a **custom Zig-implemented BSDIFF variant with SIMD optimizations**,
producing binary patches as small as ~14KB between consecutive versions, hosted on any static
file host (S3, R2, GitHub Releases) with no update-server backend needed. Worth adopting the same
shape here, adapted to bunium's specifics:

- **bsdiff/bspatch algorithm itself, not the Zig implementation** — bunium is Bun/TS +
  C++/ObjC native, not Zig, so this means either shelling out to an existing bsdiff/bspatch
  binary (e.g. via a small vendored C implementation compiled alongside `native/mac/`, same
  pattern as everything else native in this repo) or a well-maintained npm bsdiff binding —
  evaluate both once this phase starts; don't assume Zig's SIMD-optimized version is portable
  in as-is, it's a from-scratch reimplementation, not a wrapped library.
- **Single-previous-version patch, not a full patch graph.** Electrobun deliberately only
  generates one delta per release (previous → current), falling back to a full compressed
  download for anyone more than one version behind, explicitly as a complexity tradeoff (their
  own docs call this out as a documented limitation, not an oversight). Good default for bunium
  too — a full N-to-N patch graph is a lot of build-time and storage complexity for a benefit
  (multi-version-behind users still get small patches) that matters less than shipping the
  simple version first.
- **Directly reusable, not just "inspiration": the app-layer/CEF-layer split this Phase already
  called for maps cleanly onto bsdiff's strengths.** CEF's own binary essentially never needs a
  byte-level diff against itself (it's swapped wholesale on the rare CEF-version bump, matching
  the "only re-fetch what's different" design goal above) — bsdiff's real value is on the
  small, frequently-changing app layer (bundled `dist/` web assets + any bunium-side native
  dylib rebuilds), which is exactly the artifact Electrobun's 14KB-patch number is about. Treat
  CEF as its own independently-versioned, rarely-updated artifact (whole-file replace when it
  does change) and apply bsdiff specifically to the app-layer archive.
- **Self-extracting/compressed bundle format:** Electrobun uses Zstandard-compressed
  self-extracting bundles for the full-download fallback path. Zstd is a reasonable default to
  adopt for bunium's own full-bundle fallback too (better ratio and speed than gzip for this
  kind of binary+asset payload) — not yet decided whether via a vendored zstd lib or shelling
  out to system `zstd`/`tar --zstd`, revisit when this phase starts.
- **Flat, prefix-based release-artifact naming for static hosts without folder structure**
  (Electrobun's example: `stable-macos-arm64-update.json`) is a good convention to borrow
  directly for GitHub-Releases-as-a-host, since GH Releases assets are a flat namespace per
  release — worth mirroring bunium's own naming scheme (e.g.
  `<channel>-<os>-<arch>-{update.json,patch.bsdiff,full.tar.zst}`) once this phase designs the
  actual manifest format.

**Other Electrobun ideas noted for later phases, not yet scheduled into a specific phase number
(revisit and slot in as those phases start):**

- **Views as a custom scheme** (Electrobun's `views://` for bundled assets) is effectively the
  same mechanism bunium already built in Phase 3 (`bunium://app/`) — already done independently,
  no action needed, just noting the convergent design as validation of the Phase 3 approach.
- **`bundleCEF` opt-in flag** — Electrobun defaults to the _system_ webview (small bundle) with
  CEF as an explicit opt-in for consistency; bunium made the opposite call (CEF-first, per
  `ARCHITECTURE.md`'s Phase 0 decisions) deliberately, for cross-platform rendering consistency
  over bundle size. Not reconsidering that core decision, but worth revisiting bundle-size
  mitigations in Phase 10 (trimming the CEF distro to only what's used) with Electrobun's
  numbers as a rough size benchmark to compare against once bunium has its own bundle-size
  numbers.
- **A typed RPC/webview-tag composition model very close to bunium's own** (`<electrobun-
webview>`, draggable regions, a `BrowserView`-style API, typed IPC) — broadly convergent with
  what Phase 2/the typed-IPC infrastructure entry already built here independently. Worth a
  closer side-by-side API-shape comparison once bunium's public API surface is more locked down
  (post-Phase 4 template expansion), purely to catch ergonomics bunium might be missing — not
  because bunium's design is wrong, just as a sanity check against a project solving the same
  problem.
- **WebGPU-direct native surface (no webview) via a `<*-wgpu>` tag / `bundleWGPU`-style API** —
  interesting for a future "native GPU canvas without a full webview" use case (e.g. games,
  performance-sensitive visualizations), but a genuinely new vertical slice, not a small addon.
  Not scheduled into a phase yet; flag as a candidate Phase 5-adjacent extensibility item
  ("system features" phase) if/when there's a concrete use case, rather than speculatively
  building GPU-surface plumbing now.
- **Self-extracting bundle format for the installed app itself** (not just updates) —
  Electrobun ships apps as self-extracting Zstd bundles rather than a full unpacked directory
  tree, contributing to their ~14MB bundle-size claim. Relevant to Phase 8 (packaging/signing)
  more than Phase 9 — noted here since it was found during the same research pass, revisit when
  Phase 8 starts.

**Status: implemented + verified (2026-08-17).**

### What works

[x] Vendored `mendsley/bsdiff` (BSD-2-Clause, `vendor/bsdiff/`, kept untouched; `.gitignore`
negates that subtree so it stays tracked while CEF stays ignored). Compiled as C objects in
`native/mac/build.sh`; the `BSDIFF_EXECUTABLE`/`BSPATCH_EXECUTABLE` paths (bzlib) are never
compiled.
[x] Flat-C-ABI shim bridge `native/mac/bunium_bsdiff_wrap.mm` — `bunium_bsdiff` /
`bunium_bspatch` / `bunium_bsdiff_patch_info` (≤3 args each), each taking file paths,
handling the 24-byte header (magic `ENDSLEY/BSDIFF43` + 8-byte LE size) that the vendored
lib leaves to its executable main. Bindings in `src/native.ts`; typed wrapper in
`src/bsdiff.ts`. Two gotchas fixed during the build: the vendored headers name a parameter
`new` (C++ keyword — rename-define around the include), and upstream's stream-write
callback contract is return-0-success (a byte-count return made `writedata` fail).
[x] `src/tar.ts` — deterministic ustar writer/reader (sorted entries, dirs first, mtime=0,
uid/gid=0, fixed modes, POSIX paths, two zero-block terminator) + `collectDirectory`
tree-walker. Byte-identical between runs, verified.
[x] `src/update.ts` — `updater.check/install/relaunch`, `isUpToDate`, typed discriminated-union
event emitter (`checking`/`downloadStarted`/`progress`/`applying`/`ready`/`relaunching`/
`error`). Manifest at `<channel>-<os>-<arch>-update.json`; prefers `patch.bsdiff` only when
`currentVersion == fromVersion`, else `full.tar.zst` (zstd via `Bun.zstd*Sync`). Patch
path re-tars the _installed_ tree with the same deterministic writer (byte-equal to the
build side), validates the patch header against `manifest.fullSize` and sha256 before
applying, then stage-+rename-swaps into place with backup restore on failure. Never
touches CEF (separately-versioned artifact by design).
[x] Release CLI `scripts/release.ts` (`bun scripts/release.ts --old <prev-dist> --new
    <cur-dist> --out <dir> ...`) emits the flat artifact set; deterministic — two runs
produce identical sha256s (verified). Wired as `bun run release:update`.
[x] Verification: `examples/bsdiff-test.ts` (round-trip + corrupt/truncated header rejection,
headless) and `examples/update-e2e-test.ts` (full flow over a local HTTP static host:
patch path, full fallback when >1 version behind, up-to-date, and corrupt-patch
recoverable failure leaving the install untouched). Both PASS.

- **Swap-crash journal + self-repair (2026-08-18):** the two-rename swap is now
  journaled (`<installDir>.updating` records the staging path before the first
  rename). `repairInterruptedUpdate(installDir)` (exported from `src/index.ts`,
  also invoked defensively at the top of every `install()`) resolves every
  intermediate crash state — staged tree present → roll forward (old backup
  dropped, install left clean); staging lost + backup present + install missing →
  roll back; install already live → just finish cleanup; corrupt/unreadable
  journal falls back to backup semantics. Verified headlessly across all six
  states (`examples/update-journal-test.ts`, covers roll-forward, roll-back,
  pre-rename crash, post-commit crash, corrupt journal, and no-journal no-op);
  `examples/update-e2e-test.ts` + `examples/relaunch-test.ts` still PASS.
- **Packaged-app restart wired (2026-08-18):** new `src/relaunch.ts` —
  `relaunchApp()` (shuts down CEF, then re-execs the same `process.execPath` +
  `process.argv[1..]` the launcher originally ran, so `package.sh`'s launcher needs zero
  changes) + `buildRelaunchCommand()` (pure, testable). The one constraint that makes
  this non-trivial: CEF's per-profile ProcessSingleton aborts a second concurrent
  browser, so a detached `sh` shim waits (`kill -0` polling) for the parent PID to die
  before `exec`-ing the app. **Real bug found + fixed while testing:** the shim's poll
  interval was passed to `sleep` as-is (ms), but POSIX `sleep` takes _seconds_ — a
  200ms default silently became a 200-second sleep between polls. Pass fractional
  seconds (`toFixed(3)`); macOS/Linux `/bin/sh sleep` both accept fractions. Also
  `updater.relaunch(handler)` now threads the installed dir through (`relaunching`
  event payload + handler arg — it previously emitted `{dir: ""}` dead weight), and
  the whole Phase 9 surface is exported from `src/index.ts` (`updater`/`Updater`/
  `relaunchApp`/`buildRelaunchCommand` + types — previously the updater was not part of
  the public package API at all). App wiring is one line in `electron/main.ts`:
  `updater.on("ready", () => updater.relaunch(relaunchApp))`. Verified headlessly via
  `examples/relaunch-test.ts` (wait-for-death timing, dead-parent immediate exec, argv
  fidelity incl. space-containing args) — the real quit-then-relaunch of a packaged app
  still needs a desktop session (same interactive-gap category as tray clicks).

### Remaining follow-ups (not blocking)

- Server-side feed CI: publishing the three artifacts is manual (`release:update`).

## Phase 10 — Performance & bundle size pass

**Progress (2026-08-17):**

- [x] **CEF resource trim, built into `packaging/mac/package.sh` (default ON).** Measured
      baseline packaged app: 401M total — 213M framework dylib (already arm64-only, no
      fat-binary waste) + 23M `Libraries/` + 81M framework `Resources/`, of which **49M was
      ~130 per-locale `*.lproj` dirs** (each ~1M, mostly `locale.pak`) and the rest
      `resources.pak` (17M, needed), `icudtl.dat` (10M, needed), `v8_context_snapshot`
      (needed), chrome paks (needed). Trim: strips all `*.lproj` except the `--locales`
      keeplist (default `en`), removes the SwiftShader software-Vulkan stack
      (`libvk_swiftshader.dylib` 16M + `libvulkan.dylib` + `vk_swiftshader_icd.json` —
      macOS always has Metal; ANGLE's Metal backend serves the GPU process, SwiftShader is
      only for exotic software-Vulkan), removes the regenerable `gpu_shader_cache.bin`
      (1M), and `.DS_Store` junk. **Result: 401M → 335M (-16%)**, DMG 161M. Opt-outs:
      `--no-trim` (full original CEF) and `--locales all` (keep every locale).
- [x] Verified trimmed apps end-to-end AFTER trimming with the same green-pixel verifier
      (`packaging/mac/fixture-app`, which tests the exact prod path): PASS both for the
      freshly-packaged `.app` and for a hand-trimmed copy (re-signed). Also verified
      `--locales all`/`--no-trim` produce the original 401M app. Chromium falls back to
      en-US strings when a locale's `.lproj` is absent, so a trimmed app runs fine — just
      with untranslated browser chrome (context menus, alert dialogs).

**Phase 10 closed for macOS (2026-08-18).** Remaining three items done:

- [x] **CEF dylib binary audit — nothing safely strippable.** `size -m`/`otool -l`: 188M of
      the 214M is `__TEXT,__text` (real Chromium machine code); `__LINKEDIT` is only 2.1M
      (1808 exported symbols, zero local-symbol bloat); zero `__DWARF` sections; already
      arm64-only. Any further cut means structural changes (shared-code dedup across
      processes) — out of scope, not trim. The earlier 401M→335M trim was the practical
      ceiling.
- [x] **Lazy-loading review of `src/` — the `zstd` worry was wrong, nothing to change.**
      `src/update.ts` uses `Bun.zstdDecompressSync`, a Bun _runtime global_, not an import —
      there is no eager zstd module load to defer. Whole `src/` import graph is node
      builtins + internal modules only; `src/index.ts` re-exports are the framework's
      public API by design. No lazy-import work warranted.
- [x] **Paint-path latency re-benchmarked (2026-08-18, `BUNIUM_CEF_VERBOSE=1`, real window,
      `examples/scroll-timing-test.ts`):** 90 frames in 1503ms — **avg inter-frame gap
      16.61ms (~59.9fps effective), max 26.42ms**, vs the pre-Phase-8 baseline ~17.4ms.
      Paint path healthy after Phases 8/9 native/relaunch work; no regression.

Phase 10 complete for macOS.

**Phase 10 extended to Linux + Windows (2026-08-26, Arch Linux x64):**

- [x] **Linux `packaging/linux/cef-trim.sh` (new file, default ON in `packaging/linux/
  package.sh`, `--no-trim` to opt out) removes the same SwiftShader software-Vulkan
      stack mac already trims** -- confirmed present in the vendored `vendor/cef-linux64/
  Release/` distro (`libvk_swiftshader.so` 14.2M, `libvulkan.so.1` 1.4M,
      `vk_swiftshader_icd.json` 107B), same three-file trio as mac's `.dylib`/`.json` set,
      `.so` extension instead. Checked for a Linux equivalent of mac's regenerable
      `gpu_shader_cache.bin`: none exists in this distro layout (nothing under `Release/`
      or `Resources/` named similarly), so there is nothing else to remove on that front.
      Verified via a full `packaging/linux/package.sh --verify` run against the shared
      `packaging/mac/fixture-app` under Xvfb post-trim: `PACKAGED_APP_VERIFY:PASS`. Note:
      `native/linux/build.sh`'s own dev-tree output (`native/build-linux/`) never copies
      the SwiftShader stack there in the first place (only `libcef.so`/`icudtl.dat`/the V8
      snapshot/paks/locales), so this trim is a real no-op against today's dev/packaged
      builds and mainly exists so a future build.sh change that DOES copy those files stays
      trimmed automatically, and so the flag surface (`--no-trim`) matches mac/Windows for
      consistency.
- [x] **Windows `packaging/win/cef-trim.sh` (new file, default ON in `packaging/win/
  package.sh`, `--no-trim` to opt out), implemented by inference from the mac/Linux
      SwiftShader trio's standard CEF distro naming** (`vk_swiftshader.dll`,
      `vulkan-1.dll`, `vk_swiftshader_icd.json`) -- **NOT verified against a real vendored
      Windows CEF distro**, since this dev box (Arch Linux x64) has no `vendor/
  cef-windows-x64/` to check filenames against (Windows packaging only ever runs on a
      real Windows host, per `packaging/win/package.sh`'s own header). `rm -f` on each
      candidate filename fails safe if a name is wrong (no-op, not an error), so this
      cannot break an existing packaging run even if unverified. Flagged in this file's own
      header comment as implemented-but-unverified-on-real-Windows; the user verifies
      Windows-side things manually per their own stated workflow -- this is a documented
      caveat, not a blocker.

## Phase 11 — Public package + docs

npm package for the framework, separate boilerplate/template repo. Docs site built with
**VitePress** — API reference generated/kept in sync with the `src/` public exports (all typed
per the standing requirement above, so this is mostly transcription not invention), plus guides
(getting started, webview tag usage, packaging). Start once Phase 1-4 APIs have stopped churning
weekly — building docs against a moving target wastes the effort twice.

**Progress (2026-08-18): docs site built and verified.** `docs/` is a VitePress site
(`docs/package.json` + `docs/.vitepress/config.ts`), wired as `bun run docs:dev` /
`bun run docs:build` (note the `--cwd=docs` flag form — `bun --cwd docs run ...`
parses the flag wrong and dumps usage). Pages: `index.md` (status overview),
`guide/{getting-started,window,ipc,webview,system,packaging,updates,publishing}.md`,
`api/index.md` (transcribed from `src/index.ts` public exports, all typed). One real build
bug caught: raw `<bunium-webview>` inside an api-reference table cell is parsed by
VitePress/Vue as an unterminated HTML element — must be escaped as `&lt;bunium-webview&gt;`
(headings + code blocks are fine, inline table cells are not).
`bun run docs:build` passes clean.

**Progress (2026-08-18): npm half unblocked for run-time resolution + local artifact
pipeline; license + CI release pipeline landed; publish gated on credentials.** The
npm package still can't ship the native bits in its tarball, so the published
package now resolves them from a platform-scoped sibling, and a verified local
pipeline produces it:

- [x] **`src/paths.ts` — artifact resolution for installed consumers.** Each of
      `BUNIUM_SHIM_PATH`/`BUNIUM_SUBPROCESS_PATH`/`BUNIUM_FRAMEWORK_DIR` resolves
      independently: env override → dev tree → platform package
      `bunium-<platform>-<arch>` (e.g. `bunium-darwin-arm64`) found via
      `import.meta.resolve` in the consumer's node_modules, laid out as
      `shim/{bunium_shim.dylib,bunium_subprocess,ANGLE libs}` +
      `framework/Chromium Embedded Framework.framework` (trimmed). Shim +
      subprocess CEF install name rewritten to `@loader_path/../framework/...` so
      artifacts are location-independent. `BUNIUM_NATIVE_PACKAGE` overrides the
      package name for testing. `src/native.ts` now re-exports `paths` from it;
      `app.ts`/`dlopen` consumers unchanged.
- [x] **Verified installed-consumer end-to-end** (not just unit):
      `scripts/verify-platform-package.sh` builds a consumer sandbox
      (`dist-release/_consumer/`: materialized `bunium` + staged platform package,
      no dev tree reachable) and runs a real window + paint, pixel-verifying a
      green page — PLATFORM-PACKAGE-SMOKE PASS.
- [x] **`scripts/stage-release-artifacts.sh` (`bun run release:artifacts`)** —
      stages `dist-release/bunium-darwin-arm64/` (trimmed CEF + shim + subprocess +
      ANGLE, `os`/`cpu`-guarded `package.json`) + `bunium-darwin-arm64-<version>.tar.gz`;
      unterminated vendored absolute install names re-aimed via otool extraction.
      Staged size: 260M (~335M app minus app/bun/helper overhead), matches the
      Phase 10 trim results.
- [x] **CEF trim extracted to `packaging/mac/cef-trim.sh`** — shared by `package.sh`
      (old inline block replaced; re-verified: fixture pack = 335M, PACKAGED_APP_VERIFY
      PASS) and the stage script. No behavior change to packaging.
- [x] **Publish metadata prepped**: root `package.json` gains `exports`, `files`
      (src/ + LICENSE only — `vendor/` can never enter the tarball), `engines`
      (bun >= 1.0); `create-bunium-app` gains `files` + `engines`. Both remain
      `"private": true` until publish.
- [x] **License** — MIT, `LICENSE` added, `"license": "MIT"` in both
      `package.json`s; `files` already whitelists it for the npm tarball.
- [x] **CI release pipeline** — `.github/workflows/release.yml` (tag `v*`,
      macos-14 arm64): downloads the vendored CEF distro
      (`cef_binary_<version>_macosarm64_minimal.tar.bz2`, sha1-pinned via
      `CEF_SHA1`), builds `libcef_dll_wrapper` via cmake, then
      `build:native:mac` + `release:artifacts` + the installed-consumer verify,
      and attaches the archive to a GitHub Release. Provenance + URL resolved:
      CMakeCache shows the original distro was the canonical spotifycdn
      `macosarm64_minimal` build; the old `downloads/cef_binaries/<version>/`
      URL prefix 404s (index.json URLs stale) but the flat
      `https://cef-builds.spotifycdn.com/cef_binary_<version>_macosarm64_minimal.tar.bz2`
      works and serves the pinned sha1.
- [x] **Linux (Phase 6) / Windows (Phase 7) platform packages** — extended the
      darwin-only mechanism to all three platforms now that both ports exist:
      `scripts/stage-release-artifacts-linux.sh` (pre-existing) plus new
      `scripts/stage-release-artifacts-win.sh` staging `dist-release/bunium-win32-x64/
    {shim/,framework/}`, with `framework/locales/` placed directly under
      `framework/` (not under a `Resources/` subdir) to match `bunium_shim.cpp`'s
      Windows `locales_dir_path` derivation and `src/paths.ts`'s
      `platformPackagePaths()` (`resourcesDir === frameworkDir` on win32); no
      install-name rewrite needed on Windows (DLL search order handles it).
      New `scripts/verify-platform-package-win.sh` mirrors the mac/Linux verify
      script but **copies** the staged package into the consumer fixture instead
      of symlinking (NTFS symlinks need elevated privilege), reusing the shared
      `verify-platform-package-main.ts` fixture. Root `package.json` gains
      `release:artifacts:linux` / `release:artifacts:win` scripts and
      `bunium-linux-x64` / `bunium-win32-x64` as pinned `0.0.1`
      `optionalDependencies` alongside `bunium-darwin-arm64`.
      `.github/workflows/release.yml` split from one macOS-only job into three
      parallel jobs (`darwin-arm64` unchanged; `linux-x64` mirroring
      `linux-smoke.yml`'s apt deps + `docker/linux/fetch-cef.sh` +
      `native/linux/build.sh`; `win32-x64` mirroring `win-smoke.yml`'s
      clang-cl-via-chocolatey + `CEF_ZIP_URL` fallback + `native/win/build.sh`),
      each running its staging script then its verify script. `docs/guide/
    publishing.md` rewritten to document all three platform layouts and the
      3-job pipeline. Caveat: the Windows scripts are implemented but, like
      `packaging/win/cef-trim.sh`, unverified on a real Windows machine — the
      `win32-x64` job in `release.yml` will be their first exercise on an actual
      Windows runner.
- [ ] **Publish** — `bunium` + all three platform packages
      (`bunium-darwin-arm64`, `bunium-linux-x64`, `bunium-win32-x64`, from their
      staged dirs) + `create-bunium-app`; remove `private`. Needs npm
      credentials (user); tag `v0.0.1` first to exercise the now-3-job
      release.yml.

## Post-Phase-11 — full macOS smoke sweep + bunium vs Electron benchmarks (2026-08-27)

- [x] **Full macOS smoke sweep, real hardware.** 37/37 `examples/*.ts` PASS
      (`scripts/run-examples-mac.sh`, new). All 6 `create-bunium-app`
      templates PASS end-to-end (scaffold → `bun link bunium` → install →
      build → prod-mode window+paint via `create-bunium-app/verify-prod.ts`;
      `scripts/smoke-scaffolds-mac.sh`, new). Two real bugs found and fixed
      along the way: (1) the three TS templates (`solid-ts`/`react-ts`/
      `vue-ts`) referenced `"types": ["bun-types"]` in their own
      `tsconfig.json` but never listed `bun-types` as a devDependency —
      builds failed immediately on a fresh install; (2) `bun-types` >=1.4
      widened `FFIType.ptr`'s return type from `Pointer` to `Pointer |
      bigint`, breaking typecheck for `src/window.ts`/`src/system/menu.ts`/
      `src/system/tray.ts` (root repo's own lockfile pins 1.3.14 so this was
      invisible there) — fixed with a small `asPointer()` narrowing helper
      in `src/native.ts` at each FFI-ptr-returning call site, forward-
      compatible with the wider bun-types union rather than pinning down.
- [x] **`mac-smoke.yml` CI hang/crash chain, fully root-caused.** Three
      distinct bugs in sequence, each found by actually reading the CI log
      rather than assuming: (1) the packaged-fixture-app verify step never
      got the `BUNIUM_CEF_SWITCHES=--disable-gpu` env the dev-mode smoke
      step already had, so it hung indefinitely on GitHub's GPU-less
      macos-14 runners; (2) even with that env set, `basic-window.ts` itself
      hit a genuine `EXC_BREAKPOINT` (release CHECK trap) inside CEF's own
      `ThreadPoolBackgroundWorker`, confirmed via running the step under
      `lldb -b -o run -o "bt all"` — stripped framework binary, no symbols
      beyond the crashing frame, reproduces only on this GPU-less/software-
      composited CI VM (37/37 examples pass clean, repeatedly, on real
      hardware) — marked `continue-on-error: true` with the finding
      documented inline rather than chased further (would need a
      symbolized CEF build); (3) the packaged-app verify binary can hang on
      shutdown *after* already printing its `PACKAGED_APP_VERIFY:PASS`
      verdict (same background-CHECK class) — fixed by polling the log for
      the verdict marker and killing the process once seen, instead of
      waiting on natural exit. CI is green as of this writing.
- [x] **bunium vs Electron benchmark suite** — `benchmark/` (new): a
      `bunium-minimal`/`electron-minimal` pair (identical inline-HTML
      window) and a `bunium-mini-app`/`electron-mini-app` pair (identical
      dashboard UI — `benchmark/shared/{index.html,app.js}` is the literal
      same file loaded by both hosts, only the IPC bridge glue differs),
      `benchmark/scripts/{bench.ts,report.ts}` (spawns each app, parses
      `BENCH:` milestone lines, samples RSS/CPU across the *entire* process
      tree — CEF/Chromium both fan out into helper processes, a single-PID
      sample undercounts). Results + full methodology in
      `benchmark/RESULTS.md`, published at `/guide/benchmarks` on the docs
      site. Headline finding: bunium's idle CPU (~56% of one core) and IPC
      round-trip latency (~12ms vs Electron's ~0.2ms) both trace to one
      cause — `src/app.ts`'s `startPumpLoop` drives CEF's message loop off
      an unconditional fixed 8ms `setInterval` rather than integrating with
      the OS's native run loop the way Electron does. **Real optimization
      opportunity for a future phase**, not fixed as part of this
      benchmarking pass: an adaptive interval, or wiring the pump to a real
      CFRunLoop/epoll/IOCP wakeup source instead of blind polling, would
      likely close most of the CPU/latency gap. Everything else (startup
      time, RSS, DOM render cost, on-disk framework size, Bun's ~5.8x
      faster process boot than Node's) benchmarks about how you'd expect.
      macOS arm64 only so far, one machine, 3 reps/scenario.

## Post-Phase-11 — "beat Electron on every macOS benchmark" pass (2026-08-28)

User directive: close every benchmarked gap vs Electron, macOS first
(Linux/Windows to follow in later sessions). Full plan + research at
`/Users/erfanmola/.claude/plans/noble-seeking-rabin.md`; full before/after
numbers and methodology in `benchmark/RESULTS.md`'s "Round 2" section.
Verified after every change: 37/37 `examples/*.ts`, 6/6
`create-bunium-app` scaffolds, no regressions.

- [x] **Adaptive CEF message pump.** `settings.external_message_pump = true`
      (`bunium_shim.cpp`) + `BuniumApp::OnScheduleMessagePumpWork`
      (`bunium_common.h`, stores the requested wake deadline in an atomic,
      thread-safe per CEF's "may be called from any thread" contract) +
      new `bunium_get_next_pump_delay_ms()` ABI function + `src/app.ts`'s
      `startPumpLoop` rewritten from a fixed 8ms `setInterval` to a
      self-rescheduling `setTimeout` sized by what CEF actually requested
      (floor stays 8ms — see below for why it wasn't raised). Deliberately
      NOT a native→JS async callback (bun:ffi `JSCallback` fired from an
      arbitrary CEF thread) — that's the theoretically-zero-poll design but
      carries real new FFI-threading risk this codebase has been burned by
      before (`ARCHITECTURE.md` §15/§18); the bounded-polling design gets
      most of the win with no new threading surface. **Result: IPC
      round-trip latency 11.9ms → 2.5ms (~4.3x), still behind Electron's
      0.2ms but no longer an order of magnitude off.**
- [x] **Disabled Chromium's spare-renderer-process feature**
      (`--disable-features=SpareRendererForSitePerProcess` in
      `OnBeforeCommandLineProcessing`, merged with whatever
      `disable-features` CEF already set rather than clobbering it — verified
      via `ps` that the merge actually worked). A bunium window's one
      navigation is known at creation time; there's no "next tab" to
      pre-warm a spare renderer for. Found by directly diffing bunium's vs
      Electron's real process trees via `ps` (not guessing) — Electron's own
      renderer already disables this feature. **Result: process count 6→5,
      now matches Electron exactly; minimal-app idle RSS flipped to beat
      Electron for the first time (403MB vs 418MB); mini-app RSS gap closed
      ~80% (-81MB → -16.5MB).**
- [x] **Investigated and ruled out, with evidence, two dead ends** (worth
      recording so they aren't re-investigated blind next time): (1)
      "mirror Electron's default Chromium switches" — dumped Electron 44's
      actual renderer/gpu/utility command lines via `ps`, they're nearly
      identical to bunium's aside from Chromium-internal defaults neither
      app sets explicitly; Electron doesn't disable background services by
      default either, so there was no switches-based lever to copy. (2) "CEF
      chrome_runtime full-browser overhead" — a contaminated shared CEF
      profile (this session killed a lot of test processes hard, leaving
      unclean-shutdown state) once showed bunium loading
      `chrome://new-tab-page` + initializing a UKM database/top-sites/
      segmentation-platform on startup, which looked like a smoking gun;
      re-verified against a clean profile and confirmed it was
      session-restore after the unclean shutdown, not baseline behavior.
- [x] **Round 2 (same day): user pushback — "beat Electron in all, not
      tie."** Went back in for process count specifically (was tied 5=5,
      not beaten) and idle CPU. Two more real, shipped, verified changes:
      **merged Chromium's GPU service into the browser process**
      (`--in-process-gpu` — GPU compositing was already disabled for the
      CPU-readback OSR path, so the isolated GPU process was pure overhead
      with no remaining security benefit; tested `--single-process` too,
      which also works and drops to 1 process, but rejected as unsafe
      since it merges the *renderer*, Chromium's real security boundary
      against untrusted content `<bunium-webview>` can load). **Result:
      process count 5→4, genuinely below Electron's 5** (not tied), and
      RSS followed on both app shapes: minimal-app RSS 403→365MB (beats
      Electron's 418MB by ~13%), mini-app RSS 467→430MB (newly beats
      Electron's 451MB — a whole extra OS process is real memory). 5 of 8
      benchmarked metrics now beaten outright: disk size, Bun-vs-Node
      boot, process count, and idle RSS on both app shapes.
- [x] **`--in-process-gpu` reverted per explicit user request**, right
      after landing and verifying it. GPU service is back in its own
      isolated process. Process count returns to 5 (tied with Electron,
      not below); mini-app RSS returns to trailing Electron (minimal-app
      RSS still wins — that one's carried by the spare-renderer disable,
      not the GPU merge). Current standing: **3 of 8 metrics beaten
      outright** (disk size, Bun-vs-Node boot, minimal-app RSS), 1 tied
      (process count), 3 behind (mini-app RSS, startup, IPC latency —
      idle CPU fixed in Round D2 below). The `--in-process-gpu`
      investigation and safety reasoning
      (verified clean, safer than `--single-process`) stay documented in
      `benchmark/RESULTS.md` since they're still real findings, just not a
      shipped default.
- [x] **Idle CPU, Round D (same day): user rejected "architectural limit"
      as an answer, demanded real root-causing — got real symbols, found
      and fixed one named cause, precisely identified a second.** Prior
      rounds (black-box `sample` against the stripped vendored CEF binary)
      produced only circumstantial conclusions — confirmed via `nm` that
      the nearest exported symbol `sample` was resolving to sat **27MB**
      from the true call site. Downloaded CEF's real `release_symbols`
      dSYM package (aria2 `-x16` for usable throughput — single-connection
      curl against CEF's CDN caps at ~300-500KB/s, aria2 hit ~40MB/s),
      UUID-verified it matches the vendored framework, co-located it so
      `sample`/`lldb` auto-resolve real symbols. Result: a
      `ThreadPoolForegroundWorker` thread's entire sampled window was
      inside `base::mac::ProcessRequirement::{ValidateProcess,
      GatherMetrics}` — real macOS code-signature validation, Chromium's
      Mach port rendezvous peer-validation feature
      (`MachPortRendezvousValidatePeerRequirements`/
      `MachPortRendezvousEnforcePeerRequirements`, disabled by default
      upstream, active in this CEF build's field-trial config). **Fixed
      and shipped** (`OnBeforeCommandLineProcessing`,
      `bunium_common.h`) — idle CPU 58-60%→50-51%, repeatable across 6+
      runs, verified against 37/37 examples + 6/6 scaffolds. Then captured
      a Perfetto trace (`--trace-startup`, CEF's tracing infra already
      compiled in) for a task-level breakdown finer than stack sampling
      can give: `SequenceManagerImpl::SelectNextTask` fires ~4143/sec on
      the browser's main thread but only ~439/sec of those calls actually
      run a task (`ThreadControllerImpl::RunTask`) — isolated whether
      Phase-1's `external_message_pump=true` causes this (temporarily
      reverted to `false`: `SelectNextTask` dropped 6.2x with `RunTask`
      unchanged, but **measured CPU% didn't move either way** — the empty
      polling is real but cheap, not the actual driver; kept
      `external_message_pump=true` for its real IPC-latency win). Queried
      what actually runs inside `RunTask` by `task.posted_from` source
      file: **Chromium's own internal `StackSamplingProfiler`
      (`base/profiler/stack_sampling_profiler.cc`) is ~28% of real task
      executions** — confirmed by exact source file, not inferred. Four
      disabling attempts (feature flags, metrics/field-trial disables,
      combined with breakpad/crash-reporter/HangWatcher) had zero measured
      effect — not gated by any command-line switch in this build.
      `chrome/common/stack_sampling_configuration.*` (the file that
      decides whether it runs) 404/403'd on both
      `chromium.googlesource.com` and `source.chromium.org` this
      session — identified, not yet fixed. Full trace-query breakdown
      table (Mojo/IPC dispatch ~29%, `KeyedServiceFactory`, real SQLite
      `Database::*` activity) in `benchmark/RESULTS.md`.
- [x] **Idle CPU, Round D2 (follow-up session, 2026-08-30): the real fix,
      56-59%→~3%.** Tested the `StackSamplingProfiler` hypothesis directly
      via the real command-line switch (`--disable-stack-profiler`,
      distinct from the feature-flag form already ruled out) against the
      existing prebuilt CEF — zero measured effect; task-count share
      (~28%) didn't translate to CPU-time share. Same null result for
      `--disable-background-networking`. A fresh symbolicated `sample`
      capture found the real culprit: `base::mac::ProcessRequirement::
      {ValidateProcess,GatherMetrics}` again — same symbol as Round D's
      fix, but reached via a *different*, independent entry point
      (`MaybeGatherMetrics()`) gated by a *third* feature Round D never
      touched: `GatherProcessRequirementMetrics` (pure UMA telemetry, no
      functional purpose for a non-metrics-reporting embedder). Verified
      59.4%→3.0% via the switch, then shipped as a third
      `disable-features` entry in `bunium_common.h`, rebuilt, reconfirmed
      with no env override (~2.6%), 37/37 examples green. Full writeup:
      `benchmark/RESULTS.md` Round D, memory `project_bunium_idle_cpu_fixed`.
      A full CEF-from-source rebuild was started first (to patch
      `ThreadProfilerClient` directly) and got as far as a complete,
      exact-commit-matched Chromium sync — abandoned once the switch test
      proved that particular patch wouldn't have helped; the synced tree
      is kept as a reusable asset (`project_bunium_cef_source_build`
      memory) for any future from-source CEF need.
- [ ] **Startup time (~300-330ms vs Electron's ~160-200ms, unchanged) — no
      bunium-specific inefficiency found, investigated twice.** Every
      window-creation FFI call is a single synchronous native call with no
      extra IPC round trips. Profiled the 0-1s startup window specifically
      (separate from the idle-CPU steady-state profiling above) and
      confirmed the two costs are unrelated — startup-window activity is
      dominated by waiting/blocked threads, not the same BEST_EFFORT
      pattern seen later. The ~300ms is `CefInitialize()` itself loading
      the CEF framework and spawning its (now smaller, 4-process)
      subprocess tree, versus Electron's single precompiled executable. No
      lever found in either investigation pass.
- **Scope note:** this pass was macOS-only per the user's own request
  (Linux/Windows to be run by the user separately). The shipped native
  changes live in `native/mac/bunium_shim.cpp` / `bunium_common.h`, which
  compile unchanged into the Linux/Windows builds too (per
  `native/linux/build.sh`/`native/win/build.sh`) — so those platforms
  should inherit at least the IPC-latency and process-count wins once
  rebuilt there, but this was **not verified** on Linux/Windows this
  session.

## Post-Phase-11 — benchmark suite verified on Linux (2026-08-31)

- [x] **`benchmark/` run for real on Linux for the first time** (bare-metal
      x86_64 Arch Linux, no Docker) — the "should just work, unverified"
      posture `docs/guide/benchmarks.md` previously documented is now
      verified. Built CEF `linux64` + the shim from a clean checkout
      (`docker/linux/fetch-cef.sh` then `native/linux/build.sh`, no script
      changes needed), `bun link`/`bun link bunium`, `bun install` for the
      two `electron-*` apps. **Real environment gotcha found:** this host
      has no Node/npm at all, only Bun — `bun install` skips npm lifecycle
      scripts by default, so the `electron` package's real binary never
      got downloaded automatically; fixed per-app by running
      `bun run node_modules/electron/install.js` once manually. Not a
      bunium bug, just a Bun-as-sole-package-manager quirk worth knowing
      for any future from-scratch Linux setup (CI or otherwise).
      `BENCH_REPS=5 BENCH_IDLE_SECONDS=6`, 20/20 reps clean. Full numbers
      and analysis in `benchmark/RESULTS.md`'s "Linux results" section;
      short version: **bunium wins paint time/RSS/process-count outright
      on this run** (opposite shape from macOS, where Electron wins those
      three), **idle CPU is a genuine 0%/0% tie** — confirmed via `ps`
      that the mac idle-CPU fix's `disable-features` flags
      (`GatherProcessRequirementMetrics` etc., shared `bunium_common.h`)
      are present on the real Linux subprocess command line and that CPU
      `TIME` stays flat across a 5s sampling window — and IPC latency
      still favors Electron by a similar margin to mac (no Linux-specific
      IPC work done). Framework/runtime on-disk size is the one metric
      that flips vs mac (Linux's raw CEF dev-tree build is larger than
      this Electron build's `dist/`), but that comparison isn't apples-to-
      apples yet — mac's number is a *packaged, trimmed* `dist-release/`
      artifact and Linux has no packaging/trim pipeline to produce the
      equivalent from yet (see Phase 8/10 Linux follow-ups).
- [x] **"SIGTERM crash-loop" investigated and root-caused (2026-08-31) —
      not a bunium bug, no code fix needed.** The original finding above
      (zygote termination-status errors → network service restart →
      repeated GPU process launch failures → fatal "GPU process isn't
      usable") came from an ad hoc `timeout <N> bun run main.ts` sanity
      check, not the real harness. Root cause, confirmed via `ps -o
      pid,pgid`: GNU `timeout` (without `--foreground`) puts its child in
      a *new process group* and sends the timeout signal to the *whole
      group at once* — every `bunium_subprocess` helper (zygote/GPU/
      network/renderer) dies simultaneously alongside the main browser
      process, so helpers vanish mid-shutdown out from under the browser
      process's own orderly `CefShutdown()`. Confirmed three ways: (1)
      `timeout --foreground` (no new process group) is clean; (2) the real
      harness (`child_process.spawn` + `child.kill("SIGTERM")`, which only
      signals the root PID) never reproduces it, across the full 20-rep
      benchmark session; (3) **the identical `timeout` command against
      `electron-minimal` reproduces the exact same crash signature
      byte-for-byte** — generic Chromium multi-process behavior, not a
      bunium-vs-Electron difference. `bunium_subprocess` has no bunium-
      owned signal handling (thin `CefExecuteProcess` wrapper); all of
      this is inherited from CEF/Chromium itself. Operational takeaway for
      docs, not code: deploy under `KillMode=process` (not systemd's
      default `KillMode=control-group`) so only the main PID gets
      signaled — same guidance would apply to Electron too. Full writeup
      in `benchmark/RESULTS.md`.

## Post-Phase-11 — Linux CI verification + full scaffold smoke sweep (2026-08-31)

- [x] **Every Linux-relevant CI job manually reproduced locally, all
      green.** `ci.yml` (`bun run typecheck` clean; `bun run lint` has 11
      pre-existing formatting errors in `src/system/tray.ts`/`menu.ts`
      unrelated to any change this session — flagged, not fixed, out of
      scope). `linux-smoke.yml`'s examples sweep: 36/37 PASS, exactly
      matching CI's allowlist (the one skip, `color-scheme-live-test.ts`,
      is an expected mac-only `osascript` dependency). `linux-smoke.yml`'s
      packaging step (`packaging/linux/package.sh ... --verify`): PASS,
      real window + pixel check. `release.yml`'s `linux-x64` job
      (`scripts/stage-release-artifacts-linux.sh` +
      `scripts/verify-platform-package-linux.sh`): both PASS.
- [x] **New `scripts/smoke-scaffolds-linux.sh`** (mirrors
      `scripts/smoke-scaffolds-mac.sh`) — all 6 `create-bunium-app`
      templates verified end-to-end on real X (bare-metal x86_64, no
      Docker/Xvfb needed): scaffold → `bun link bunium` → `bun install` →
      `bun run build` → real-window+pixel check via
      `create-bunium-app/verify-prod.ts`. **6/6 PASS** after one real bug
      found and fixed:
- [x] **`vue-ts` template build bug, fixed.** Fresh `vue-ts` scaffolds
      failed `bun run build` (`vue-tsc -b`) with `error TS2307: Cannot
      find module './App.vue'`. Root cause: the template had no
      `src/vite-env.d.ts` (or equivalent) declaring the `*.vue` module
      shim that `vue-tsc`/`tsc` need to type-check `.vue` SFC imports —
      `@vue/tsconfig/tsconfig.dom.json` (the template's `tsconfig.json`
      base) does not itself provide this, and neither does `vite/client`;
      standard `create-vue` scaffolds always ship this file, but it was
      missing here. Not Linux-specific (no case-sensitivity issue found —
      `vue-js`'s sibling `.vue` import worked fine since plain `.js`
      doesn't type-check imports), just a gap in this template's TS
      config never previously exercised by a real `tsc`/`vue-tsc` build
      before this Linux sweep. Fixed by adding
      `create-bunium-app/templates/vue-ts/src/vite-env.d.ts` with the
      standard `/// <reference types="vite/client" />` + `declare module
      "*.vue"` shim, and widening `tsconfig.json`'s `include` to cover
      `src/**/*.d.ts`. Rerunning the full sweep after the fix: 6/6 PASS.
- [x] **`bun run lint`'s 11 pre-existing formatting errors, fixed.**
      `biome check --write .` reformatted `src/app.ts`, `src/system/
      menu.ts`, `src/system/tray.ts`, and three `benchmark/scripts/*.ts`
      files (all pure line-wrapping/import-order, no logic changes —
      confirmed by diff). Two real (non-format) lint findings needed
      manual fixes: `benchmark/scripts/bench.ts` had a
      `noAssignInExpressions` hit with a stale/wrongly-scoped
      `biome-ignore` comment on one line and no suppression at all on a
      second, near-identical `(extra[name!] ?? (extra[name!] = []))`
      line — fixed by giving each its own correctly-ruled
      `biome-ignore lint/suspicious/noAssignInExpressions` comment; and
      `benchmark/shared/index.html` (symlinked identically into both
      `bunium-mini-app/dist/` and `electron-mini-app/`, so one edit fixes
      both) was missing `lang="en"` on `<html>` and `type="button"` on
      the counter `<button>` (`useHtmlLang`/`useButtonType`), both no-op
      for the benchmark's behavior/rendering. `bun run lint` and `bun run
      typecheck` both clean; full re-verification after the fix: 36/36
      examples (Linux's one permanent skip aside), 6/6 scaffolds,
      packaging-verify and release-artifacts-verify scripts all still
      PASS.

## Post-Phase-11 — benchmark suite verified on Windows (2026-08-31)

- [x] Ran `benchmark/` for real on Windows (Windows 11 Pro, i5-14600K,
      Git Bash/MSYS2), `BENCH_REPS=5 BENCH_IDLE_SECONDS=6`, 20/20 reps
      clean. Also verified `packaging/win/package.sh --verify` end-to-end
      (542M package, `PACKAGED_APP_VERIFY:PASS`). Full numbers in
      `benchmark/RESULTS.md`'s Windows section: bunium wins paint time,
      idle CPU ties, Electron wins RSS/process-count/IPC latency. Bare
      `bun` process boot is *slower* than `node` here (60ms vs 48ms) —
      opposite of macOS.
- [x] Fixed two Windows bugs found while setting up the harness:
      `benchmark/shared/{app.js,index.html}` check out as broken symlink
      placeholders on Windows (`core.symlinks=false`), and
      `benchmark/scripts/report.ts` used `URL.pathname` for the repo
      path, which is POSIX-style even on Windows and broke
      `child_process.spawn`'s PATH search — fixed with `fileURLToPath`.

## Post-Phase-11 — IPC latency, round 2: wake self-pipe (2026-08-31)

User directive: push IPC round-trip latency toward/below Electron's
0.2-0.5ms (the largest remaining benchmarked gap after idle CPU was fixed).
Traced the full round-trip call chain end to end and found the dominant
remaining cost was the browser-process **pickup** step, not the Mojo/CEF
IPC hops themselves: `OnScheduleMessagePumpWork` could only update an
atomic wake deadline, which `src/app.ts`'s `setTimeout`-driven pump loop
discovered only on its *next already-scheduled* tick — an inbound message
arriving mid-wait still sat until that timer fired.

- [x] **Wake self-pipe, `AF_UNIX socketpair()` + `node:net` wrapping the raw
      fd on the JS side — shipped, measured a ~1.9x win, later found to be
      a dead no-op.** `git blame`-visible in this same commit range but
      **corrected below, not left standing**: `BUNIUM_IPC_DIAG` same-clock-
      domain tracing (added after the user pushed back with "why still
      >1ms, find root cause") showed native's `write()`s landing but the
      JS socket's `'data'` event never firing once in a full run — a real
      Bun 1.4.0 limitation (`new net.Socket({fd})` doesn't deliver
      readable events for an externally-created fd), confirmed via a
      minimal standalone repro outside this codebase. Re-benchmarking the
      confirmed-inert code measured ~3.1ms, inside the same noise band as
      both the "4.5ms before" and "2.3ms after" numbers — the original
      improvement was noise, not a fix.
- [x] **Wake socket, take 2 (the real fix): Bun-owned `Bun.listen({unix:
      path})`, native connects out as a client.** Same diagnosis (pickup
      gated by pump-tick granularity), different delivery mechanism —
      `src/app.ts` listens with Bun's own socket implementation instead of
      wrapping a raw fd; native `connect()`s to it and writes a wake byte
      (`bunium_set_wake_socket_path`, `native/mac/bunium_shim.cpp`).
      Verified via an isolated repro (~30-40us median) *before* shipping,
      per the take-1 lesson. Same function-pointer pattern as before for
      the `subprocess_main.cpp`-link reason. Windows: no implementation
      yet (documented next step: WinSock2 `AF_UNIX`/`afunix.h`, needs
      `WSAStartup`/`ws2_32.lib` added to `native/win/build.sh`) — falls
      back to the pre-existing timer-only pump there, safely. Linux:
      should carry unchanged (same shared source) but **not verified this
      session**. **Result: IPC round-trip avg 4.5ms → ~0.3-0.7ms
      (~7-13x), median ~0.2-0.4ms** — now inside Electron's own run-to-run
      noise band (0.23-0.82ms measured in this same session). One
      unexplained artifact: the first IPC call of a fresh process costs
      6-8ms (occasionally more) in ~3 of 4 runs, every later call
      sub-millisecond — a warm-up ping helped inconsistently, not fully
      root-caused, but confirmed one-time/startup-only, not steady-state.
      Verified against 37/37 examples, no regressions. Full writeup,
      native round-trip trace example, and concrete next steps (Windows
      implementation, Linux verification, first-call artifact) in
      `benchmark/RESULTS.md`.

## Post-Phase-11 — IPC latency fix verified on Linux (2026-08-31)

- [x] **Rebuilt and re-measured the wake-socket fix on real Linux
      hardware (same x86_64 bare-metal host as the earlier Linux
      verification pass).** The `native/build-linux/bunium_shim.so` left
      over from that earlier session predated the wake-socket commit --
      `bun:ffi` failed loudly on startup (`Symbol
      "bunium_set_wake_socket_path" not found`), confirmed via `nm -D`
      that the symbol was genuinely missing from the stale `.so`. Rebuilt
      via `native/linux/build.sh` (no source changes needed -- Linux
      already compiles the shared `native/mac/bunium_shim.cpp` /
      `bunium_common.h` unmodified, same file the mac/Windows fix
      shipped in). **Result: IPC round-trip avg 2.9ms → 0.8ms**, matching
      mac's and Windows' order-of-magnitude win and landing inside
      Electron's own noise band on this host (0.5ms). Verified the wake
      path is actually firing (not a coincidental speedup) via
      `BUNIUM_IPC_DIAG=1`: `browser_wake_write` → `js_wake_socket_data`
      checkpoints measured 5-40us apart, matching the pre-ship repro
      number. Re-ran the full Linux examples sweep after the rebuild:
      36/36 clean (the one permanent mac-only skip aside), no
      regressions. Full numbers and updated table in
      `benchmark/RESULTS.md`'s new Linux IPC section. Windows AF_UNIX
      support and the first-IPC-call startup artifact remain open, as
      before.
- [x] **New `scripts/check-native-freshness.sh`** closes the stale-
      binary gap that caused the above: compares `native/mac/
      bunium_shim.cpp`/`bunium_common.h`/`subprocess_main.cpp`/
      `bunium_bsdiff_wrap.mm` (the shared sources every platform compiles
      unmodified) plus each platform's own sources against its compiled
      `native/build*/bunium_shim.{dylib,so,dll}` mtime; `--fix` rebuilds
      via the platform's own `native/<platform>/build.sh` automatically.
      `bun run check:native:{mac,linux,win}` package.json shortcuts
      added. Wired in two places as a non-blocking warning (never fails a
      run outright -- a stale build might be intentional, e.g. bisecting):
      `docker/linux/run-examples.sh` (so the smoke sweep flags it before
      36 examples run against possibly-stale native code) and
      `benchmark/scripts/report.ts` (so a benchmark run flags it before
      producing numbers that don't reflect the current source tree --
      exactly the report this incident's original numbers came from).
      Verified end to end on this Linux host: fresh build reports FRESH
      and both entry points stay silent; `touch`-ing
      `native/mac/bunium_shim.cpp` makes both correctly print the
      staleness warning without blocking the run, and `--fix` rebuilds
      and clears it. Not wired into mac/Windows CI (no code changes
      needed there -- same script, `mac`/`win` arg already supported --
      just not exercised on real mac/Windows hardware this session).

---

**Naming:** `bunium`, confirmed by user.
**Decided:** IPC wire format — see `ARCHITECTURE.md` §15/§18 (CefProcessMessage-based, named
messages, JSON payloads, ≤8-arg native ABI functions).
**Not yet decided:** package manager/monorepo layout, repo hosting.
