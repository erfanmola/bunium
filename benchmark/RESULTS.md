# bunium vs Electron — benchmark results

Raw data and methodology backing `docs/guide/benchmarks.md`. Regenerate with:

```
cd benchmark/electron-minimal && npm install && cd ../electron-mini-app && npm install
cd ../bunium-minimal && bun install && cd ../bunium-mini-app && bun install
cd ../.. && bun run build:native:mac
BENCH_REPS=5 BENCH_IDLE_SECONDS=6 bun benchmark/scripts/report.ts
```

(`bun link` the root `bunium` package first — see `benchmark/*/package.json`'s
`"bunium": "link:bunium"` dependency; the framework isn't published yet.)

## Environment (this run)

- Hardware: Apple M2 Pro, macOS 27.0 (arm64)
- bun 1.4.0, node v26.7.0
- bunium: this repo's working tree, native stack rebuilt fresh
- Electron: 44.0.0 (latest stable at benchmark time)
- 5 repetitions per scenario, sequential (never parallel — CEF's
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

## Current results (2026-08-28, "beat Electron" pass, final)

| metric | bunium-minimal | electron-minimal | bunium-mini-app | electron-mini-app | winner |
|---|---|---|---|---|---|
| framework/runtime on-disk size | 260M | 306M | — | — | **bunium** |
| process boot (bare `-e "exit(0)"`) | 6.3ms (bun) | 36.6ms (node) | — | — | **bunium** |
| process count (main + helpers) | **4** | 5 | **4** | 5 | **bunium** |
| idle RSS, full process tree (MB) | **365.4** | 418.5 | **429.6** | 450.9 | **bunium** |
| process start → first paint (ms) | 300 | **160** | 331 | **195** | Electron |
| idle CPU, full process tree (%) | 59 | **0** | 59 | **0** | Electron |
| IPC round trip, avg of 50 (ms) | — | — | 3.2 | **0.5** | Electron |
| mini-app DOM render, 200 rows (ms) | — | — | 0.9 | 1.0 | ~tied |

**5 of 8 metrics beaten outright** (not tied): disk size, process boot,
process count, minimal-app RSS, mini-app RSS. **3 remain behind**: startup
time, idle CPU, IPC latency — see below for what was tried on each.

## What actually shipped (verified: 37/37 examples, 6/6 scaffolds, every commit)

1. **Adaptive CEF message pump** (`external_message_pump` +
   `OnScheduleMessagePumpWork`, `native/mac/bunium_shim.cpp` +
   `bunium_common.h`, replacing `src/app.ts`'s old fixed 8ms `setInterval`
   with a self-rescheduling `setTimeout` sized by what CEF actually
   requests). **Real, standing win: IPC round-trip latency dropped from
   the original 11.9ms baseline to ~1.3-3.2ms (~4-9x)** — still behind
   Electron's 0.2-0.5ms but no longer an order of magnitude off.
2. **Disabled Chromium's spare-renderer-process feature**
   (`--disable-features=SpareRendererForSitePerProcess`) — a bunium
   window's one navigation is known at creation time, no "next tab" to
   pre-warm a spare renderer for.
3. **Merged Chromium's GPU service into the browser process**
   (`--in-process-gpu`) — GPU compositing was already disabled (CPU-
   readback OSR path), so the isolated GPU process was pure overhead with
   no remaining security benefit. Deliberately **not** `--single-process`:
   that also merges the *renderer*, Chromium's real security boundary
   against untrusted content `<bunium-webview>` can load — tested working
   (drops to 1 process) but rejected as unsafe for a general-purpose
   framework regardless of the benchmark win.

(2) and (3) together dropped process count 6→4 (Electron is 5 — **beaten,
not tied**), and RSS followed: both minimal and mini-app RSS now beat
Electron, the second one only flipping after the GPU-process merge (a
whole extra OS process is real memory).

## What was tried on idle CPU, including a real mistake worth recording

Idle CPU is the one metric where a genuine measurement error happened mid-
session, corrected before shipping anything wrong long-term:

- Isolated the two native pump calls in a standalone FFI harness: neither
  costs anything alone at any interval; running both together costs
  25-59% of one core with no clean relationship to poll interval. Ruled
  out the adaptive-pump design as the fix for this metric (it fixed IPC
  latency, not CPU).
- Tried `windowless_frame_rate = 1` (down from 60): no measurable change
  (~48% vs ~55%) — ruled out OSR frame-rate as the direct driver.
- **Found and shipped, then reverted, `--no-proxy-server`.** An initial
  measurement (sampling CPU at t=2-5s after launch) showed a real-looking
  55%→33% drop and it was shipped. Extending the measurement window
  (t=1..30s, 1s resolution) revealed the true pattern: idle CPU is near-
  zero for the first ~3-4s after launch, then jumps to a sustained
  ~55-59% that never comes back down. The original "win" was an artifact
  of sampling entirely within that pre-onset window — re-measured against
  the actual steady state (t=10-30s, matching what `report.ts` samples)
  and `--no-proxy-server` made no real difference. **Reverted** — no
  longer worth its real downside (bypasses system/corporate-proxy
  configuration for every bunium app's network requests) once the
  benefit turned out not to exist.
- `sample`(1)-profiled the steady-state window: dominant cost sits inside
  Chromium Embedded Framework itself, spread across many
  `ThreadPoolForegroundWorker` threads (not one dedicated thread),
  consistent with Chromium's `BEST_EFFORT`-priority background task
  scheduling — which by design defers non-critical work for a few seconds
  after startup so it doesn't compete with initial page load, matching
  the observed ~3-4s onset exactly. Tried disabling various plausible
  candidate features (Safe Browsing auto-update/phishing detection, crash
  reporter/breakpad, stack sampling profiler, desktop-PWA/shortcut
  OS-integration features): none moved the steady-state number.
- **Real next step, not attempted:** identifying the exact deferred
  BEST_EFFORT task(s) needs either a symbolized/debug CEF build (the
  vendored distro is a stripped minimal release build — `sample`'s output
  resolves to the nearest exported symbol, not the true call site) or
  Chromium source-level investigation. Beyond this session's scope.

## What was tried on startup time

No bunium-specific inefficiency found: every window-creation FFI call
(`bunium_create_native_window`/`bunium_create_view`/`bunium_attach_window`)
is a single synchronous native call with no extra round trips. Profiled
the 0-1s startup window specifically (separately from the steady-state
idle-CPU profiling above) and confirmed the two are unrelated — startup-
window CPU work is dominated by waiting/blocked threads, not the same
BEST_EFFORT task pattern seen later. The ~300ms cost is attributed to
`CefInitialize()` itself: loading and initializing the CEF framework and
spawning its (now smaller, 4-process) subprocess tree, versus Electron's
single precompiled executable. No lever found; not attempted further this
pass.

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

- One machine, repeated rounds of 3-5 reps — enough to trust
  order-of-magnitude signals and the RSS/process-count flips (structural,
  not timing-noise-prone) but startup-time numbers are still only accurate
  to ~10-20%. The idle-CPU episode above is a concrete demonstration of
  why short sampling windows on this specific metric are untrustworthy —
  always sample well past any possible delayed-onset behavior (30s+, not
  2-5s) before trusting a CPU number on this codebase.
- macOS arm64 only. Linux/Windows numbers aren't collected here — the
  shipped native changes live in `native/mac/bunium_shim.cpp` /
  `bunium_common.h`, which compile unchanged into the Linux/Windows builds
  too (per `native/linux/build.sh`/`native/win/build.sh`), so those
  platforms should inherit the process-count/RSS/IPC-latency wins once
  rebuilt there, but this was **not verified** on Linux/Windows.
- The mini-app's Electron `bridge.js` runs with `nodeIntegration: true,
  contextIsolation: false` for a same-shape IPC comparison against bunium's
  single-hop `window.__bunium` channel — a production Electron app should
  use `contextBridge` + a preload script instead, which adds its own (small)
  overhead this benchmark doesn't capture.
- Bundle-size comparison is the raw framework/runtime payload, not a fully
  packaged+signed installer for both sides (Electron packaging wasn't run
  here); treat it as "what ships with the app" rather than "final download
  size."
