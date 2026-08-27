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

## Median of 3 reps

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

## The one finding that actually matters

Idle CPU and IPC latency are the two numbers where bunium and Electron
diverge by an order of magnitude or more, and both trace to the **same root
cause**: `src/app.ts`'s message pump (`startPumpLoop`) drives CEF's message
loop off a fixed 8ms `setInterval`, unconditionally, whether or not there's
any actual work to do:

```ts
private startPumpLoop(intervalMs = 8): void {
  this.pumpTimer = setInterval(() => {
    lib.symbols.bunium_do_message_loop_work();
    lib.symbols.bunium_pump_native_events();
    this.pollWindows();
    systemEvents.drain();
  }, intervalMs);
}
```

Electron integrates Chromium's own message loop into the OS's native run
loop (CFRunLoop on macOS) — it blocks until there's real work, so idle CPU
is ~0% and an IPC message gets processed on the next natural wake, not on
the next poll tick. bunium's fixed-interval poll means: (a) the process is
never truly idle (CPU work every 8ms forever, hence ~56% of one core), and
(b) IPC replies wait an average of ~half the interval before being noticed,
which is the direct explanation for the 11.9ms vs 0.2ms round-trip gap.

This is an architectural characteristic, not a bug, and not something this
benchmarking pass fixes — but it's the single most actionable lead for a
future optimization phase (an adaptive interval, or wiring the pump to a
real CFRunLoop/epoll/IOCP wakeup source instead of blind polling, would
likely close most of this gap). Logged as a PLAN.md follow-up.

## Caveats

- One machine, one run of 3 reps — enough to see a real signal on the CPU/
  IPC gap (order-of-magnitude, reproducible every rep) but not enough to
  trust the startup-time/RSS numbers to more than ~10-20% precision.
- macOS arm64 only. Linux/Windows numbers aren't collected here.
- The mini-app's Electron `bridge.js` runs with `nodeIntegration: true,
  contextIsolation: false` for a same-shape IPC comparison against bunium's
  single-hop `window.__bunium` channel — a production Electron app should
  use `contextBridge` + a preload script instead, which adds its own (small)
  overhead this benchmark doesn't capture.
- Bundle-size comparison is the raw framework/runtime payload, not a fully
  packaged+signed installer for both sides (Electron packaging wasn't run
  here); treat it as "what ships with the app" rather than "final download
  size."
