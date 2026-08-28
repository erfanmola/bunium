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

## Current results (2026-08-28, after reverting `--in-process-gpu`)

`--in-process-gpu` (merging Chromium's GPU service into the browser
process) was shipped, then reverted per the user's explicit request —
GPU stays in its own isolated OS process again. That was the change
responsible for beating (not tying) process count and for mini-app RSS
also beating Electron; both regress back with the revert. This table is
the current, accurate state:

| metric | bunium-minimal | electron-minimal | bunium-mini-app | electron-mini-app | winner |
|---|---|---|---|---|---|
| framework/runtime on-disk size | 260M | 306M | — | — | **bunium** |
| process boot (bare `-e "exit(0)"`) | 6.3ms (bun) | 36.6ms (node) | — | — | **bunium** |
| idle RSS, minimal app (MB) | **403.2** | 418.5 | — | — | **bunium** |
| process count (main + helpers) | 5 | 5 | 5 | 5 | tied |
| idle RSS, mini-app (MB) | 467.2 | 450.9 | — | — | Electron |
| process start → first paint (ms) | 302 | **160** | 329 | **194** | Electron |
| idle CPU, full process tree (%) | 50-51 | **0** | 50-51 | **0** | Electron |
| IPC round trip, avg of 50 (ms) | — | — | 2.6 | **0.5** | Electron |
| mini-app DOM render, 200 rows (ms) | — | — | 0.9 | 1.0 | ~tied |

**3 of 8 metrics beaten outright:** disk size, process boot, minimal-app
RSS. **1 tied:** process count (was beaten outright with
`--in-process-gpu`, see below — reverted). **4 remain behind:** mini-app
RSS, startup time, idle CPU, IPC latency.

`--in-process-gpu` is documented below (what it did, why it was safe, why
it was tried) since the investigation and the tradeoff reasoning are still
real and worth keeping on record even though the change itself isn't
shipped.

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
3. **Merged Chromium's GPU service into the browser process
   (`--in-process-gpu`) — shipped, then reverted per user request.** GPU
   compositing was already disabled (CPU-readback OSR path), so the
   isolated GPU process was pure overhead with no remaining security
   benefit — the merge itself verified clean (37/37 examples, 6/6
   scaffolds) and dropped process count 6→4 (genuinely below Electron's 5,
   not tied), with RSS following on both app shapes. Deliberately **not**
   `--single-process`: that also merges the *renderer*, Chromium's real
   security boundary against untrusted content `<bunium-webview>` can
   load — tested working (drops to 1 process) but rejected as unsafe for a
   general-purpose framework regardless of the benchmark win. Reverted
   afterward on the user's explicit instruction, independent of the
   `--single-process` safety call — process count is back to 5 (tied with
   Electron) and mini-app RSS is back behind.

(2) alone (spare-renderer disable) accounts for the standing process-count
tie (6→5) and the minimal-app RSS win that survives the revert.

## What was tried on idle CPU, including a real mistake worth recording

### Round A: black-box guessing (no real symbols) — mostly dead ends, one real fix

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
- `sample`(1) without real debug symbols resolves everything inside the
  vendored (stripped, release-build) CEF framework to the *nearest
  exported symbol*, which for ~99% of the binary's code is tens of
  megabytes away from the true call site — confirmed via `nm`, the next
  exported symbol after the one `sample` kept reporting was **27MB**
  later in the binary. Every conclusion drawn from this round was
  necessarily circumstantial. Tried disabling ~15 plausible candidate
  features this way (Safe Browsing, crash reporter/breakpad, stack
  sampling profiler via `--disable-features=StackSamplingProfiler`,
  desktop-PWA/shortcut OS-integration, component update, sync/translate,
  variations/field-trial config, `--incognito`, `--single-process`'s
  safer sibling `--in-process-gpu`): only `--in-process-gpu` (process
  count, see above) turned out to be real when re-checked with actual
  symbols. This whole round should have been done with real symbols from
  the start — see Round B.

### Round B: real symbols — one confirmed, named, shipped fix

CEF publishes a `release_symbols` package (dSYM bundle) per version,
matched by build UUID to the vendored framework — this makes `sample`/
`lldb` resolve real function names instead of guessing. Reusable
procedure:

