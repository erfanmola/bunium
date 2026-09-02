# bunium — architecture decisions

Electron-like app framework: Bun (not Node) + CEF (not Chromium-via-Electron) + native TS bindings,
targeting a DOM-integrated `<webview>` tag, Vite dev support, SolidJS boilerplate, full cross-platform
packaging/signing/updates. These decisions are load-bearing — don't re-litigate without new evidence.

## 1. Binding strategy: C++ shim + flat C ABI, not raw CEF-C-API-in-bun:ffi

CEF ships a pure C API (`include/capi/*_capi.h`) exported directly from `libcef`
(confirmed via `nm -gU`), which in theory lets `bun:ffi` call it with zero wrapper compile.
**Rejected anyway.** The C API is refcounted vtable structs (`cef_base_ref_counted_t` +
per-interface function-pointer tables) — hand-laying those out in TS via `DataView` means every
offset/size mistake is a silent native segfault with no JS stack trace. Not worth it for how much
of the framework surface (client, render handler, life-span handler, browser-process handler...)
would need hand-rolled layouts.

**Chosen:** a small C++ shim (`poc/shim/`) written against CEF's real C++ API (`CefRefPtr`,
`IMPLEMENT_REFCOUNTING`, normal virtual overrides — compiler-checked, not hand-offset), compiled to
a `.dylib` (macOS) that exports a **flat C ABI**: plain functions, plain int/pointer args, no
structs crossing the FFI boundary. `bun:ffi` only ever calls things like
`bunium_create_view(url, w, h) -> handle`. This is the standard pattern for scripting-language CEF
wrappers and is what any real implementation would converge on anyway.

Files: `native/mac/bunium_common.h` (BuniumApp/BuniumClient classes),
`native/mac/bunium_shim.cpp` (ABI + dylib entry), `native/mac/subprocess_main.cpp` (separate
subprocess executable entry, see §2), `native/mac/bunium_window_mac.mm` (window/CALayer, see
§7-8). Build via `native/mac/build.sh` → outputs `native/build/`. CEF distribution lives at
`vendor/cef-macosarm64/`. `poc/shim/` copies are historical only — edit `native/mac/`.
The real JS-facing package is `src/` (`native.ts` FFI bindings, `app.ts` pump-loop singleton,
`window.ts` the `BuniumWindow` class, `index.ts` public exports).

## 2. Subprocess model: separate compiled executable, no `.app` bundle required

CEF is multi-process (browser/renderer/GPU/utility). Renderer etc. need to re-exec the "subprocess
executable" — normally (on macOS) a `Contents/Frameworks/<app> Helper.app` bundle. Confirmed via
`cef_settings_t.browser_subprocess_path` docs: if non-empty, it can be **any absolute path**, not
necessarily inside a bundle. So the shim ships a second, tiny compiled binary
(`bunium_subprocess`, from `subprocess_main.cpp`) whose `main()` just calls `CefExecuteProcess` and
exits. The Bun-loaded `.dylib` sets `browser_subprocess_path` to this binary's absolute path.
This avoids needing full `.app` bundle packaging during dev — only matters for final release
packaging (Phase 8).

## 3. Resource path resolution must be explicit outside a bundle

Running CEF loaded into a bare `bun` process (not from inside an app bundle) breaks CEF's default
resource autodiscovery (`icudtl.dat not found`, hangs). Fix: explicitly pass
`framework_dir_path` and `resources_dir_path` (pointing at
`Chromium Embedded Framework.framework` and its `Resources/` dir) into `CefSettings` at init.
`bunium_init()`'s signature takes these as explicit args for this reason — don't remove them.

## 4. Compiler visibility: every exported ABI function needs explicit `__attribute__((visibility("default")))`

