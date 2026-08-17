// Low-level proof that two independently-rendered CEF views can composite
// as native sibling layers in one window -- the mechanical core of a
// DOM-integrated <webview>. Uses raw shim symbols directly, not
// BuniumWindow, since this ABI isn't public API yet (no JS<->native DOM
// bounds sync exists -- the sublayer's position here is just hardcoded).
import { dlopen, FFIType } from "bun:ffi";

const repoRoot = new URL("..", import.meta.url).pathname;
const lib = dlopen(`${repoRoot}native/build/bunium_shim.dylib`, {
  bunium_init: {
    args: [FFIType.cstring, FFIType.cstring, FFIType.cstring],
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
  bunium_frame_count: { args: [FFIType.ptr], returns: FFIType.u64 },
  bunium_close_view: { args: [FFIType.ptr], returns: FFIType.void },
  bunium_close_native_sublayer: { args: [FFIType.ptr], returns: FFIType.void },
  bunium_close_native_window: { args: [FFIType.ptr], returns: FFIType.void },
  bunium_shutdown: { args: [], returns: FFIType.void },
});

function cstr(s: string) {
  return Buffer.from(`${s}\0`);
}

const frameworkDir = `${repoRoot}vendor/cef-macosarm64/Release/Chromium Embedded Framework.framework`;
const ok = lib.symbols.bunium_init(
  cstr(`${repoRoot}native/build/bunium_subprocess`),
  cstr(frameworkDir),
  cstr(`${frameworkDir}/Resources`),
);
if (!ok) throw new Error("init failed");

const win = lib.symbols.bunium_create_native_window(
  600,
  400,
  cstr("multi-layer test"),
  0,
  1,
);

// "outer app" -- fills the whole window
const outerHtml = "data:text/html,<body style='background:darkred'></body>";
const outerView = lib.symbols.bunium_create_view(cstr(outerHtml), 600, 400, 0);
lib.symbols.bunium_attach_window(outerView, win);

// "embedded webview" -- a smaller sublayer positioned inside the window,
// completely independent CEF render process from the outer view
const innerHtml = "data:text/html,<body style='background:lime'></body>";
const sublayer = lib.symbols.bunium_create_native_sublayer(
  win,
  100,
  100,
  250,
  150,
);
const innerView = lib.symbols.bunium_create_view(cstr(innerHtml), 250, 150, 0);
lib.symbols.bunium_attach_window(innerView, sublayer);

const start = performance.now();
while (performance.now() - start < 2000) {
  lib.symbols.bunium_do_message_loop_work();
  lib.symbols.bunium_pump_native_events();
  await Bun.sleep(8);
}

console.log("outer frameCount:", lib.symbols.bunium_frame_count(outerView));
console.log("inner frameCount:", lib.symbols.bunium_frame_count(innerView));
console.log(
  "both views rendered independently:",
  lib.symbols.bunium_frame_count(outerView) > 0n &&
    lib.symbols.bunium_frame_count(innerView) > 0n,
);

lib.symbols.bunium_close_view(outerView);
lib.symbols.bunium_close_view(innerView);
lib.symbols.bunium_close_native_sublayer(sublayer);
lib.symbols.bunium_close_native_window(win);
lib.symbols.bunium_shutdown();
