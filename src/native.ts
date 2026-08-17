import { dlopen, FFIType } from "bun:ffi";

const repoRoot = new URL("..", import.meta.url).pathname;

// Packaged apps (Phase 8) can't keep pointing at this repo's dev-tree
// paths, so every native artifact location is env-overridable
// (BUNIUM_SHIM_PATH / BUNIUM_SUBPROCESS_PATH / BUNIUM_FRAMEWORK_DIR) with
// the dev-tree layout as the default fallback -- the .app launcher
// (packaging/mac/package.sh) exports the bundle-relative paths before
// exec'ing bun, and dev scripts never set them, so both modes work with
// no other branching.
const override = (key: string, fallback: string): string =>
  process.env[key] ?? fallback;

export const paths = {
  shim: override(
    "BUNIUM_SHIM_PATH",
    `${repoRoot}native/build/bunium_shim.dylib`,
  ),
  subprocess: override(
    "BUNIUM_SUBPROCESS_PATH",
    `${repoRoot}native/build/bunium_subprocess`,
  ),
  frameworkDir: override(
    "BUNIUM_FRAMEWORK_DIR",
    `${repoRoot}vendor/cef-macosarm64/Release/Chromium Embedded Framework.framework`,
  ),
  get resourcesDir() {
    return `${this.frameworkDir}/Resources`;
  },
};

// Per-app CEF profile dir. Empty for dev (CEF keeps its shared default
// profile, so dev behavior is unchanged); packaged launchers set it to a
// per-app Application Support dir so two different bunium apps never fight
// over CEF's ProcessSingleton or share cookies/cache.
export const rootCachePath = process.env.BUNIUM_ROOT_CACHE_PATH ?? "";

