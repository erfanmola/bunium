// Proves the JS->native bridge: a page calls window.__bunium.reportBounds()
// and a native sublayer actually moves in response. Still no real DOM
// element tracking (getBoundingClientRect/ResizeObserver/rAF loop) -- the
// page just calls reportBounds with hardcoded then changed coordinates to
// isolate whether the IPC mechanism itself works before wiring it to real
// layout observation.
import { dlopen, FFIType, ptr } from "bun:ffi";
import { paths } from "../src/paths";
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
  bunium_create_native_sublayer: {
    args: [FFIType.ptr, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.i32],
    returns: FFIType.ptr,
  },
  bunium_get_native_sublayer_frame: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr],
    returns: FFIType.void,
  },
  bunium_attach_window: {
    args: [FFIType.ptr, FFIType.ptr],
    returns: FFIType.void,
  },
  bunium_view_track_sublayer: {
    args: [FFIType.ptr, FFIType.ptr],
    returns: FFIType.void,
  },
  bunium_close_view: { args: [FFIType.ptr], returns: FFIType.void },
  bunium_close_native_sublayer: { args: [FFIType.ptr], returns: FFIType.void },
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
  600,
  400,
  cstr("ipc bounds test"),
  0,
  1,
);

// starting rect -- the outer page's JS will move this via reportBounds()
const sublayer = lib.symbols.bunium_create_native_sublayer(win, 10, 10, 50, 50);

function readSublayerFrame() {
  const x = new Int32Array(1);
  const y = new Int32Array(1);
  const w = new Int32Array(1);
  const h = new Int32Array(1);
  lib.symbols.bunium_get_native_sublayer_frame(
    sublayer,
    ptr(x),
    ptr(y),
    ptr(w),
    ptr(h),
  );
  return { x: x[0], y: y[0], w: w[0], h: h[0] };
}

console.log("initial sublayer frame:", readSublayerFrame());

const outerHtml = `data:text/html,${encodeURIComponent(`
<script>
  // Simulates what a real <bunium-webview> element's runtime would do on
  // scroll/resize/transform -- for this test just fire once with fixed
  // coordinates rather than a real getBoundingClientRect() rAF loop.
  window.__bunium.reportBounds(200, 120, 300, 180);
</script>
`)}`;
const outerView = lib.symbols.bunium_create_view(cstr(outerHtml), 600, 400, 0);
lib.symbols.bunium_attach_window(outerView, win);
lib.symbols.bunium_view_track_sublayer(outerView, sublayer);

const start = performance.now();
while (performance.now() - start < 1500) {
  lib.symbols.bunium_do_message_loop_work();
  lib.symbols.bunium_pump_native_events();
  await Bun.sleep(8);
}

const finalFrame = readSublayerFrame();
console.log("final sublayer frame:", finalFrame);
console.log(
  "IPC bridge moved the sublayer:",
  finalFrame.x === 200 &&
    finalFrame.y === 120 &&
    finalFrame.w === 300 &&
    finalFrame.h === 180,
);

lib.symbols.bunium_close_view(outerView);
lib.symbols.bunium_close_native_sublayer(sublayer);
lib.symbols.bunium_close_native_window(win);
lib.symbols.bunium_shutdown();
