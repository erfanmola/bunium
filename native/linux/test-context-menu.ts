// Verifies OnBeforeContextMenu's crash-suppression (native/mac/bunium_common.h,
// shared unguarded across all platforms) actually holds on a real Linux
// desktop, not just by inspection. Without this handler, CEF falls back to
// its own native (Views-framework) context menu on right-click, which isn't
// supported in windowless/OSR rendering and crashes the whole process --
// PLAN.md documents this as verified-by-inspection-only on Linux ("not yet
// exercised by a real right-click"). This fixture closes that gap: it
// dispatches a real right-button mouseDown+mouseUp via
// bunium_dispatch_mouse_click (button=2 -> MBT_RIGHT in bunium_shim.cpp,
// same ABI mouse-click-test.ts already uses for left-clicks), against a
// real GTK/X11 desktop session (not headless Xvfb) so CEF's real
// Views/GTK context-menu codepath is actually exercised, then confirms the
// process is still alive and the page's own `contextmenu` JS handler (which
// OnBeforeContextMenu does NOT suppress -- only CEF's native menu) fired.
//
// Run against a real desktop session, not Xvfb, e.g.:
//   DISPLAY=:0 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus \
//     XDG_RUNTIME_DIR=/run/user/1000 bun native/linux/test-context-menu.ts
import { dlopen, FFIType, ptr, toArrayBuffer } from "bun:ffi";
import { paths } from "../../src/paths";

const lib = dlopen(paths.shim, {
  bunium_init: {
    args: [FFIType.cstring, FFIType.cstring, FFIType.cstring, FFIType.cstring],
    returns: FFIType.i32,
  },
  bunium_do_message_loop_work: { args: [], returns: FFIType.void },
  bunium_pump_native_events: { args: [], returns: FFIType.void },
  bunium_create_view: {
    args: [FFIType.cstring, FFIType.i32, FFIType.i32, FFIType.i32],
    returns: FFIType.ptr,
  },
  bunium_create_native_window: {
    args: [FFIType.i32, FFIType.i32, FFIType.cstring, FFIType.i32, FFIType.i32],
    returns: FFIType.ptr,
  },
  bunium_attach_window: {
    args: [FFIType.ptr, FFIType.ptr],
    returns: FFIType.void,
  },
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
  bunium_get_frame: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.ptr],
    returns: FFIType.ptr,
  },
  bunium_close_view: { args: [FFIType.ptr], returns: FFIType.void },
  bunium_close_native_window: { args: [FFIType.ptr], returns: FFIType.void },
  bunium_shutdown: { args: [], returns: FFIType.void },
});

function cstr(s: string) {
  return Buffer.from(`${s}\0`);
}

const ok = lib.symbols.bunium_init(
  cstr(paths.subprocess),
  cstr(paths.frameworkDir),
  cstr(paths.resourcesDir),
  cstr(""),
);
if (!ok) throw new Error("init failed");

const win = lib.symbols.bunium_create_native_window(
  400,
  300,
  cstr("context menu test"),
  0,
  1,
);

const html = `data:text/html,${encodeURIComponent(`
<body style="margin:0">
<div id="box" style="width:400px;height:300px;background:red"
     oncontextmenu="document.getElementById('box').style.background='lime'; return false;"></div>
</body>
`)}`;
const view = lib.symbols.bunium_create_view(cstr(html), 400, 300, 0);
lib.symbols.bunium_attach_window(view, win);

function pump(ms: number) {
  return (async () => {
    const start = performance.now();
    while (performance.now() - start < ms) {
      lib.symbols.bunium_do_message_loop_work();
      lib.symbols.bunium_pump_native_events();
      await Bun.sleep(4);
    }
  })();
}

function readCenterPixel(): { r: number; g: number; b: number } {
  const w = new Int32Array(1);
  const h = new Int32Array(1);
  const framePtr = lib.symbols.bunium_get_frame(view, ptr(w), ptr(h));
  const bgra = new Uint8Array(toArrayBuffer(framePtr!, 0, w[0]! * h[0]! * 4));
  const idx = (Math.floor(h[0]! / 2) * w[0]! + Math.floor(w[0]! / 2)) * 4;
  return { r: bgra[idx + 2]!, g: bgra[idx + 1]!, b: bgra[idx]! };
}

await pump(500);
const before = readCenterPixel();
console.log("before right-click (center pixel RGB):", before);

// mouseDown then mouseUp with button=2 (MBT_RIGHT) at center -- real
// right-click, exercises CEF's native context-menu codepath for real.
lib.symbols.bunium_dispatch_mouse_click(win, 200, 150, 2, 0, 1);
lib.symbols.bunium_dispatch_mouse_click(win, 200, 150, 2, 1, 1);

await pump(500);
const after = readCenterPixel();
console.log("after right-click (center pixel RGB):", after);

const wasRed = before.r > 200 && before.g < 50;
const isGreen = after.g > 100 && after.r < 100;
console.log("process still alive after right-click (no crash):", true);
console.log(
  "page's own contextmenu handler fired (native CEF menu correctly suppressed):",
  wasRed && isGreen,
);

lib.symbols.bunium_close_view(view);
lib.symbols.bunium_close_native_window(win);
lib.symbols.bunium_shutdown();
process.exit(0);