export const lib = dlopen(paths.shim, {
  bunium_init: {
    args: [FFIType.cstring, FFIType.cstring, FFIType.cstring, FFIType.cstring],
    returns: FFIType.i32,
  },
  bunium_do_message_loop_work: { args: [], returns: FFIType.void },
  // Sets the single global root directory that the "bunium://app/<path>"
  // custom scheme resolves against (see BuniumSchemeHandlerFactory in
  // bunium_common.h). Must be called before any loadURL("bunium://...")
  // call; there is only one root (matches Electron's single-app-root
  // convention), not a per-window root.
  bunium_set_app_root: { args: [FFIType.cstring], returns: FFIType.void },
  bunium_create_view: {
    args: [FFIType.cstring, FFIType.i32, FFIType.i32, FFIType.i32],
    returns: FFIType.ptr,
  },
  bunium_navigate: {
    args: [FFIType.ptr, FFIType.cstring],
    returns: FFIType.void,
  },
  bunium_resize: {
    args: [FFIType.ptr, FFIType.i32, FFIType.i32],
    returns: FFIType.void,
  },
  bunium_send_scroll: {
    args: [FFIType.ptr, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.i32],
    returns: FFIType.void,
  },
  bunium_frame_count: { args: [FFIType.ptr], returns: FFIType.u64 },
  bunium_get_frame: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.ptr],
    returns: FFIType.ptr,
  },
  bunium_view_get_frame_size: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.ptr],
    returns: FFIType.void,
  },
  // FFIType.cstring's return-null handling is unreliable (a null pointer
  // still comes back as a truthy CString wrapper object, breaking `if
  // (!x) break` style loops) -- use FFIType.ptr + manual `=== null` check
  // and construct the string explicitly, same pattern as bunium_get_frame.
  bunium_emit_to_renderer: {
    args: [FFIType.ptr, FFIType.cstring, FFIType.cstring],
    returns: FFIType.void,
  },
  bunium_poll_message: { args: [FFIType.ptr], returns: FFIType.ptr },
  bunium_set_drag_regions: {
    args: [FFIType.ptr, FFIType.cstring],
    returns: FFIType.void,
  },
  bunium_close_view: { args: [FFIType.ptr], returns: FFIType.void },
  // <bunium-webview>: each element gets its own CAMetalLayer sublayer (this
  // trio) + its own CEF view (bunium_create_view/bunium_attach_window
  // above, bunium_navigate for src changes, bunium_close_view to tear
  // down) -- see WebviewManager in window.ts.
  bunium_create_native_sublayer: {
    args: [FFIType.ptr, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.i32],
    returns: FFIType.ptr,
  },
  bunium_set_native_sublayer_frame: {
    args: [FFIType.ptr, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.i32],
    returns: FFIType.void,
  },
  bunium_close_native_sublayer: { args: [FFIType.ptr], returns: FFIType.void },
  // Stacking/z-order sync for sibling bunium-webview elements -- moves a
  // sublayer to the top of both its CALayer paint order and the
  // hit-testing registry. See WebviewManager.updateOrder (window.ts) and
  // the comment on bunium_raise_native_sublayer (bunium_shim.cpp).
  bunium_raise_native_sublayer: {
    args: [FFIType.ptr, FFIType.ptr],
    returns: FFIType.void,
  },
  // DOM overflow:hidden ancestor clipping for <bunium-webview> sublayers --
  // see WebviewManager.updateClip (window.ts) and the detailed mechanism
  // comment on bunium_sublayer_set_clip (bunium_window_mac.mm).
  bunium_set_native_sublayer_clip: {
    args: [FFIType.ptr, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.i32],
    returns: FFIType.void,
  },
  bunium_clear_native_sublayer_clip: {
    args: [FFIType.ptr],
    returns: FFIType.void,
  },
  // Test/verification-only readback -- confirms the native clip layer
  // actually applied, since there's no other way for JS to observe it.
  bunium_get_native_sublayer_clip: {
    args: [
      FFIType.ptr,
      FFIType.ptr,
      FFIType.ptr,
      FFIType.ptr,
      FFIType.ptr,
      FFIType.ptr,
    ],
    returns: FFIType.void,
  },
  // Readback used only by tests/examples to verify a sublayer actually
  // moved -- not part of WebviewManager's own steady-state hot path.
  bunium_get_native_sublayer_frame: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr],
    returns: FFIType.void,
  },
  bunium_create_native_window: {
    args: [FFIType.i32, FFIType.i32, FFIType.cstring, FFIType.i32, FFIType.i32],
    returns: FFIType.ptr,
  },
  // Deliberately a separate call from bunium_create_native_window, not more
  // params on it -- see the comment on bunium_window_set_constraints
  // (bunium_window_mac.mm) for why (a bun:ffi >8-arg issue on arm64).
  bunium_set_native_window_constraints: {
    args: [
      FFIType.ptr,
      FFIType.i32,
      FFIType.i32,
      FFIType.i32,
      FFIType.i32,
      FFIType.i32,
    ],
    returns: FFIType.void,
  },
  bunium_get_native_window_is_resizable: {
    args: [FFIType.ptr],
    returns: FFIType.i32,
  },
  bunium_get_native_window_size_constraints: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr],
    returns: FFIType.void,
  },
  bunium_attach_window: {
    args: [FFIType.ptr, FFIType.ptr],
    returns: FFIType.void,
  },
  bunium_pump_native_events: { args: [], returns: FFIType.void },
  // Test-only in practice today (real clicks arrive via the native
  // BuniumContentView mouse handlers, not through this binding) -- exposed
  // here so examples/webview-hit-test.ts can dispatch a synthetic click at
  // a <bunium-webview>'s auto-created sublayer the same way
  // sublayer-hit-test.ts does for hand-wired sublayers, without needing a
  // second raw dlopen() just for this one symbol.
  bunium_dispatch_mouse_click: {
    args: [
      FFIType.ptr,
      FFIType.i32,
      FFIType.i32,
      FFIType.i32,
      FFIType.i32,
      FFIType.i32,
    ],
    returns: FFIType.void,
  },
  bunium_get_native_window_size: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.ptr],
    returns: FFIType.void,
  },
  bunium_window_get_id: { args: [FFIType.ptr], returns: FFIType.i32 },
  bunium_get_native_window_scale: { args: [FFIType.ptr], returns: FFIType.f64 },
  bunium_close_native_window: { args: [FFIType.ptr], returns: FFIType.void },
  bunium_is_native_window_closed: { args: [FFIType.ptr], returns: FFIType.i32 },
  bunium_shutdown: { args: [], returns: FFIType.void },
  // Phase 5 system surface: native menu bar (NSMenu) + system tray
  // (NSStatusItem). Menu-item/tray events are pushed into a native inbox and
  // drained by the app pump via bunium_poll_system_event -- the same envelope
  // pattern as bunium_poll_message (see SystemEventBus in src/system/events.ts).
  bunium_system_menu_create: { args: [], returns: FFIType.ptr },
  bunium_system_menu_add_item: {
    args: [FFIType.ptr, FFIType.cstring, FFIType.i32],
    returns: FFIType.ptr,
  },
  bunium_system_menu_add_submenu: {
    args: [FFIType.ptr, FFIType.cstring],
    returns: FFIType.ptr,
  },
  bunium_system_menu_add_separator: {
    args: [FFIType.ptr],
    returns: FFIType.void,
  },
  bunium_system_set_application_menu: {
    args: [FFIType.ptr],
    returns: FFIType.void,
  },
  bunium_system_tray_create: { args: [FFIType.cstring], returns: FFIType.ptr },
  bunium_system_tray_set_title: {
    args: [FFIType.ptr, FFIType.cstring],
    returns: FFIType.void,
  },
  bunium_system_tray_set_icon: {
    args: [FFIType.ptr, FFIType.cstring, FFIType.i32],
    returns: FFIType.void,
  },
  bunium_system_tray_set_symbol: {
    args: [FFIType.ptr, FFIType.cstring],
    returns: FFIType.void,
  },
  bunium_system_tray_set_click: {
    args: [FFIType.ptr, FFIType.i32],
    returns: FFIType.void,
  },
  bunium_system_tray_get_id: { args: [FFIType.ptr], returns: FFIType.i64 },
  bunium_system_tray_set_menu: {
    args: [FFIType.ptr, FFIType.ptr],
    returns: FFIType.void,
  },
  bunium_system_tray_destroy: { args: [FFIType.ptr], returns: FFIType.void },
  bunium_poll_system_event: { args: [], returns: FFIType.ptr },
  // OS notifications (UNUserNotificationCenter) -- see
  // native/mac/bunium_system_notify_mac.mm. Fire-and-forget; clicks come
  // back as bunium-notification-click events through bunium_poll_system_event.
  bunium_system_notify: {
    args: [FFIType.cstring, FFIType.cstring, FFIType.i32],
    returns: FFIType.void,
  },
  // Native dialogs (NSOpenPanel/NSSavePanel/NSAlert) -- see
  // native/mac/bunium_system_dialogs_mac.mm. Never block the pump; results
  // arrive as bunium-dialog-result events keyed by requestId.
  bunium_system_dialog_open: {
    args: [
      FFIType.cstring,
      FFIType.i32,
      FFIType.i32,
      FFIType.i32,
      FFIType.cstring,
      FFIType.i32,
    ],
    returns: FFIType.void,
  },
  bunium_system_dialog_save: {
    args: [FFIType.cstring, FFIType.cstring, FFIType.cstring, FFIType.i32],
    returns: FFIType.void,
  },
  bunium_system_dialog_message: {
    args: [
      FFIType.cstring,
      FFIType.cstring,
      FFIType.cstring,
      FFIType.cstring,
      FFIType.i32,
    ],
    returns: FFIType.void,
  },
  // Phase 9 auto-update: bsdiff/bspatch delta patches (see
  // native/mac/bunium_bsdiff_wrap.mm). All take paths + ints; the int64_t
  // out-param is passed as FFIType.ptr like the other out-pointer args.
  bunium_bsdiff: {
    args: [FFIType.cstring, FFIType.cstring, FFIType.cstring],
    returns: FFIType.i32,
  },
  bunium_bspatch: {
    args: [FFIType.cstring, FFIType.cstring, FFIType.cstring],
    returns: FFIType.i32,
  },
  bunium_bsdiff_patch_info: {
    args: [FFIType.cstring, FFIType.ptr],
    returns: FFIType.i32,
  },
});

export function cstr(s: string): Buffer {
  return Buffer.from(`${s}\0`);
}
