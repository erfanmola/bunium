// Diagnostic for task #21: is rAF itself throttled in the renderer (points
// to Chromium occlusion/backgrounding throttling), or does rAF run at a
// normal ~16ms cadence and the delay is somewhere in IPC delivery /
// native-side processing instead? Page logs its own rAF tick gaps via
// console.log, forwarded to our stderr via the new OnConsoleMessage hook.
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
  bunium_attach_window: {
    args: [FFIType.ptr, FFIType.ptr],
    returns: FFIType.void,
  },
  bunium_close_view: { args: [FFIType.ptr], returns: FFIType.void },
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
  cstr("raf cadence diag"),
  0,
  1,
);

const html = `data:text/html,${encodeURIComponent(`
<script>
  let last = performance.now();
  let count = 0;
  const gaps = [];
  function tick() {
    const now = performance.now();
    gaps.push(now - last);
    last = now;
    count++;
    if (count === 60) {
      const avg = gaps.reduce((a,b)=>a+b,0) / gaps.length;
      const max = Math.max(...gaps);
      console.log('RAF_STATS avg=' + avg.toFixed(2) + ' max=' + max.toFixed(2) + ' samples=' + gaps.length);
      return; // stop after 60 frames
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
</script>
`)}`;

const view = lib.symbols.bunium_create_view(cstr(html), 600, 400, 0);
lib.symbols.bunium_attach_window(view, win);

const start = performance.now();
while (performance.now() - start < 5000) {
  lib.symbols.bunium_do_message_loop_work();
  lib.symbols.bunium_pump_native_events();
  await Bun.sleep(4);
}

lib.symbols.bunium_close_view(view);
lib.symbols.bunium_close_native_window(win);
lib.symbols.bunium_shutdown();
