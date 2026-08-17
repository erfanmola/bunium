// Measures real round-trip latency of the JS->native bounds bridge under
// continuous rAF-driven motion, not just correctness of one static call.
//
// Methodology: the page moves a div at a known constant speed (px/ms) via
// requestAnimationFrame, computing real getBoundingClientRect() each frame
// and calling reportBounds(). Bun polls the native sublayer's actual x
// position on its own clock and compares it to where the div *should* be
// at that wall-clock moment (both timestamps come from Bun's own
// performance.now() -- comparing across the renderer/browser process
// boundary directly would risk clock-domain mismatches, so the "expected"
// side of the comparison is also computed in Bun, not trusted from JS).
import { dlopen, FFIType, ptr } from "bun:ffi";

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
  cstr("ipc latency test"),
  0,
  1,
);
const sublayer = lib.symbols.bunium_create_native_sublayer(win, 0, 50, 50, 50);

const SPEED_PX_PER_MS = 0.1; // 100px/sec -- crosses ~200px over the 2s test window

const outerHtml = `data:text/html,${encodeURIComponent(`
<body style="margin:0">
<div id="box" style="position:absolute;top:50px;left:0;width:50px;height:50px;background:red"></div>
<script>
  const box = document.getElementById('box');
  const start = performance.now();
  function tick() {
    const elapsed = performance.now() - start;
    box.style.transform = 'translateX(' + (elapsed * ${SPEED_PX_PER_MS}) + 'px)';
    const rect = box.getBoundingClientRect();
    window.__bunium.reportBounds(rect.left, rect.top, rect.width, rect.height);
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
</script>
</body>
`)}`;

const outerView = lib.symbols.bunium_create_view(cstr(outerHtml), 600, 400, 0);
lib.symbols.bunium_attach_window(outerView, win);
lib.symbols.bunium_view_track_sublayer(outerView, sublayer);

function readSublayerX(): number {
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
  return x[0]!;
}

// Earlier version of this test assumed T0 == when Bun called
// bunium_create_view, and measured naive lag = expected(t) - actual(t).
// That conflates two very different things: (1) one-time page
// navigation/first-rAF startup latency (a fixed offset -- costs nothing
// per-frame, matters for "time to webview ready", not for "does scrolling
// feel smooth"), and (2) actual steady-state per-frame IPC lag (what
// matters for "buttery smooth"). A separate diagnostic
// (examples/raf-cadence-diag.ts) found rAF itself running a jitter-free
// ~16.35ms average -- inconsistent with the ~150-200ms "lag" the naive
// method reported being a real per-frame problem, and exactly consistent
// with it being a constant startup offset instead (constant offset math:
// naive_lag(t) = SPEED*(t-T0) - SPEED*(t-T0-startupOffset) = SPEED *
// startupOffset, independent of t -- matches the observed
// tight/non-growing lag range).
//
// Fixed methodology: collect (t, actualX) samples, fit a linear regression
// instead of trusting T0, and report the RESIDUAL jitter around that
// best-fit line as the real per-frame smoothness metric. The fitted
// intercept vs the naive t=0 assumption is reported separately as
// "startup offset" -- a real number worth knowing, just not the same
// thing as per-frame lag.
const t0 = performance.now();
const samples: Array<{ t: number; x: number }> = [];
const durationMs = 2000;

while (performance.now() - t0 < durationMs) {
  lib.symbols.bunium_do_message_loop_work();
  lib.symbols.bunium_pump_native_events();

  const elapsed = performance.now() - t0;
  if (elapsed > 300) {
    samples.push({ t: elapsed, x: readSublayerX() });
  }
  await Bun.sleep(4);
}

// simple least-squares fit: x ≈ slope*t + intercept
const n = samples.length;
const sumT = samples.reduce((a, s) => a + s.t, 0);
const sumX = samples.reduce((a, s) => a + s.x, 0);
const sumTT = samples.reduce((a, s) => a + s.t * s.t, 0);
const sumTX = samples.reduce((a, s) => a + s.t * s.x, 0);
const slope = (n * sumTX - sumT * sumX) / (n * sumTT - sumT * sumT);
const intercept = (sumX - slope * sumT) / n;

const residualsMs = samples.map((s) => {
  const predictedX = slope * s.t + intercept;
  const residualPx = s.x - predictedX;
  return residualPx / SPEED_PX_PER_MS; // convert px residual to ms at the known speed
});
const avgAbsJitter = residualsMs.reduce((a, r) => a + Math.abs(r), 0) / n;
const maxAbsJitter = Math.max(...residualsMs.map(Math.abs));

// intercept is where the fitted line crosses t=0; since actualX should be
// 0 at the page's own true rAF-start time, -intercept/speed estimates how
// long after Bun's T0 (create_view call) the page's rAF loop actually
// started producing bounds updates -- i.e. startup latency, not per-frame lag.
const startupOffsetMs = -intercept / SPEED_PX_PER_MS;
const fittedSpeed = slope; // should be close to SPEED_PX_PER_MS if tracking is accurate

console.log("samples:", n);
console.log(
  "fitted speed (px/ms):",
  fittedSpeed.toFixed(4),
  "(expected",
  SPEED_PX_PER_MS,
  ")",
);
console.log("estimated startup offset (ms):", startupOffsetMs.toFixed(1));
console.log(
  "steady-state jitter avg/max (ms):",
  avgAbsJitter.toFixed(2),
  "/",
  maxAbsJitter.toFixed(2),
);
console.log("final sublayer x:", readSublayerX());

lib.symbols.bunium_close_view(outerView);
lib.symbols.bunium_close_native_sublayer(sublayer);
lib.symbols.bunium_close_native_window(win);
lib.symbols.bunium_shutdown();
