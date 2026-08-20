// Proves clicks route to the correct view: a click inside the sublayer's
// screen rect should reach the INNER view, not the outer one, and vice
// versa. Each page has its own onclick handler flipping its own
// background, verified independently via each view's own pixel readback.
import { dlopen, FFIType, type Pointer, ptr } from "bun:ffi";
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
  cstr("sublayer hit test"),
  0,
  1,
);

function clickablePage() {
  return `data:text/html,${encodeURIComponent(`
<body style="margin:0">
<div id="box" style="width:100%;height:100%;background:red"
     onclick="document.getElementById('box').style.background='lime'"></div>
</body>
`)}`;
}

// outer fills the whole window
const outerView = lib.symbols.bunium_create_view(
  cstr(clickablePage()),
  600,
  400,
  0,
);
lib.symbols.bunium_attach_window(outerView, win);

// inner is a sublayer positioned at (100,100)-(350,250)
const sublayer = lib.symbols.bunium_create_native_sublayer(
  win,
  100,
  100,
  250,
  150,
);
const innerView = lib.symbols.bunium_create_view(
  cstr(clickablePage()),
  250,
  150,
  0,
);
lib.symbols.bunium_attach_window(innerView, sublayer);

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

function readCenterPixel(view: Pointer | null) {
  const wBuf = new Int32Array(1);
  const hBuf = new Int32Array(1);
  const framePtr = lib.symbols.bunium_get_frame(view, ptr(wBuf), ptr(hBuf));
  const { toArrayBuffer } = require("bun:ffi");
  const bgra = new Uint8Array(
    toArrayBuffer(framePtr!, 0, wBuf[0]! * hBuf[0]! * 4),
  );
  const idx =
    (Math.floor(hBuf[0]! / 2) * wBuf[0]! + Math.floor(wBuf[0]! / 2)) * 4;
  return { r: bgra[idx + 2]!, g: bgra[idx + 1]!, b: bgra[idx]! };
}

await pump(500);
console.log("outer before:", readCenterPixel(outerView));
console.log("inner before:", readCenterPixel(innerView));

// click at (200, 150) in window coords -- inside the sublayer's rect
// (100,100)-(350,250) -- should route to the INNER view only
lib.symbols.bunium_dispatch_mouse_click(win, 200, 150, 0, 0, 1);
lib.symbols.bunium_dispatch_mouse_click(win, 200, 150, 0, 1, 1);
await pump(500);

const outerAfterInnerClick = readCenterPixel(outerView);
const innerAfterInnerClick = readCenterPixel(innerView);
console.log("outer after click-inside-sublayer:", outerAfterInnerClick);
console.log("inner after click-inside-sublayer:", innerAfterInnerClick);

const outerStayedRed =
  outerAfterInnerClick.r > 200 && outerAfterInnerClick.g < 50;
const innerTurnedGreen =
  innerAfterInnerClick.g > 100 && innerAfterInnerClick.r < 100;
console.log(
  "click routed to INNER only (outer untouched):",
  outerStayedRed && innerTurnedGreen,
);

// now click at (50, 50) -- outside the sublayer's rect -- should route to OUTER
lib.symbols.bunium_dispatch_mouse_click(win, 50, 50, 0, 0, 1);
lib.symbols.bunium_dispatch_mouse_click(win, 50, 50, 0, 1, 1);
await pump(500);

const outerAfterOuterClick = readCenterPixel(outerView);
console.log("outer after click-outside-sublayer:", outerAfterOuterClick);
const outerTurnedGreen =
  outerAfterOuterClick.g > 100 && outerAfterOuterClick.r < 100;
console.log("second click routed to OUTER:", outerTurnedGreen);

lib.symbols.bunium_close_view(outerView);
lib.symbols.bunium_close_view(innerView);
lib.symbols.bunium_close_native_sublayer(sublayer);
lib.symbols.bunium_close_native_window(win);
lib.symbols.bunium_shutdown();