```bash
# CEF's CDN throttles single-connection downloads hard (~300-500KB/s,
# a ~2GB package = hours) -- 16 parallel connections via aria2 gets
# ~40MB/s instead:
brew install aria2
V="151.3.16+gbe1e15d+chromium-151.0.7922.109"  # match .github/workflows/mac-smoke.yml's CEF_VERSION
aria2c -x16 -s16 --file-allocation=none \
  -o cef-symbols.tar.bz2 \
  "https://cef-builds.spotifycdn.com/cef_binary_${V}_macosarm64_release_symbols.tar.bz2"
tar xjf cef-symbols.tar.bz2

# Verify the dSYM actually matches the vendored binary before trusting it:
dwarfdump --uuid "vendor/cef-macosarm64/Release/Chromium Embedded Framework.framework/Chromium Embedded Framework"
dwarfdump --uuid "cef_binary_*_release_symbols/Chromium Embedded Framework.dSYM"
# UUIDs must match exactly.

# sample/lldb auto-discover a co-located <binary-name>.dSYM sibling:
cp -R "cef_binary_*_release_symbols/Chromium Embedded Framework.dSYM" \
  "vendor/cef-macosarm64/Release/"
# (~6.9GB on disk -- delete after use, it's not needed once you have your
# findings, and it's git-ignored regardless since it lives under vendor/)
```

With the dSYM in place, `sample <pid> <seconds> -file out.txt` on a live
bunium process resolves real C++ symbols. Grand total across a proper
15-second post-idle sample, parsed by summing all `(in Chromium Embedded
Framework)`-attributed lines: no single function dominates (max ~7.6%) —
the cost is genuinely spread across Chromium's own task-scheduling
machinery (`WorkerThread::RunWorker`, `ThreadControllerWithMessagePumpImpl
::DoWork`, `SequenceManagerImpl::SelectNextTask`, `RunLoop::Run`, etc.),
**except one outlier**: a `ThreadPoolForegroundWorker` thread whose entire
sampled window (11263 of ~12800 samples in one run) was inside
`base::mac::ProcessRequirement::{ValidateProcess,GatherMetrics}` — real
macOS code-signature validation (`SecStaticCodeCheckValidityWithErrors`
et al., matching an earlier Round-A `Security.framework` observation that
had no way to be confirmed at the time). This is Chromium's Mach port
rendezvous peer-validation feature
(`MachPortRendezvousValidatePeerRequirements`/
`MachPortRendezvousEnforcePeerRequirements`,
`FEATURE_DISABLED_BY_DEFAULT` upstream but active in this CEF build's
baked-in field-trial config) — confirmed by re-sampling with the features
disabled: the symbol disappeared from the profile entirely. **Shipped.**
Measured effect: idle CPU 58-60% → 50-51% (repeatable across 6+ runs).

### Round C: Perfetto tracing — precise task-level breakdown, real remaining root cause identified but not yet fixable via any flag

Stack sampling shows *where* CPU goes but not *what task* or *who posted
it*. Chromium's own tracing infrastructure answers that directly and is
already compiled into CEF (`PerfettoTrace` was visible as a thread name in
every `sample` capture this session). Reusable procedure:

```bash
# Capture a trace via the CEF switches passthrough:
BUNIUM_CEF_SWITCHES="--trace-startup=*,disabled-by-default-toplevel,disabled-by-default-sequence_manager \
  --trace-startup-duration=10 --trace-startup-file=/tmp/trace.json" \
  bun run <your-app>

# Output is a binary Perfetto proto (despite the .json name), not legacy
# Chrome JSON trace format. Google's own trace_processor_shell download
# (commondatastorage.googleapis.com) 403'd repeatedly in this environment
# -- GitHub releases worked fine:
curl -sL "https://api.github.com/repos/google/perfetto/releases/latest" \
  | grep -o '"browser_download_url": *"[^"]*mac-arm64.zip"' | cut -d'"' -f4 \
  | xargs curl -fL -o perfetto.zip
unzip perfetto.zip -d perfetto-tools
xattr -d com.apple.quarantine perfetto-tools/mac-arm64/trace_processor_shell

perfetto-tools/mac-arm64/trace_processor_shell -q <(echo "
  SELECT name, count(*) as cnt FROM slice GROUP BY name ORDER BY cnt DESC LIMIT 40;
") /tmp/trace.json
```

A 10-second idle trace on `bunium-minimal` gave exact counts:

