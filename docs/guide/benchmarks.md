# bunium vs Electron benchmarks

Measured on one machine (Apple M2 Pro, macOS, arm64), bun 1.4.0 vs Electron
44.0.0, 5 repetitions per scenario (median reported). Full methodology, raw
per-rep data, and the harness itself live in
[`benchmark/`](https://github.com/erfanmola/bunium/tree/main/benchmark)
(see `benchmark/RESULTS.md` for the unabridged version of this page,
including a full round of targeted perf work aimed at closing every gap
— and a real measurement mistake that was caught and corrected before it
shipped wrong).

Two comparable app pairs, same UI on both sides:

- **minimal** — one window, one static page.
- **mini-app** — a small dashboard (sidebar, 200-row table, one IPC-driven
  counter); `benchmark/shared/{index.html,app.js}` is the literal same file
  loaded by both hosts.

## Results

`--in-process-gpu` (merging Chromium's GPU service into the browser
process) was shipped, verified, then reverted at the user's explicit
request — GPU stays in its own isolated OS process. That change was
responsible for beating (not tying) process count and for the mini-app
RSS win; both regress with the revert. Current, accurate numbers:

| metric | bunium | Electron | winner |
|---|---|---|---|
| framework/runtime on-disk size | 260M | 306M | **bunium** |
| process boot (bare `-e "exit(0)"`) | 6.3ms (bun) | 36.6ms (node) | **bunium** |
| idle RSS, minimal app (MB) | **403.2** | 418.5 | **bunium** |
| process count (main + helpers) | 5 | 5 | tied |
| idle RSS, mini-app (MB) | 467.2 | 450.9 | Electron |
| process start → first paint (ms) | 302-329 | 160-194 | Electron |
| idle CPU, full process tree (%) | 58-60 | **0** | Electron |
| IPC round trip, avg of 50 (ms) | 2.6 | 0.5 | Electron |
| mini-app DOM render, 200 rows (ms) | 0.9 | 1.0 | ~tied |

**3 of 8 metrics beaten outright:** disk size, process boot, minimal-app
RSS. **1 tied:** process count. **4 remain behind:** mini-app RSS, startup
time, idle CPU, IPC latency.

## What actually closed the gap

Two native changes stand: an adaptive CEF message pump
(`external_message_pump` + `OnScheduleMessagePumpWork` replacing a fixed
8ms `setInterval`) cut IPC latency ~4-9x; and disabling Chromium's
spare-renderer-process feature (bunium already knows its one navigation
at window-creation time — no "next tab" to pre-warm for), which accounts
for the process-count tie (was 6, now 5) and the minimal-app RSS win.

A third, merging Chromium's GPU service into the browser process
(`--in-process-gpu` — GPU compositing was already off for the CPU-readback
OSR path, so the isolated GPU process was pure overhead), verified clean
and genuinely dropped process count to 4 (below Electron's 5) with RSS
following on both app shapes — but was reverted per the user's explicit
instruction, independent of any correctness concern. `benchmark/RESULTS.md`
keeps the full writeup since the investigation and safety reasoning are
still real.

Deliberately never shipped: `--single-process` (tested working, drops to
a single OS process, but also merges the *renderer* — Chromium's actual
security boundary against untrusted content `<bunium-webview>` can load.
Rejected as unsafe for a general-purpose framework regardless of the
benchmark win.)

## Idle CPU: a real measurement mistake, caught and reverted

Worth telling honestly rather than glossing over. An initial fix
(`--no-proxy-server`, disabling Chromium's macOS system-proxy-config
watcher) looked like a real 55%→33% win when measured 2-5 seconds after
launch, and shipped. Extending the measurement window (1-30 seconds, 1s
resolution) revealed the actual pattern: idle CPU is near-zero for the
first ~3-4 seconds, then jumps to a sustained ~55-59% that never comes
back down. The "win" was sampling entirely within that pre-onset window —
re-measured against the real steady state and the proxy fix made no
difference. It was **reverted**, since it no longer had a benefit to
justify its real downside (bypassing proxy/VPN-aware networking for every
bunium app).

The actual cost profiles to something inside Chromium Embedded Framework
itself, spread across many background thread-pool workers rather than one
dedicated thread — consistent with Chromium's own `BEST_EFFORT`-priority
task scheduling, which deliberately defers non-critical background work
for a few seconds after startup so it doesn't compete with the initial
page load (matching the observed onset almost exactly). Several plausible
feature-disabling switches were tested (Safe Browsing, crash reporting,
sampling profiler, desktop-PWA OS integration) with no effect. Pinning
down the exact task needs a symbolized/debug CEF build or Chromium
source-level work — out of reach this pass.

## Startup time: investigated, no lever found

No bunium-specific inefficiency in the window-creation path (each FFI call
is a single synchronous native call, no extra round trips). Profiling the
0-1s startup window confirmed it's unrelated to the idle-CPU issue above —
different cost, different cause. The ~300ms is attributed to
`CefInitialize()` itself loading the CEF framework and spawning its
subprocess tree, versus Electron's single precompiled executable.

## Caveats

Repeated rounds of 3-5 reps on one machine — enough to trust
order-of-magnitude signals and the RSS/process-count flips (structural,
not timing-noise-prone), but startup time is only accurate to ~10-20%. The
idle-CPU episode above is a concrete demonstration of why short sampling
windows on this metric are untrustworthy specifically — always sample past
any possible delayed-onset behavior. macOS arm64 only; the shipped native
changes live in shared code compiled into the Linux/Windows builds too, so
those platforms should inherit the RSS/IPC-latency improvements once
rebuilt there, but this wasn't verified on those platforms. The Electron
mini-app uses `nodeIntegration: true, contextIsolation: false` for an
IPC-shape comparable to bunium's single-hop channel — a production
Electron app would add a `contextBridge` preload hop with its own small
overhead this doesn't capture. Bundle size compares the raw
framework/runtime payload, not a fully packaged+signed installer for
either side.
