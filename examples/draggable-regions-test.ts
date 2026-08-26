// Verifies the auto -webkit-app-region:drag scanner computes correct
// regions and bunium_is_window_point_draggable matches them precisely.
// Can't verify performWindowDragWithEvent actually moving the window --
// that needs a real OS-level drag gesture, same category as other
// Cocoa-interactive gaps this session (only reachable through
// BuniumContentView's real mouseDown:, not through the raw dispatch ABI
// test scripts use, which deliberately bypasses the drag-region check).
import { dlopen, FFIType } from "bun:ffi";
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
  bunium_attach_window: {
    args: [FFIType.ptr, FFIType.ptr],
    returns: FFIType.void,
  },
  bunium_poll_message: { args: [FFIType.ptr], returns: FFIType.ptr },
  bunium_set_drag_regions: {
    args: [FFIType.ptr, FFIType.cstring],
    returns: FFIType.void,
  },
  bunium_is_window_point_draggable: {
    args: [FFIType.ptr, FFIType.i32, FFIType.i32],
    returns: FFIType.i32,
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
  cstr("draggable regions test"),
  0,
  1,
);

// a titlebar-like draggable strip at the top, 400x40
const html = `data:text/html,${encodeURIComponent(`
<body style="margin:0">
<div style="width:400px;height:40px;background:gray;-webkit-app-region:drag"></div>
<div style="width:400px;height:260px;background:white"></div>
</body>
`)}`;
const view = lib.symbols.bunium_create_view(cstr(html), 400, 300, 0);
lib.symbols.bunium_attach_window(view, win);

const start = performance.now();
while (performance.now() - start < 1500) {
  lib.symbols.bunium_do_message_loop_work();
  lib.symbols.bunium_pump_native_events();

  // drain messages -- pollMessages() in window.ts normally does this and
  // forwards __bunium_drag_regions to bunium_set_drag_regions; replicate
  // that here since this test uses the raw ABI directly
  for (;;) {
    const envelopePtr = lib.symbols.bunium_poll_message(view);
    if (envelopePtr === null) break;
    const { CString } = require("bun:ffi");
    const envelope = JSON.parse(new CString(envelopePtr).toString());
    if (envelope.name === "__bunium_drag_regions") {
      lib.symbols.bunium_set_drag_regions(view, cstr(envelope.payload));
    }
  }
  await Bun.sleep(8);
}

// inside the drag strip (top area)
const insideDrag = lib.symbols.bunium_is_window_point_draggable(win, 200, 20);
// outside it (lower white area)
const outsideDrag = lib.symbols.bunium_is_window_point_draggable(win, 200, 200);

console.log("point inside drag strip (200,20) draggable:", !!insideDrag);
console.log("point outside drag strip (200,200) draggable:", !!outsideDrag);
console.log(
  "draggable region detection correct:",
  !!insideDrag && !outsideDrag,
);

lib.symbols.bunium_close_view(view);
lib.symbols.bunium_close_native_window(win);
lib.symbols.bunium_shutdown();