The shim compiles with `-fvisibility=hidden` (matches CEF's own recommended flags). Without an
explicit default-visibility attribute, `extern "C"` alone does NOT export the symbol — `bun:ffi`'s
`dlopen` will fail with "Symbol not found" even though the function compiles fine. See
`BUNIUM_EXPORT` macro in `bunium_shim.cpp`.

## 5. Framework dylib load path must be rewritten to absolute

The CEF framework binary's own install name is `@executable_path/../Frameworks/...`, which assumes
standard app-bundle layout (executable in `Contents/MacOS`, framework in `Contents/Frameworks`).
When our shim `.dylib` gets loaded into `bun` (living in `/opt/homebrew/bin`), that path doesn't
resolve. Fix: `install_name_tool -change ... <absolute path to framework binary>` on both
`bunium_shim.dylib` and `bunium_subprocess` after compiling with
`-Wl,-headerpad_max_install_names` (needed or `install_name_tool` fails — the new absolute path is
longer than the original relative one). Packaging (Phase 8) will need to redo this rewrite
pointing at the bundled framework location instead.

## 6. OSR (off-screen rendering) confirmed as the paint path, GPU backend resolved

`windowless_rendering_enabled=true` + `CefRenderHandler::OnPaint` gives a raw BGRA buffer per
frame — validated end-to-end (see `poc/frame.png`, pixel-exact render of test HTML). This is the
correct starting point for the DOM-integrated `<webview>` requirement (windowed child views are
what makes Electron's own `<webview>` janky on scroll/transform — see Phase 2).

**Resolved:** GPU compositing is now explicitly disabled by default
(`command_line->AppendSwitch("disable-gpu")` + `"disable-gpu-compositing"` in
`BuniumApp::OnBeforeCommandLineProcessing`, `bunium_common.h`). Measured with a clean,
non-crashing GPU process (after fixing the missing-ANGLE-libs bug that caused the earlier
crash-loop — see build script note below): GPU-composited OSR delivered frames at ~34ms average
gaps (~30fps); the same content with GPU compositing off delivered ~22ms average gaps (~56fps),
reproduced twice. **For this OSR use case, GPU compositing is slower, not faster** — the likely
cause is CEF's OSR path needing a GPU→CPU texture readback every frame to hand pixels back via
`OnPaint`, which a pure software rasterizer skips entirely. `--use-angle=metal` did not change
this. This is a real, counterintuitive result specific to *windowless* rendering — do not assume
it generalizes to windowed/accelerated rendering modes.

**Follow-up separate build bug found while investigating this:** the GL/ANGLE libs
(`libGLESv2.dylib`, `libEGL.dylib`, etc.) that Chromium's GPU process looks for next to the
subprocess executable were only ever manually copied into the old `poc/shim/` directory, not the
real `native/build/` output — so the crash-loop silently came back after the Phase 1 restructure.
Fixed properly this time: `native/mac/build.sh` now copies them automatically as part of the
build, not a manual step to remember.

**Blocked upstream, not just unimplemented (checked 2026-09-02):** CEF's shared-texture OSR path
(`OnAcceleratedPaint` + `CefAcceleratedPaintInfo`) would avoid the CPU-readback round-trip
entirely, but the mac window-creation flag that enables it,
`cef_window_info_mac_t::shared_texture_enabled`
(`vendor/cef-macosarm64/include/internal/cef_types_mac.h`), says directly in its doc comment:
"Currently only supported on Windows (D3D11)" — confirmed against this repo's actual vendored CEF
151.3.16 header, not assumed from the generic cross-platform `OnAcceleratedPaint` doc comment
(which describes an IOSurface format for mac as part of its general description, but that path
isn't wired up for mac in this CEF build). Setting the flag on mac is a no-op; `OnPaint` stays the
only callback that ever fires there. The `--disable-gpu` finding above is still correct for the
only OSR path CEF actually supports on this platform today — this isn't a bunium gap to close with
more native code, it's missing upstream CEF/Chromium mac support with no visible timeline. Revisit
by checking a future CEF version's `cef_types_mac.h` for this same comment before attempting an
implementation again.

## 8. Never hand a native buffer to CoreGraphics without copying it

`CGDataProviderCreateWithData` does not guarantee it reads `bytes` synchronously — compositing can
happen later, on another thread. `CefRenderHandler::OnPaint`'s `buffer` argument is only valid for
the duration of that callback (CEF owns and reuses/frees it after return). Passing CEF's buffer
pointer straight into `CGDataProviderCreateWithData` (as `bunium_window_mac.mm` originally did)
caused a fast, silent process death with no crash log in stdout/stderr — looked exactly like the
loop finishing early, not a crash, which made it easy to misdiagnose as a timing artifact instead
of a use-after-free. Fix: `malloc` + `memcpy` the frame into a copy owned by the `CGDataProvider`,
freed via its release callback (`ReleaseFrameCopy` in `bunium_window_mac.mm`). This pattern
(copy-then-hand-off) applies to any future native buffer crossing into a system API with unclear
lifetime rules — don't assume synchronous consumption.

**Superseded (still true as a lesson, not as current code):** the presentation path described
above (`CGDataProviderCreateWithData` + `CGImageCreate` on a plain `CALayer`) was replaced with a
`CAMetalLayer` + `MTLTexture.replaceRegion` path, which happens to sidestep this exact bug too --
`replaceRegion` copies synchronously before returning. CPU rasterization is unchanged (CEF still
renders on the CPU, deliberately — see §6); Metal here is presentation-only. Measured: avg
inter-frame gap dropped from ~22ms (`CGImageCreate`) to ~17.4ms (Metal upload), reproduced twice.
`bunium_window_mac.mm`'s `BuniumWindowHandle` now also owns a retained `MTLDevice` +
`MTLCommandQueue` (manual `CFBridgingRetain`/`CFBridgingRelease` pair, same ARC-in-a-plain-struct
constraint as the delegate).

## 10. Multi-layer compositing works; DOM bounds sync is the remaining gap

`bunium_create_sublayer(window, x, y, w, h)` adds a second independently-painted `CAMetalLayer`
as a sibling inside a window's layer tree (reuses `bunium_window_update_frame`'s body verbatim —
it never touched anything window-specific, only `->layer`/`->command_queue_retained`). Proved two
separate CEF renderer processes composite cleanly in one window
(`examples/multi-layer-test.ts`). This is the mechanical core of a DOM-integrated `<webview>`.

**Resolved:** the JS↔native IPC bridge exists and is verified. `window.__bunium.reportBounds(x,
y, w, h)` is injected into every page's V8 context (`BuniumApp::OnContextCreated` +
`BuniumV8Handler`, `bunium_common.h`) and sends a raw `CefProcessMessage` (named
`kBoundsMessageName`) to the browser process, handled by
`BuniumClient::OnProcessMessageReceived`, which repositions a "tracked sublayer"
(`SetTrackedSublayer`/`bunium_view_track_sublayer`) via `bunium_sublayer_set_frame`. Chose raw
process messages over `CefMessageRouter` deliberately: the router is request/response shaped
(like `fetch`), this is a one-way fire-and-forget push meant to run every animation frame —
process messages have less serialization/callback overhead for that shape. Verified with exact
value matching in `examples/ipc-bounds-test.ts`, not just absence-of-crash.

**Resolved — good news, and a lesson about measurement methodology.** The first version of this
test (a DOM element animated at constant speed, comparing expected vs actual native position)
found ~140-200ms of apparent "lag." That number was real but the interpretation was wrong: the
test assumed T0 = the moment Bun called `bunium_create_view`, but the page's own rAF loop starts
somewhat later (navigation + first paint + first rAF callback all take real time). A one-time
fixed startup offset, run through `naiveLag(t) = SPEED*(t-T0) - SPEED*(t-T0-startupOffset) =
SPEED*startupOffset`, produces a constant apparent "lag" independent of `t` — which is exactly
the tight, non-growing range that was measured. It looked like per-frame lag; it was actually a
one-time cost being sampled repeatedly.

Two things exposed this: (1) `CefBrowserHost::WasHidden(false)` (tried as a fix for the
now-abandoned occlusion-throttling hypothesis) made no consistent difference, and (2) a targeted
diagnostic (`examples/raf-cadence-diag.ts`, using the newly-added `OnConsoleMessage` forwarding
— page `console.log` output previously had nowhere to go and was silently lost, now forwarded to
stderr, kept permanently since it's broadly useful) found `requestAnimationFrame` running a
**jitter-free ~16.35ms average** — inconsistent with real per-frame throttling, consistent with
a measurement artifact instead.

Fixed methodology (`examples/ipc-latency-test.ts`, current version): fit a linear regression to
`(t, actualX)` samples instead of trusting an assumed T0, separating the fitted intercept
("startup offset," ~130-150ms, a one-time cost) from the residual jitter around the fit
("steady-state per-frame lag," the number that actually matters for smoothness). Result: fitted
speed matches the true animation speed to 4 significant figures (0.0999-0.1000 vs 0.1 px/ms,
confirming zero systematic drift over time), and **steady-state jitter is ~4.5ms average, ~12-16ms
max** — comfortably inside the ~16.6ms budget of a 60Hz frame. The JS↔native bounds-sync bridge
is fast enough for "buttery smooth" as far as this synthetic test can show.

**Still genuinely unproven:** this is one synthetic rAF-driven translateX animation, not real user
scroll/trackpad/drag input, and there's still no visual on-screen confirmation on a real desktop
(same category of gap as elsewhere in this doc). The bridge was also only exercised with rAF
calling `reportBounds` directly (no `ResizeObserver`/scroll-event-triggered updates yet), and
CALayer clipping/z-order to match CSS `overflow`/stacking context semantics is unstarted.

## 12. Input forwarding + sublayer hit-testing

Mouse (`mouseDown:`/`mouseUp:`/`rightMouseDown:`/`rightMouseUp:`/`mouseMoved:`/`mouseDragged:`)
and keyboard (`keyDown:`/`keyUp:`) events on `BuniumContentView` (a custom `NSView` subclass,
`isFlipped=YES` so its local coordinate space matches CEF's top-left-origin convention directly)
forward to `bunium_dispatch_mouse_click`/`_move`/`bunium_dispatch_key_event` in `bunium_shim.cpp`,
which hit-test a per-window registry of sublayers (`g_window_sublayers`, checked topmost
last-inserted first) before falling back to the window's own primary view, converting
window-local coordinates to sublayer-local coordinates on a hit. Keyboard routes via
`g_last_focused_target` ("whichever view most recently received a mouse click") rather than a
real focus-manager subsystem.

Verified two ways: (1) dispatching a synthetic click/keypress via the ABI directly and confirming
a page's `onclick`/`keypress` handler fired via exact pixel readback
(`examples/mouse-click-test.ts`, `examples/keyboard-test.ts`); (2) two independently clickable
pages, one filling the window and one on a positioned sublayer, confirming a click inside the
sublayer's screen rect reaches only the inner view and a click outside reaches only the outer one
(`examples/sublayer-hit-test.ts`).

**Known simplifications, not bugs, but worth knowing about:** macOS `NSEvent.keyCode` is used
directly as both `windows_key_code` and `native_key_code` in `CefKeyEvent` rather than a real
Windows virtual-key mapping table — fine for basic typing/testing, not fully correct, and there's
no `NSTextInputClient` implementation, so IME/composition input (accented characters, CJK, etc.)
isn't supported. Real OS-level click/keypress delivery through `BuniumContentView`'s Cocoa event
handlers themselves is untested — only the dispatch ABI was exercised directly, same category of
visual/interactive gap as elsewhere in this document (needs a real desktop to confirm the Cocoa
event handlers actually receive real user input, not just that the forwarding logic behind them
is correct once invoked).

## 11. What's NOT yet proven

- The JS↔native bounds-sync bridge described in §10 — genuinely the hardest remaining problem.
  Everything before it (OSR, Metal presentation, multi-layer compositing) was necessary but not
  sufficient for "acts like a real DOM node."
- Windows/Linux at all — everything so far is macOS arm64 only.
- Any of: packaging, code signing, updater, Vite integration, SolidJS boilerplate.
- **Visually confirmed on-screen output** — every pipeline runs without crashing and frame counts
  increment, but the sandboxed dev environment this was built in couldn't reliably screenshot
  actual windows (see `PLAN.md` Phase 1 progress notes). Logically sound given the fixes in §8-9,
  but actually looking at it is still an open item for whoever runs it next on a normal desktop.

## 13. Device pixel ratio / Retina blur fix

CEF's `CefRenderHandler::GetScreenInfo` defaults to unimplemented (`return false`), which means
CEF assumes `device_scale_factor = 1.0` and rasterizes at logical (CSS) pixel resolution. On a
Retina (2x) display, that 1x buffer then got uploaded into a `CAMetalLayer` whose `contentsScale`
was already correctly set to 2 (from the Phase 1 Metal work) — a 1x-resolution texture stretched
across a 2x-density layer is exactly what blur looks like. User-reported, confirmed, and fixed.

Fix: `BuniumClient::GetScreenInfo` (`bunium_common.h`) now reports the real scale via a new
`device_scale_factor_` member (`SetDeviceScaleFactor`, triggers `NotifyScreenInfoChanged` if the
browser already exists). The scale itself comes from `NSWindow.backingScaleFactor`
(`bunium_window_get_scale` in `bunium_window_mac.mm`, works uniformly for both a window's primary
layer and a sublayer since both are `CAMetalLayer`s with `contentsScale` set at creation), read
and applied in `bunium_attach_window` (`bunium_shim.cpp`). `GetViewRect` continues returning
logical width/height unchanged — CEF internally produces an `OnPaint` buffer sized
`width*scale × height*scale`, which is what `renderedSize` now reports. Verified: a 400×300
logical window produces an exact 800×600 physical buffer on this 2x-scale machine, reproduced
twice.

**Not implemented:** an explicit DPR override (rendering at a scale different from the actual
display — e.g. capturing a screenshot at a fixed resolution regardless of the display it's on).
Currently the scale is always auto-detected from the window and can't be overridden per-view.

## 14. Root cause confirmed: yabai (tiling window manager), not a bunium or environment bug

While testing §13, `BuniumWindow.innerSize` was observed reporting values wildly different from
what was requested at construction (e.g. `{1010, 1237}` for a window created as `{400, 300}`).
Traced to the auto-resize-on-native-change feature (`app.ts`'s `pollWindows`) faithfully
propagating a real change in `NSWindow.contentView.bounds` that happened ~150-250ms after window
creation, with zero involvement from any bunium code path. Confirmed via a bare Cocoa window with
no CEF view attached at all — still happened, ruling out any CEF/rendering interaction. Tried
`window.collectionBehavior = NSWindowCollectionBehaviorFullScreenNone |
NSWindowCollectionBehaviorFullScreenAuxiliary` — did not fix it (wrong theory: not
Spaces-fullscreen/Stage-Manager related).

**Confirmed root cause:** the user runs **yabai** (a tiling window manager) on this machine.
yabai auto-tiles newly created resizable+titled windows into its layout grid shortly after they
appear — exactly matching the observed timing and behavior. Fixed at the yabai level with
`yabai -m rule --add app="^bun$" manage=off` (excludes windows owned by the `bun` process from
tiling), applied at runtime and verified: a window created after adding the rule stayed exactly
400×300 for the full test duration, no resize at all. This rule is **not persisted** — it needs
adding to the user's own yabai config (their `yabairc` or equivalent) to survive a yabai restart;
not written automatically since its location wasn't obvious and guessing wrong risked corrupting
an unrelated config file. Once bunium ships packaged `.app` bundles with real bundle identifiers
(Phase 8), a `app="^AppName$"` rule can target the packaged app precisely instead of the broad
`^bun$` (which would also exclude windows from any *other* bun-based GUI app on the same
machine — fine for solo dev use, not precise enough for a real distributed app).

Regardless of root cause, this exposed a real design gap worth keeping fixed on its own merits:
the resize-forwarding logic blindly trusted any OS-reported size change as legitimate user
intent, with zero sanity checking — other users may run different tiling WMs (Amethyst,
Rectangle, AeroSpace, etc.) with their own auto-tiling heuristics bunium can't special-case
individually. `BuniumApp.RESIZE_SETTLE_MS` (1000ms, in `app.ts`) stays in place: native size
changes reported within the first second after a window is registered are absorbed into
`lastSizes` but not forwarded via `onNativeResize`. A real user cannot resize a window within
milliseconds of first seeing it appear, so this costs nothing for legitimate use and closes off
this whole class of "some external tool touched my window right after creation" issue generically,
not just for yabai specifically.

## 15. Generalized typed IPC layer (renderer → main)

`window.__bunium.reportBounds()` (§10) was deliberately a one-off proof of the
`CefV8Handler`/`CefProcessMessage` mechanism, not a pattern to repeat per feature. Built the real
generalized version alongside it (left `reportBounds` untouched rather than risk regressing
verified Phase 2 tests):

- Renderer: `window.__bunium.send(name, JSON.stringify(payload))`, added as a second function on
  the same `BuniumV8Handler`/`__bunium` object as `reportBounds`.
- Transport: one message name (`kSendMessageName = "bunium-send"`), two string args (message
  name, JSON payload) — the payload is carried as an opaque string, not re-parsed/re-embedded as
  structured `CefValue` args, to avoid needing a general JS-value-to-CefValue converter for
  arbitrary payload shapes.
- Browser process: `BuniumClient::OnProcessMessageReceived` pushes `(name, payload)` onto a
  thread-safe per-view `MessageInbox` (mutex + deque, written on CEF's UI thread).
- Retrieval: `bunium_poll_message(view_handle)` pops one message, JSON-encodes `{name, payload}`
  as the envelope via `CefValue`/`CefWriteJSON` (not hand-rolled string concatenation — avoids
  escaping bugs for message names with special characters).
- JS: `BuniumApp`'s pump loop calls `win.pollMessages()` every tick; `BuniumWindow<M>` (generic
  over a `BuniumMessageMap`) drains the queue and dispatches to `.on(name, handler)` listeners
  with a compile-time-typed payload for that message name.

Verified with ordered, multi-message, typed delivery (`examples/typed-ipc-test.ts`).

**Main → renderer push (built as a follow-up, same session):** `BuniumWindow<M>.emit(name,
payload)` sends a `CefProcessMessage` (name `kDispatchMessageName = "bunium-dispatch"`, same
two-string-args shape as the other direction) to `PID_RENDERER`.
`BuniumApp::OnProcessMessageReceived` (implemented on the renderer-side `CefRenderProcessHandler`,
not `BuniumClient` — that only exists in the browser process) looks up the target frame's
`CefV8Context` in a `std::map<std::string, CefRefPtr<CefV8Context>>` keyed by
`frame->GetIdentifier()`, populated/cleared in `OnContextCreated`/`OnContextReleased`. On a hit,
enters the context and calls `window.__bunium.__dispatch(name, payload)` directly via
`CefV8Value::ExecuteFunction` — safe because `OnProcessMessageReceived` already runs on the
renderer's main/V8 thread. `.on()`/the listener registry/`__dispatch` fan-out itself is plain JS
injected once via `CefFrame::ExecuteJavaScript` in `OnContextCreated` (simpler than hand-building
V8 objects/arrays through the C++ API for something with no native-side logic). Verified via
DOM/pixel-color change (`examples/typed-ipc-emit-test.ts`). The IPC layer is now genuinely
bidirectional.

**Real bug caught while building this:** `bun:ffi`'s `FFIType.cstring` return type gives back a
`CString` — an object wrapper — even when the underlying native pointer is `NULL`. Objects are
always truthy in JS regardless of what they stringify to, so `if (!result) break` in a drain loop
using `FFIType.cstring` never terminates; it looked like an infinite loop / hang (100% CPU,
`bun run` had to be killed) with no error message. Root-caused via a minimal repro that logged
`typeof`/truthiness directly. Fix: use `FFIType.ptr` and an explicit `envelopePtr === null` check,
then construct `new CString(ptr)` only when non-null — the same pattern `bunium_get_frame` already
used correctly. **Any future ABI function that can return "no result" as a null pointer should use
`FFIType.ptr` with a manual null check, never `FFIType.cstring`, for exactly this reason.**

## 16. Transparent + frameless window options

`bunium_create_native_window`/`bunium_create_view` both gained a `transparent` flag (window and
view sides need it independently: `window.opaque`/`backgroundColor`/`hasShadow` on the `NSWindow`,
`CAMetalLayer.opaque`, and `CefBrowserSettings.background_color` alpha=0 on the browser side — CEF
docs confirm alpha=0 enables transparent painting for windowless browsers specifically, it's a
binary switch not a translucency slider). `bunium_create_native_window` also gained a `frame`
flag: `false` uses `NSWindowStyleMaskBorderless` instead of `Titled`, Electron's `frame: false`
equivalent.

Verified precisely for transparency: a page painting one opaque corner and leaving the rest
untouched produced alpha=255/alpha=0 exactly where expected, read back via `captureScreenshot()`
(`examples/transparent-window-test.ts`). Frameless verified crash-free only
(`examples/frameless-window-test.ts`) — actually confirming the title bar is visually gone needs
a real desktop.

Changing these two functions' native signatures meant every raw-`dlopen` example script calling
them directly (7 files, from before `BuniumWindow` covered everything) needed their FFI
declarations and call sites updated too — caught via full regression run across all examples
before considering this done, not assumed safe because `tsc` was clean (TS doesn't check native
FFI arg counts).

**Not built yet:** draggable regions (`-webkit-app-region: drag` equivalent — should reuse the
typed IPC layer from §15 rather than a third bespoke bridge), `resizable`/min/max size, custom
resize-bar hit-testing for `frame: false` windows.

## 17. Draggable regions + a CEF JSON gotcha worth remembering

`-webkit-app-region: drag` (Electron's exact convention) is auto-detected: a script injected in
`OnContextCreated` (alongside the `on`/`send` bootstrap from §15) scans all elements'
`getComputedStyle`, finds matches, and reports their rects via `window.__bunium.send`. `load`,
`resize`, and a `MutationObserver` (debounced to one scan per animation frame) keep it live.
`BuniumWindow.pollMessages()` intercepts the reserved `__bunium_drag_regions` name before typed
`.on()` dispatch and calls a native setter directly — app code never sees this message.

Natively: `BuniumClient::SetDragRegions`/`IsPointDraggable` (a simple rect list + point-in-rect
scan, no locking needed — both the setter and the query run on the same thread, same reasoning as
`contexts_` in §15). `BuniumContentView::mouseDown:` (`bunium_window_mac.mm`) checks
draggability *before* calling `bunium_dispatch_mouse_click`; a hit calls
`[window performWindowDragWithEvent:event]` and returns without forwarding to CEF at all. Known
v1 limitation: the region is entirely non-interactive underneath — no Electron-style
`app-region: no-drag` carve-out for buttons inside a drag strip.

**Two real bugs, both worth remembering for future CEF/V8 work:**

1. `MutationObserver.observe(document.documentElement, ...)` was called inside the
   `OnContextCreated`-injected script before `documentElement` existed — the V8 context is
   created *before* the DOM is parsed, so `document.documentElement` is still `null` at that
   point. Threw `Uncaught TypeError: parameter 1 is not of type 'Node'`, caught via
   `OnConsoleMessage` forwarding (§ built earlier — paid for itself again here). Fixed by
   deferring the `observe()` call to a `DOMContentLoaded` listener.

2. `CefDictionaryValue::GetDouble(key)` returns `0` — not an auto-converted value — when the
   underlying JSON number was parsed as `VTYPE_INT` rather than `VTYPE_DOUBLE`. Whole numbers
   (`400`, `0`, `40`) parse as `VTYPE_INT`; `getBoundingClientRect()` produces these constantly.
   Every rect came back as `{x:0,y:0,w:0,h:0}` silently — no crash, no error, just wrong data,
   found only by tracing actual parsed values with `fprintf`. Fixed with a small
   `GetJsonNumber(dict, key)` helper (`bunium_shim.cpp`) that checks `GetType(key)` and branches
   between `GetInt`/`GetDouble`. **Any future code reading a CEF-parsed JSON dictionary's numeric
   field must use this pattern (or the helper directly) — raw `GetDouble()` on a JSON number is
   not safe to assume.**

## 18. Suspected bun:ffi bug: never exceed 8 arguments in a native ABI function

Found while building resizable/min-max window options. `bunium_window_create` grew to 10
parameters (width, height, title, transparent, frame, resizable, minW, minH, maxW, maxH). The
**10th** argument (`max_height`) consistently arrived as `0` on the native side, regardless of
what was passed. Isolated methodically before concluding this: confirmed the JS-side value was
correct right before the call (logged it), confirmed every native function signature matched
exactly at every layer (`bunium_shim.cpp`'s forward declaration, its wrapper, `bunium_window_mac.mm`'s
implementation), confirmed `max_width` — the 9th argument — arrived correctly, only the 10th was
wrong. This is consistent with a `bun:ffi` bug/limitation in its arm64 (AAPCS64) calling-convention
trampoline: the first 8 integer/pointer arguments pass in registers (x0-x7), the rest spill to the
stack, and something in that stack-spill path drops or corrupts (at least) the last argument.
**Not confirmed as an upstream Bun bug with a minimal repro outside this codebase** — treat as a
strong empirical finding, not a filed/verified issue.

**Fix and standing rule:** split the function into two calls, each ≤8 arguments —
`bunium_create_native_window` (5 args) and a separate `bunium_set_native_window_constraints`
(6 args, called immediately after). Verified the fix precisely (exact constraint values read back
correctly after the split, reproducibly). **Going forward: no native ABI function in this project
should take more than 8 arguments.** If a feature needs more inputs than that, split it into
multiple calls (as done here) or, for a case where splitting doesn't fit naturally, consider
packing values into a struct-like buffer (a `Uint8Array`/`Int32Array` passed via `FFIType.ptr`)
instead of individual scalar params. This isn't a style preference — it's a correctness
requirement given this finding, and should be treated as such when reviewing any future ABI
addition.

## 19. `--single-process` shipped (2026-09-02) — reverses an earlier rejection, explicit tradeoff

Earlier perf work (§ benchmark history in `PLAN.md`'s post-Phase-11 notes) tried
`--single-process` and rejected it: it merges the *renderer* into the browser process, which is
Chromium's real security/stability boundary against untrusted content — a `<bunium-webview>`
loading a page you don't control could previously crash or compromise only its own renderer;
merged, that same event takes down the whole app (every window, main process, everything). That
was the right call under "must keep GPU/renderer isolation" — it stopped being the right call once
the user explicitly decided isolation doesn't matter for this project and asked to minimize
process count/RSS at any cost short of hurting CPU/memory/perf.

**Verified before shipping** (not assumed from the earlier rejection's notes): rebuilt, ran the
full `examples/*.ts` sweep (37/37, same pre-existing `vite-dev-test.ts` cold-cache flake as every
other run), then re-benchmarked. Real result — process count 5→**1**, idle RSS **273.8 MB**
(minimal) / **334.4 MB** (mini-app), both now *below* Electron's 373.1/405.6 MB (previously
Electron won RSS outright). First paint and idle CPU are unaffected either way (unrelated to
process topology) and still trail Electron.

**Concrete costs, not just "less secure," worth remembering:**
- **Stability, not just security:** a page/webview crash now takes the whole app down, not just
  that view. No test here exercises this deliberately (no fuzzing/fault-injection harness exists
  for it) — the 37/37 sweep proves normal operation still works, not crash resilience.
- **Real functional loss:** Chromium logs `Cannot use V8 Proxy resolver in single process mode` at
  startup — system/corporate proxy autoconfig (PAC scripts) is unsupported in this mode. Direct
  proxy settings (env vars, explicit CEF proxy config) are unaffected; PAC-based ones are.
- `--in-process-gpu` (§ shipped alongside this) becomes redundant once `--single-process` is on —
  left in place since it's harmless, not because it still does anything distinct.

If bunium's threat model or stability bar changes later (e.g. someone wants `<bunium-webview>` to
safely load fully untrusted third-party content again), revisit this — the fix is one flag
removal, verified working both ways.

## 20. First-paint timeline, real breakdown (macOS, 2026-09-02) — two big Chromium costs, one real 35-45ms lever found and left unaddressed

bunium's first paint (~295-320ms) trails Electron's (~161-195ms) by roughly 130ms. Earlier notes
attributed this entirely to `CefInitialize()` with "no lever found." Added a permanent, gated
instrumentation pass to check that claim with real numbers instead of re-asserting it:
`BUNIUM_CEF_VERBOSE=1` now also emits `[startup-diag] t=<steady_clock us> stage=<name>` lines at
every major milestone (`cef_initialize_start/end`, `window_create_start/return`,
`nswindow_alloc_done`, `mtl_device_created`, `create_browser_call`, `after_created`,
`loading_start`, `renderer_context_created` (renderer process, same monotonic timebase per the
existing `BuniumIpcDiagLog` comment), `load_end`, `first_paint`) — `native/mac/bunium_shim.cpp` +
`bunium_common.h` + `bunium_window_mac.mm` (the last one duplicates a tiny `BuniumWindowVerbose`/
`BuniumWindowNowUs` pair rather than including `bunium_common.h`, to keep that Cocoa-only TU free
of CEF headers). Zero cost when the env var is unset (same gating pattern as every other verbose
log line here already).

**Real breakdown, one representative run:**

| segment | cost |
|---|---|
| `cef_initialize_start` → `context_initialized` | 111.9ms |
| `context_initialized` → `window_create_start` (JS-side FFI overhead) | ~0.5ms |
| `window_create_start` → `nsapplication_shared_done` | ~3.7ms |
| `nsapplication_shared_done` → `nswindow_alloc_done` (**`NSWindow alloc/init`**) | **34.8ms** |
| `nswindow_alloc_done` → `window_create_return` (Metal device/queue/layer, delegate) | ~11ms |
| `window_create_return` → `renderer_context_created` (renderer/Blink/V8 bootstrap) | 120.0ms |
| `renderer_context_created` → `first_paint` | ~9ms |

**One real, confirmed, quantified lever: the 34.8ms `NSWindow alloc/init` cost is a one-time
per-process AppKit/WindowServer-connection cost, not a per-window cost.** Verified with a
throwaway two-window-in-one-process test (not shipped, `examples/tmp-two-windows-test.ts`,
deleted after use): window 1's `NSApplication`→`NSWindow` gap was 45.6ms, window 2's (same
process, immediately after) was 4.9ms. This matches the same "first framework touch pays a fixed
setup tax" pattern already found in `GatherProcessRequirementMetrics` and the Metal-device
first-call cost elsewhere in this codebase.

**Why it's not a quick fix, left unaddressed this session:** the obvious idea — warm up
`NSApplication`/a throwaway `NSWindow` on a second thread *while* the main thread blocks inside
`CefInitialize()` — would only save wall-clock time if `CefInitialize()` spends real time
*waiting* (blocked on subprocess IPC handshakes) rather than pegging the calling thread the whole
112ms; not measured either way this session. More importantly, both operations currently
compete for the same "main thread" requirement: Cocoa's `NSWindow`/`NSApplication` APIs expect to
run on the process's actual main thread, and this codebase's `multi_threaded_message_loop = false`
CEF setting means `CefInitialize()` + the CEF UI thread are also tied to whichever thread calls
them (currently: the same main thread, for straightforward run-loop integration). Moving either
one off the main thread to unlock real parallelism is a genuine threading-model change with real
crash risk (off-main-thread Cocoa calls can assert/crash unpredictably), not a quick win — needs
its own careful experiment (does `CefInitialize()` actually block on I/O long enough to matter;
does CEF mac support being driven from a non-main thread at all) before attempting, not blind
implementation.

**The other two segments (`CefInitialize` 112ms, renderer/Blink/V8 bootstrap 120ms) still look
like inherent Chromium engine cost**, matching the prior "no lever found" conclusion — now backed
by an actual measured breakdown instead of an unquantified claim. One real open question, not yet
investigated: whether Electron's own bootstrap pays some of the renderer/V8 cost *before* its
equivalent "process_start" benchmark timestamp (e.g. via its own spare-process pre-warming
happening earlier in its startup sequence, outside what this benchmark methodology can see) —
would explain part of the apparent gap as a measurement-point asymmetry rather than a real
capability difference. Concrete next step if this is revisited: instrument Electron's own startup
the same way (its `ready`/`browser-window-created` events plus a raw `process.hrtime` at the very
top of its `main.js`) for a same-clock-domain comparison, rather than comparing bunium's internal
breakdown against Electron's external aggregate number.