| what | count (10s) | rate |
|---|---|---|
| `SequenceManagerImpl::SelectNextTask` | 41427 | ~4143/sec |
| `SequenceManagerImpl::MoveReadyDelayedTasksToWorkQueues` | 41427 | ~4143/sec |
| `ThreadControllerImpl::DoWork` | 40042 | ~4004/sec |
| `ThreadControllerImpl::RunTask` (tasks that actually ran) | 4392 | ~439/sec |

89% of the `SelectNextTask` calls are on `CrBrowserMain` (the browser
process's own main thread — the one `src/app.ts`'s pump loop drives).
**Isolated one variable at a time:**
- Reverting `settings.external_message_pump` to `false` (this session's
  Phase-1 pump-loop change, reverted temporarily as a test) dropped
  `SelectNextTask` 6.2x (41427→6685) while `RunTask` stayed *exactly* the
  same (4396 vs 4392) — meaning `external_message_pump=true` causes ~6x
  more empty scheduler polling with zero extra useful work done.
- But re-measured actual CPU% with `external_message_pump=false`: **no
  change** (50-51% either way, 3 reps each). The empty `SelectNextTask`
  polling is real and 6x reduced, but it's cheap enough that it isn't
  where the CPU actually goes — confirms the adaptive pump (kept, for its
  real IPC-latency win) isn't the CPU driver either way.
- The real driver tracks `RunTask` (~439/sec of *actual* task execution,
  identical regardless of pump mode). Queried each `RunTask`'s
  `task.posted_from.file_name`/`function_name` args directly:

| source | share of RunTask calls |
|---|---|
| `base/profiler/stack_sampling_profiler.cc` + `stack_sampler.cc` (functions `RecordSampleTask`/`RecordStackFrames`) | ~28% |
| `mojo/public/cpp/system/simple_watcher.cc` (`Notify`) | ~17% |
| `mojo/public/cpp/bindings/lib/connector.cc` + `ipc/ipc_mojo_bootstrap.cc` (mojo message dispatch) | ~12% |
| `KeyedServiceFactory::GetServiceForContext` (Chrome profile-keyed services) | tracked separately, 1630 calls/10s |
| `Database::*` (real SQLite activity — `ReleaseCacheMemoryIfNeeded`, `Statement`, `Execute*`) | tracked separately, ~2100 calls/10s combined |
| `base/tracing/perfetto_task_runner.cc` | excluded — self-inflicted by the trace capture itself, not present in normal operation |

**Chromium's own internal `StackSamplingProfiler` (the profiler CEF/Chrome
uses for its own performance-UMA telemetry) is the single largest named
contributor at ~28% of real task executions** — genuinely running,
confirmed by exact source file, not inferred. Tried disabling it four
different ways with the *correct* long-window methodology this time
(`--disable-features=StackSamplingProfiler,SamplingHeapProfiler`,
combined with `--force-fieldtrials= --metrics-recording-only
--disable-metrics`, combined with breakpad/crash-reporter/HangWatcher
disables): **no measured effect on CPU% in any combination.** This
strongly suggests it's not gated by a command-line feature flag in this
build — `chrome/common/stack_sampling_configuration.*` (the file that
decides whether the profiler runs, gated historically on metrics-client-ID
availability and release channel) is the next real lead, but both
`chromium.googlesource.com` and `source.chromium.org` returned 404/403 for
this specific file during this session (works for some files, not others —
inconsistent, possibly path has moved in newer Chromium). The Mojo/IPC
dispatch machinery (~29% combined) is plausibly unavoidable multi-process
overhead rather than a bug.

**Concrete next steps for continuing this** (real, scoped, not hand-wavy):
1. Find the current path/logic for what gates `StackSamplingProfiler` —
   either a full (not shallow — sparse checkouts of one file don't work
   well against Chromium's monorepo tooling) local Chromium checkout, or
   patch CEF from source with the profiler's enable-check forced off and
   rebuild (verify against the same UUID-matched dSYM + Perfetto trace
   methodology above to confirm before/after).
2. Re-run the exact Perfetto query above after any change — it's the most
   precise instrument found this session, far better than stack sampling
   for "which named task, how often."
3. If StackSamplingProfiler + Mojo/IPC dispatch really are the ceiling,
   remaining idle CPU may be a hard floor of "any multi-process Chrome-
   bootstrap-based CEF app" rather than something bunium's own code
   controls — but that conclusion should come from ruling out the
   profiler with certainty first, not assumed.

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
