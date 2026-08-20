// Verifies bunium_dispatch_mouse_click actually reaches the CEF view and
// the page reacts to it -- by calling the dispatch ABI directly (same as
// what BuniumContentView's mouseDown:/mouseUp: do internally), not by
// synthesizing a real OS-level click. Whether a real click on this window
// in this sandboxed environment would even reach our NSView at all is a
// separate, currently-untestable question (same category as other
// visual/interactive gaps this session -- needs a real desktop).
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
  cstr("mouse click test"),
  0,
  1,
);

const html = `data:text/html,${encodeURIComponent(`
<body style="margin:0">
<div id="box" style="width:400px;height:300px;background:red"
     onclick="document.getElementById('box').style.background='lime'"></div>
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
  const { toArrayBuffer } = require("bun:ffi");
  const bgra = new Uint8Array(toArrayBuffer(framePtr!, 0, w[0]! * h[0]! * 4));
  const idx = (Math.floor(h[0]! / 2) * w[0]! + Math.floor(w[0]! / 2)) * 4;
  return { r: bgra[idx + 2]!, g: bgra[idx + 1]!, b: bgra[idx]! };
}

await pump(500);
const before = readCenterPixel();
console.log("before click (center pixel RGB):", before);

// mouseDown then mouseUp at center = one click, same as BuniumContentView does
lib.symbols.bunium_dispatch_mouse_click(win, 200, 150, 0, 0, 1);
lib.symbols.bunium_dispatch_mouse_click(win, 200, 150, 0, 1, 1);

await pump(500);
const after = readCenterPixel();
console.log("after click (center pixel RGB):", after);

const wasRed = before.r > 200 && before.g < 50;
const isGreen = after.g > 100 && after.r < 100;
console.log("click reached CEF and page reacted:", wasRed && isGreen);

lib.symbols.bunium_close_view(view);
lib.symbols.bunium_close_native_window(win);
lib.symbols.bunium_shutdown();
