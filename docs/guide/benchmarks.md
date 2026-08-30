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
| idle RSS, minimal app (MB) | 432.7 | **374.1** | Electron |
| process count (main + helpers) | 5 | 4 | Electron |
| idle RSS, mini-app (MB) | 501.0 | **408.0** | Electron |
| process start → first paint (ms) | 305-335 | 159-196 | Electron |
| idle CPU, full process tree (%) | **3.5-4.0** | **0-0.5** | Electron (near-closed) |
| IPC round trip, avg of 50 (ms) | 4.5 | 0.5 | Electron |
| mini-app DOM render, 200 rows (ms) | 1.0 | 1.0 | tied |

**2 of 8 metrics beaten outright** (disk size, process boot) as of the
latest regenerate (2026-08-31) — see `benchmark/RESULTS.md` for the full
note on why RSS/process-count/IPC-latency moved unfavorably vs an
earlier session's numbers (not root-caused, possibly just machine load at
measurement time). **Idle CPU went from a hard 50-59% down to ~3-4%** (see
below) — technically still shy of Electron's 0% but no longer the
dominant gap.

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

## Idle CPU: root cause found and fixed (56-59% → ~3%)

Full methodology (reusable — dSYM download/UUID-matching, Perfetto trace
capture/query) is in `benchmark/RESULTS.md`. Short version:

An initial black-box fix (`--no-proxy-server`) looked like a real 55%→33%
win when measured 2-5 seconds after launch, shipped, then caught and
**reverted**: extending the measurement window to 30s revealed idle CPU
is near-zero for ~3-4s then jumps to a sustained plateau — the "win" was
sampling entirely inside that pre-onset window. Real steady-state showed
no difference. Every conclusion from stripped-binary stack sampling in
this codebase should be treated as circumstantial for the same reason —
`sample`'s nearest-exported-symbol fallback was landing **27MB** away from
the true call site.

Downloaded CEF's actual debug symbols (a `release_symbols` package, UUID-
matched to the vendored framework) and re-profiled with real function
names. Found and shipped a genuine, named fix: a `ThreadPoolForegroundWorker`
thread's entire sampled window was inside
`base::mac::ProcessRequirement::{ValidateProcess,GatherMetrics}` — real
macOS code-signature validation, part of Chromium's Mach port rendezvous
peer-validation feature (disabled by default upstream, active in this
CEF build's baked-in config). Disabling it dropped idle CPU 58-60%→50-51%,
repeatable across 6+ runs.

Captured a Perfetto trace (Chromium's own tracing infra, already compiled
into CEF) for a task-level breakdown beyond what stack sampling can show.
The single largest remaining named contributor: Chromium's own internal
`StackSamplingProfiler` (its performance-telemetry system) at ~28% of real
task executions — confirmed by exact source file
(`base/profiler/stack_sampling_profiler.cc`), not inferred. Four different
disabling attempts (feature flags, metrics/field-trial disables, combined
with breakpad/crash-reporter/HangWatcher) had zero measured effect,
meaning it isn't gated by any command-line switch in this build.

A follow-up session tested the profiler hypothesis directly instead of
guessing further: the real Chromium switch that disables it,
`--disable-stack-profiler`, produced **zero measured effect** — high task-
*count* share doesn't mean high CPU-*time* share; each sample was cheap.
Same null result for `--disable-background-networking`. A fresh
symbol-level `sample` capture found the real remaining driver: the exact
same `ProcessRequirement::{ValidateProcess,GatherMetrics}` symbol from the
fix above, but reached through a *separate* code path
(`MaybeGatherMetrics()`) gated by a *third*, independent feature the
earlier fix never touched — `GatherProcessRequirementMetrics`, pure UMA
telemetry with no functional purpose for a non-metrics-reporting embedder.
Disabling it dropped idle CPU **59.4% → 3.0%**, shipped alongside the
earlier two `disable-features` entries in `bunium_common.h`.

## Startup time: investigated, no lever found

No bunium-specific inefficiency in the window-creation path (each FFI call
is a single synchronous native call, no extra round trips). Profiling the
0-1s startup window confirmed it's unrelated to the idle-CPU issue above —
different cost, different cause. The ~300ms is attributed to
`CefInitialize()` itself loading the CEF framework and spawning its
subprocess tree, versus Electron's single precompiled executable.

## Running these benchmarks on Linux / Windows

The harness (`benchmark/scripts/{bench.ts,report.ts}`) is now
cross-platform in code — `process.platform` branches handle the two
things that were mac/Linux-only (`ps` doesn't exist on Windows; the
hardcoded `./node_modules/.bin/electron` shim path doesn't work there
without `shell: true`). **The Windows branch is unverified — no Windows
machine was available to test it when it was written (2026-08-31), same
posture as `packaging/win/cef-trim.sh` and the win32-x64 release CI job.**
Linux needs no code changes (GNU `ps` accepts the same `-o pid=,rss=,time=`
format used here) and should just work.

Steps on either platform:

1. Build the native stack for that platform first (Linux:
   `docker/linux/fetch-cef.sh` + `native/linux/build.sh`, or the bare-host
   equivalent in `docker/linux/run-examples.sh`'s companion docs; Windows:
   `native/win/build.sh`) — see the platform's own Phase 6/7 section in
   `PLAN.md` for the full sequence.
2. `bun link` at the repo root, then `bun link bunium` inside
   `benchmark/bunium-minimal/` and `benchmark/bunium-mini-app/` (the
   framework isn't published to npm).
3. `npm install` inside `benchmark/electron-minimal/` and
   `benchmark/electron-mini-app/` — Electron ships real prebuilt binaries
   for both platforms, no extra config needed.
4. `BENCH_REPS=5 BENCH_IDLE_SECONDS=6 bun run benchmark/scripts/report.ts`
   from the repo root, same as macOS.

**First real thing to check on Windows specifically:** whether
`winSampleTree()`/`WIN_DESCENDANTS_CMD` in `bench.ts` (PowerShell
`Get-CimInstance Win32_Process` for the process tree, `Get-Process`'s
`WorkingSet64`/`CPU` properties for RSS/CPU-seconds) produce sane numbers
at all — spot-check one manual run against Task Manager before trusting
a full report. If PowerShell's per-invocation startup cost turns out to
skew the idle-CPU sampling window (each `sampleTree()` call spawns a new
`powershell.exe` process), that's a real thing to watch for and wasn't a
concern on mac/Linux where `ps` is nearly instant.

Once real numbers exist for a platform, fold them into this page and
`benchmark/RESULTS.md` as their own columns (mirroring the existing
bunium-vs-Electron layout) rather than replacing the macOS numbers —
the three platforms aren't expected to match exactly (different Electron
build, different OS scheduler behavior), so keep them side by side.

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
