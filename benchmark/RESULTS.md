# bunium vs Electron — benchmark results

Raw data and methodology backing `docs/guide/benchmarks.md`. Regenerate with:

```
cd benchmark/electron-minimal && npm install && cd ../electron-mini-app && npm install
cd ../bunium-minimal && bun install && cd ../bunium-mini-app && bun install
cd ../.. && bun run build:native:mac
BENCH_REPS=3 BENCH_IDLE_SECONDS=6 bun benchmark/scripts/report.ts
```

(`bun link` the root `bunium` package first — see `benchmark/*/package.json`'s
`"bunium": "link:bunium"` dependency; the framework isn't published yet.)

## Environment (this run)

- Hardware: Apple M2 Pro, macOS 27.0 (arm64)
- bun 1.4.0, node v26.7.0
- bunium: this repo's working tree, native stack rebuilt fresh
- Electron: 44.0.0 (latest stable at benchmark time)
- 3 repetitions per scenario, sequential (never parallel — CEF's
  ProcessSingleton aborts a concurrent second bunium process, and running
  Electron alongside would contaminate the CPU/RSS samples anyway), median
  reported. Real GPU compositing on both sides (no `--disable-gpu`) — that
  switch only exists in CI to work around GitHub's GPU-less macOS runners
  (see `.github/workflows/mac-smoke.yml`), it's not representative of a
  real user's machine.

## What "minimal" and "mini-app" are

- **minimal**: one window, one inline `data:` URL page (`<h1>bench</h1>`,
  dark background). `benchmark/bunium-minimal/main.ts` /
  `benchmark/electron-minimal/main.js` — deliberately near-identical: same
  HTML, same window size, same milestone-logging protocol.
- **mini-app**: a small dashboard (sidebar nav, 200-row table, one IPC
  round-trip counter button) — `benchmark/shared/{index.html,app.js}` is
  the literal same file for both hosts (symlinked into each app dir), only
  `bridge.js` (host-specific `window.bench.increment()`/`onCount()` glue
  over each framework's IPC primitive) and the main-process file differ.
  Runs an automatic 50-call IPC round-trip sweep on load.

## Round 2 (2026-08-28): "beat Electron on every macOS benchmark" pass

User directive: close every gap vs Electron, macOS first. Three targeted
native changes landed (see `PLAN.md`'s Post-Phase-11 macOS-perf entry for
full detail); this table is before → after, median of 3 reps:

| metric | bunium-minimal | electron-minimal | bunium-mini-app | electron-mini-app |
|---|---|---|---|---|
| process start → first paint (ms) | 320 → 305 | 161 → 163 | 350 → 327 | 195 → 203 |
| idle RSS, full process tree (MB) | 466.8 → **403.0** | 416.3 → 418.1 | 532.3 → 467.3 | 451.2 → 450.9 |
| idle CPU, full process tree (%) | 56.5 → 55.0 | 0 | 56.0 → 57.0 | 0 |
| process count (main + helpers) | 6 → **5** | 5 | 6 → **5** | 5 |
| mini-app DOM render, 200 rows (ms) | — | — | 0.9 → 1.0 | 1.0 → 1.0 |
| IPC round trip, avg of 50 (ms) | — | — | 11.9 → **2.5** | 0.2 |

**Beaten or matched:** on-disk framework size (was already winning),
Bun-vs-Node process boot (was already winning), **process count** (now
tied, 5=5), **minimal-app idle RSS** (now winning, 403 vs 418 — first time
bunium beats Electron on a resource metric that started behind).

**Substantially improved, not yet beaten:** IPC round-trip latency (~4.3x
faster, 11.9ms → 2.5ms, still behind Electron's 0.2ms), mini-app idle RSS
(gap closed from -81MB to -16.5MB).

**Unchanged, root-caused, needs a bigger follow-up:** idle CPU (stayed
~55-57%) and startup time (stayed ~300-330ms vs Electron's ~160-200ms).
Both are explained below — neither is a quick win.

### What actually moved the numbers

1. **Adaptive message pump** (`src/app.ts`, `native/mac/bunium_shim.cpp`,
   `native/mac/bunium_common.h`) — replaced the fixed 8ms `setInterval`
   driving `CefDoMessageLoopWork()` with CEF's own
   `external_message_pump` + `OnScheduleMessagePumpWork(delay_ms)` signal,
   so the host only wakes as often as CEF actually asks (bounded by an 8ms
   idle floor, unchanged from before — see below for why it wasn't raised).
   **Result: IPC latency dropped ~4.3x.** Idle CPU did not move — see the
   "why idle CPU didn't move" section.
2. **Disabled Chromium's spare-renderer-process feature**
   (`OnBeforeCommandLineProcessing`, `bunium_common.h`) —
   `--disable-features=SpareRendererForSitePerProcess`, matching what
   Electron's own renderer command line already carries. bunium's window
   creation already knows its one navigation up front; there's no "next
   tab" to pre-warm a spare renderer for. **Result: process count 6→5**
   (now matches Electron exactly), and RSS followed: minimal-app RSS beat
   Electron for the first time, mini-app RSS gap closed by ~80%.

### What was investigated and found to be a dead end (documented so it isn't re-investigated blind)

- **"Mirror Electron's default Chromium switches" (original Phase 2
  plan).** Dumped Electron 44's actual renderer/gpu/utility process command
  lines via `ps` and compared directly against bunium's. They're nearly
  identical (`--num-raster-threads=4`, `--enable-zero-copy`,
  `--enable-gpu-memory-buffer-compositor-resources`, etc. — all Chromium-
  internal defaults neither app sets explicitly). Electron does **not** set
  any background-service-disabling switches
  (`--disable-background-networking`, `--disable-sync`, etc.) by default.
  There was no switches-based startup/RSS lever to copy — the plan's
  premise didn't hold, so it wasn't blindly executed anyway.
- **"Chrome-runtime full-browser overhead" (a hypothesis raised mid-
  session).** A contaminated-CEF-profile test run once showed bunium
  loading `chrome://new-tab-page`, initializing a UKM database, top-sites
  backend, segmentation platform, etc. — looked like a smoking gun for
  heavyweight "full Chrome browser" initialization. Verified against a
  clean profile: this was **session-restore** behavior after an unclean
  shutdown (this session killed a lot of processes hard while testing),
  not baseline behavior. A clean `BUNIUM_CEF_VERBOSE=1` startup shows none
  of it. Not a real lever; ruled out with evidence, not assumed.

### Why idle CPU didn't move (the real, deeper finding)

The original hypothesis (fixed-interval polling causes wasted idle CPU) was
half right: it fully explained the IPC latency gap, but **not** the CPU
gap. Isolated the two native calls the pump loop makes
(`bunium_do_message_loop_work` / `CefDoMessageLoopWork()` and
`bunium_pump_native_events` / NSApp event drain) with a standalone FFI
harness and measured CPU-time deltas directly (not `ps`'s noisy
lifetime-average `%CPU`):

- Either call alone, at any poll interval tested (8-40ms): negligible CPU
  (<2% of one core).
- **Both calls together: 25-55% of one core**, seemingly at *any* interval
  — moving the JS-side poll interval around (8, 16, 20, 24, 28, 30, 32,
  34, 40ms) did not produce a clean, reproducible cost-vs-interval curve;
  results were noisy across repeated runs at the same interval. That
  inconsistency itself is a finding: **the CPU cost isn't primarily driven
  by how often bunium polls.** It's consistent with CEF's own windowless-
  OSR compositor running a continuous, `windowless_frame_rate`-paced
  (currently fixed at 60fps, `bunium_shim.cpp`) internal repaint/BeginFrame
  cycle regardless of whether page content actually changed — real,
  ongoing compositor work that bunium's message pump merely *services*
  rather than *causes*. A pump-loop change cannot fix a cost that isn't
  coming from the pump loop.

**Real next step, not attempted this pass:** determine whether CEF's
windowless OSR path can be made invalidate-driven (repaint only on actual
dirty regions) instead of continuously repainting at a fixed target frame
rate, or whether `windowless_frame_rate` can be dynamically lowered while
idle and restored during active animation/scroll. This needs its own
investigation (likely CEF source-level, not just a settings flag) and is
out of scope for a single session — logged in `PLAN.md`.

### Why startup time didn't move

No bunium-specific inefficiency was found in the startup path (window-
creation FFI calls are each one synchronous native call, no extra IPC
round trips) — the ~300ms is dominated by `CefInitialize()` itself: loading
and initializing the ~300MB CEF framework dylib and spawning its
subprocess tree, on the critical path to first window. Electron ships a
single precompiled, presumably more startup-optimized executable rather
than a dylib-loaded-at-runtime framework. Closing this gap would mean
either changing how/when CEF initializes relative to bunium's own startup
(e.g. background-initializing CEF while the app does other work — not
applicable to a benchmark that does nothing else) or a fundamentally
different packaging approach. Not attempted this pass.

## Median of 3 reps (original baseline, 2026-08-27, kept for history)

| metric | bunium-minimal | electron-minimal | bunium-mini-app | electron-mini-app |
|---|---|---|---|---|
| process start → first paint (ms) | 320 | 161 | 350 | 195 |
| idle RSS, full process tree (MB) | 466.8 | 416.3 | 532.3 | 451.2 |
| idle CPU, full process tree (%, 2s window) | 56.5 | 0 | 56.0 | 0 |
| process count (main + helpers) | 6 | 5 | 6 | 5 |
| mini-app DOM render, 200 rows (ms) | — | — | 0.9 | 1.0 |
| IPC round trip, avg of 50 (ms) | — | — | 11.9 | 0.2 |

Full per-rep JSON: `benchmark/results/raw.json` / `summary.json` (git-ignored
by default since results are machine-specific — rerun locally to reproduce,
or check them in if you want a committed snapshot).

## Framework/runtime on-disk size

| | size |
|---|---|
| bunium (trimmed CEF + shim, `dist-release/bunium-darwin-arm64/`) | 260M |
| Electron 44 `node_modules/electron/dist` | 306M |

## Bun vs Node process boot (bare `-e "process.exit(0)"`, median of 10)

| | median ms |
|---|---|
| bun 1.4.0 | 6.3 |
| node v26.7.0 | 36.6 |

## Caveats

- One machine, one run of 3 reps per round — enough to see a real signal on
  order-of-magnitude gaps (CPU, IPC, RSS-flip) but not enough to trust
  startup-time numbers to much better than ~10-20% precision.
- macOS arm64 only. Linux/Windows numbers aren't collected here — the same
  three native changes are in shared code (`native/mac/bunium_shim.cpp` and
  `bunium_common.h` are compiled unchanged into the Linux/Windows builds
  too, per `native/linux/build.sh`/`native/win/build.sh`), so Linux/Windows
  should inherit at least the IPC-latency and process-count wins once
  rebuilt there, but this wasn't verified on those platforms this pass.
- The mini-app's Electron `bridge.js` runs with `nodeIntegration: true,
  contextIsolation: false` for a same-shape IPC comparison against bunium's
  single-hop `window.__bunium` channel — a production Electron app should
  use `contextBridge` + a preload script instead, which adds its own (small)
  overhead this benchmark doesn't capture.
- Bundle-size comparison is the raw framework/runtime payload, not a fully
  packaged+signed installer for both sides (Electron packaging wasn't run
  here); treat it as "what ships with the app" rather than "final download
  size."
