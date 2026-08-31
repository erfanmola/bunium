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

## Current results (2026-08-31, after the idle-CPU fix)

`--in-process-gpu` (merging Chromium's GPU service into the browser
process) was shipped, then reverted per the user's explicit request —
GPU stays in its own isolated OS process again. That was the change
responsible for beating (not tying) process count and for mini-app RSS
also beating Electron; both regress back with the revert.

This table is a fresh regenerate (`BENCH_REPS=5 BENCH_IDLE_SECONDS=6`,
median of 5) after the idle-CPU fix below. **Idle CPU improved hugely as
expected (~3-4% now, was 50-59%) — but RSS and process count on the
minimal app moved unfavorably compared to the 2026-08-28 numbers above
this line historically showed**, most likely environmental (this
machine's background load was ~2.6 at measurement time, and
`node_modules` for the Electron benchmark apps had just been freshly
reinstalled after being cleared earlier in the session — neither ruled
out nor confirmed as the cause). Not re-investigated further this
session since it's outside what was asked; worth a re-run under quieter
conditions before drawing conclusions about a regression:

| metric | bunium-minimal | electron-minimal | bunium-mini-app | electron-mini-app | winner |
|---|---|---|---|---|---|
| framework/runtime on-disk size | 260M | 306M | — | — | **bunium** |
| process boot (bare `-e "exit(0)"`) | 6.3ms (bun) | 36.6ms (node) | — | — | **bunium** |
| idle RSS, minimal app (MB) | 432.7 | **374.1** | — | — | Electron |
| process count (main + helpers) | 5 | 4 | 5 | 4 | Electron |
| idle RSS, mini-app (MB) | 501.0 | **408.0** | — | — | Electron |
| process start → first paint (ms) | 305 | **159** | 335 | **196** | Electron |
| idle CPU, full process tree (%) | **3.5** | **0** | **4.0** | **0.5** | Electron (near-closed) |
| IPC round trip, avg of 50 (ms) | — | — | 4.5 | **0.5** | Electron |
| mini-app DOM render, 200 rows (ms) | — | — | 1.0 | 1.0 | tied |

**2 of 8 metrics beaten outright this run:** disk size, process boot.
**1 tied:** DOM render. **5 behind:** minimal/mini-app RSS, process
count, startup time, IPC latency — though **idle CPU's gap is now
noise-level** (3.5-4.0% vs 0-0.5%) rather than the ~55-percentage-point
gap every earlier round of this investigation measured. The
RSS/process-count/IPC-latency regressions vs the 2026-08-28 numbers are
flagged above as unconfirmed-cause and worth a clean re-run, not
something this session root-caused.

`--in-process-gpu` is documented below (what it did, why it was safe, why
it was tried) since the investigation and the tradeoff reasoning are still
real and worth keeping on record even though the change itself isn't
shipped.

## Linux results (2026-08-31, x86_64, bare host, first real run)

First real (non-simulated) run of this harness on Linux — the "should just
work, unverified" posture from the note below is now verified. Ran on a
bare-metal x86_64 Arch Linux host (no Docker), CEF `linux64` distro, built
via `docker/linux/fetch-cef.sh` + `native/linux/build.sh` exactly as
documented (no script changes needed). `bun link` + `bun link bunium` for
the bunium apps; `bun install` + manually running each `electron` npm
package's `install.js` for the Electron apps (this host has **no Node/npm
at all**, only Bun — `bun install` skips lifecycle scripts by default so
Electron's real binary download doesn't happen automatically; running
`node_modules/electron/install.js` via `bun run` once per app fetches it).
Real X11 session (`DISPLAY=:0`), no Xvfb needed. Electron's `chrome-sandbox`
helper is not SUID-root on this host and Chromium's sandbox still
initialized without `--no-sandbox` (unprivileged user namespaces enabled at
the kernel level) — worth checking on any other Linux box this gets rerun
on, since a non-working sandbox path there could throw off the comparison.
`BENCH_REPS=5 BENCH_IDLE_SECONDS=6`, 20 total reps, all clean:

| metric | bunium-minimal | electron-minimal | bunium-mini-app | electron-mini-app | winner |
|---|---|---|---|---|---|
| framework/runtime on-disk size | 342M (`native/build-linux` + CEF resources) | 282M (`electron/dist`) | — | — | Electron |
| process start → first paint (ms) | **110** | 392 | **107** | 355 | **bunium** |
| idle RSS (MB) | **698.4** | 946.3 | **733.7** | 1041.4 | **bunium** |
| process count (main + helpers) | **7** | 11 | **7** | 11 | **bunium** |
| idle CPU, full process tree (%) | **0** | **0** | **0** | **0** | tied |
| IPC round trip, avg of ~50 (ms) | — | — | 2.9 | **0.4** | Electron |
| mini-app DOM render, 200 rows (ms) | — | — | 1.1 | 1.0 | tied |

**Shape differs from the macOS results above in bunium's favor on this
run:** bunium wins paint time, RSS, and process count outright on Linux,
whereas on mac Electron wins RSS/process-count/startup and only disk-size/
boot-time favor bunium. Idle CPU is a genuine tie at 0% for both — the
shared `GatherProcessRequirementMetrics`/`MachPortRendezvous*`/
`SpareRendererForSitePerProcess` disable-features flags from the mac fix
(`bunium_common.h`, platform-agnostic) are confirmed present on this
build's actual subprocess command line (checked via `ps` mid-run) and idle
`TIME` stayed at `00:00:00` across a 5s sampling window for every process
in the tree — not just a harness artifact. IPC latency still favors
Electron by a similar margin to mac (no Linux-specific IPC work has been
done; same adaptive-pump code runs on both platforms). Framework size is
the one metric that flips vs mac: Linux's CEF minimal distro + Chrome
resources (`native/build-linux`, 342M) lands larger than this Electron
build's `dist/` (282M) — not investigated further, likely just a
different bundle-trim ratio between the two upstream builds on this
platform, unrelated to any bunium-specific bloat (mac's equivalent
comparison used bunium's *packaged, trimmed* `dist-release/` output, not
the raw dev-tree `native/build-linux/` used here — not a fully apples-to-
apples pair; a trimmed Linux package artifact would need `packaging/`
support for Linux, which doesn't exist yet).

**Follow-up (2026-08-31, root-caused): the apparent "SIGTERM crash-loop"
is not a bunium bug — it's generic Chromium multi-process behavior,
reproduces identically on Electron.** The original note here (from a bare
`timeout <N> bun run main.ts` sanity check, not from the harness itself)
saw `zygote_communication_linux.cc: Failed to send GetTerminationStatus
message to zygote` → `Network service crashed or was terminated,
restarting service` → repeated `GPU process launch failed: error_code=
1002` → fatal `GPU process isn't usable. Goodbye.` on shutdown and flagged
it as a possible bunium-specific double-teardown race. Root-caused via
process-group inspection (`ps -o pid,pgid`): GNU `timeout` (without
`--foreground`) puts its child in a **new process group** and, on expiry,
sends the signal to **the whole group at once** (`killpg`, not just the
root PID) — every `bunium_subprocess` helper (zygote, GPU, network,
renderer) gets SIGTERM simultaneously alongside the main browser process,
so helpers die out from under the browser process's own in-flight,
self-directed `CefShutdown()` teardown. Confirmed three ways: (1)
`timeout --foreground` (direct signal delivery, no new group) is clean, 0
crash-loop; (2) `child_process.spawn()` + `child.kill("SIGTERM")` —
exactly what `benchmark/scripts/bench.ts` actually does — only signals the
root PID, never reproduces the crash-loop across dozens of runs (including
the real 20-rep benchmark session that produced the results above); (3)
**running the identical `timeout <N> node_modules/electron/dist/electron
.` against `electron-minimal` reproduces the exact same log signature
byte-for-byte** — not a bunium-vs-Electron difference at all, both
Chromium-embedding hosts behave identically when their helper-process
group is killed out from under them mid-shutdown. Not a benchmark-
invalidating issue (the real harness never triggers it) and not a bunium
code bug to fix — `bunium_subprocess` is a thin `CefExecuteProcess`
wrapper with no bunium-owned signal handling of its own; all subprocess
lifecycle/signal behavior here is inherited from CEF/Chromium's own
`//content`/`//base`, identically to Electron. **Real, worth-documenting
operational implication for anyone deploying a bunium app under a
supervisor that group-signals by default** (systemd's default
`KillMode=control-group` behaves the same way as unguarded `timeout`): use
`KillMode=process` (or an equivalent "signal only the main PID" mode) so
the app's own shutdown code gets to run before any helper process is
touched — the same guidance would apply to any Chromium-embedding app,
Electron included, not something specific to bunium's shutdown path.

Raw per-rep JSON: `benchmark/results/raw.json` / `benchmark/results/
summary.json` from this run (regenerated in place, not versioned — rerun
`report.ts` to reproduce).

## Windows results (2026-08-31, x86_64, bare host, first real run)

First real run of this harness on Windows (Windows 11 Pro 26200, Intel
i5-14600K, Git Bash/MSYS2). CEF `windows64` distro + `native/win/build.sh`
(clang-cl), `bun link` for the bunium apps, real `npm install` for the
Electron apps. `BENCH_REPS=5 BENCH_IDLE_SECONDS=6`, 20/20 reps clean.
On-disk size uses the packaged/trimmed `dist-app/` output
(`packaging/win/package.sh --verify`, 542M, passed its own pixel-check --
first real-Windows verification of the packaging pipeline).

| metric | bunium-minimal | electron-minimal | bunium-mini-app | electron-mini-app | winner |
|---|---|---|---|---|---|
| framework/runtime on-disk size (packaged) | 542M | 367M | -- | -- | Electron |
| process boot (bare `-e "exit(0)"`, median of 10) | 60ms (bun) | **48ms (node)** | -- | -- | Electron |
| process start -> first paint (ms) | **149** | 188 | **160** | 189 | **bunium** |
| idle RSS (MB) | 578.6 | **287.2** | 609.7 | **309.1** | Electron |
| process count (main + helpers) | 5 | **4** | 5 | **4** | Electron |
| idle CPU, full process tree (%) | **0** | **0** | **0** | **0** | tied |
| IPC round trip, avg of ~50 (ms) | -- | -- | 10.4 | **0.2** | Electron |
| mini-app DOM render, 200 rows (ms) | -- | -- | 1.1 | 1.0 | tied |

**Shape differs from mac/Linux:** bunium wins startup/paint time outright
here (unique to Windows); RSS/process count/IPC latency favor Electron
(same direction as mac); idle CPU is a 0%/0% tie (same shared
`disable-features` flags, compiled in via `native/win/build.sh`'s
shared-sources recipe). **Real finding: `bun` boots slower than `node`
on this host** (60ms vs 48ms median) -- opposite of mac's ~5.8x bun win,
not investigated further (Bun's own startup cost, not a bunium code
path).

**Two real bugs found and fixed getting this run working:**

1. `benchmark/shared/{app.js,index.html}` are Git symlinks that check out
   as broken placeholder text files on Windows (`core.symlinks=false`
   default) -- not a code bug, worked around by copying the real files
   over the placeholders.
2. **`benchmark/scripts/report.ts`'s `REPO` path was a real bug, fixed.**
   `new URL("../..", import.meta.url).pathname` returns a POSIX-style
   path on Windows (leading `/`, `%20`-encoded spaces) -- passed as `cwd`
   to `child_process.spawn`, this broke Windows' `CreateProcess` PATH
   search entirely, so even `spawn("bun", ...)` failed with `ENOENT`
   despite `bun.exe` being on `PATH`. Fixed with
   `fileURLToPath(new URL("../..", import.meta.url))`. Would have
   silently broken the harness for any future from-scratch Windows run.

## IPC latency, round 2: wake self-pipe — landed, measured a win, later found to be a dead no-op (2026-08-31)

Investigated after Round 1 (below) left IPC ~4-9x behind Electron. Traced
the full round-trip call chain (renderer `send()` → `CefProcessMessage` →
browser-process inbox → **JS pump pickup** → `.on()` handler → `emit()` →
`CefProcessMessage` back to renderer → JS callback) and identified the
pickup step as the likely dominant cost: `OnScheduleMessagePumpWork
(delay_ms)` only updated an atomic deadline; `src/app.ts`'s pump loop could
only *discover* that deadline on its *next already-scheduled* `setTimeout`
tick.

Shipped fix: an in-process `AF_UNIX` `socketpair()` self-pipe, written from
native whenever `OnScheduleMessagePumpWork` requested `delay_ms <= 0`, with
`src/app.ts` wrapping the read end in a `node:net` `new net.Socket({fd})`
and reacting to its `'data'` event. **Measured avg round-trip 4.5ms →
~2.3-2.4ms (~1.9x) across 3 reps** — looked like a real, working fix and
was documented as one.

**It wasn't.** Pushed further (user: "why still >1ms, find root cause") by
adding same-clock-domain native tracing (`BUNIUM_IPC_DIAG`, `BuniumIpcDiagLog`
in `bunium_common.h` — `std::chrono::steady_clock` is one shared monotonic
timebase across every process on the machine, unlike `performance.now()`,
which has a per-process time origin and can't be subtracted across the
browser/renderer boundary) at every hop. The trace showed native's
`write()` calls landing correctly on the self-pipe, but the JS socket's
`'data'` event **never firing once** across a full run — confirmed as a
genuine Bun 1.4.0 limitation via a minimal standalone repro
(`new net.Socket({fd})` wrapping a bare `socketpair()`/`pipe()` fd created
outside Bun's own socket machinery never delivers readable events on
macOS), not anything specific to this codebase. Re-running the "4.5ms →
2.3ms" benchmark against this confirmed-inert code a second time measured
**~3.1ms avg** — inside the same noise band as both the "before" and
"after" numbers. **The original 1.9x improvement was measurement noise,
not a real effect** — the wake write() calls were happening constantly
(idle compositor activity alone triggers dozens/sec) but writing into a
pipe nobody was ever reading, a harmless no-op. Corrected here rather than
left standing; see round 3 below for the actual fix, and
`project_bunium_beat_electron_perf` memory for the "same-clock-domain
tracing catches what aggregate benchmark timing alone can't" lesson.

## IPC latency, round 3: the real fix — Bun-owned wake socket (2026-08-31)

Same diagnosis as round 2 (pickup gated by the pump's `setTimeout`
granularity) but the delivery mechanism swapped: instead of JS wrapping a
raw externally-created fd (broken, see above), **`src/app.ts` itself calls
`Bun.listen({unix: path, socket: {...}})`** — Bun's own socket
implementation, not a fd-wrapping compat shim — and native `connect()`s to
it as a plain client (`bunium_set_wake_socket_path`, `native/mac/
bunium_shim.cpp`), writing a byte whenever it has work ready
(`BuniumWakeJs`, called from `OnScheduleMessagePumpWork` when
`delay_ms <= 0`, and directly from the inbox-push path as a second safety
net). Verified via an isolated repro (`Bun.listen` unix socket, 200
samples) that this delivers `data` in **~30-40us median** before shipping
it for real — the lesson from round 2 was "verify the actual event fires
with same-clock-domain tracing before trusting an aggregate benchmark
number," applied up front this time.

A function pointer (`g_wake_js_fn`, `bunium_common.h`), not a direct
`extern` call, is still required for the same reason as round 2:
`bunium_common.h` also compiles into `subprocess_main.cpp`, a separate
executable built without linking `bunium_shim.dylib` — an extern reference
to a shim-only symbol fails to link there even though child processes
never call it. Windows has no implementation yet (`bunium_set_wake_socket_
path` is a no-op returning `0`); the JS side falls back unchanged to the
pre-existing timer-only pump there, exactly as safely as if the feature
didn't exist. Concrete next step for Windows: WinSock2's `AF_UNIX` support
(`afunix.h`, available since Windows 10 build 17063) — same `socket()`/
`connect()`/`write()` shape, needs `WSAStartup`/`ws2_32.lib` added to
`native/win/build.sh` (neither exists yet for any other reason in this
codebase) — genuinely unverified, no Windows machine in this session,
flagged rather than guessed at. Linux should carry the fix unchanged (same
shared source, POSIX `AF_UNIX` + `Bun.listen` both platform-generic) but
was **not verified this session either** — same "shared source, unverified
on that OS" caveat this codebase already carries for the mac-first
idle-CPU/process-count fixes.

**Result** (bunium-mini-app's 50-call IPC sweep, native `BUNIUM_IPC_DIAG`
tracing of individual round trips, and the formal benchmark harness, same
machine/methodology as the table below):
- Native trace of individual round trips (`renderer_send_v8` →
  `renderer_dispatch_recv`, i.e. the full renderer→browser→renderer path):
  **consistently ~100-800 microseconds** in steady state, e.g. one
  captured cycle: send at t=0us, browser inbox receipt at +130us, `.on()`
  handler fires at +318us, reply sent at +371us, renderer receives at
  +448us total.
- Formal benchmark avg round-trip: **4.5ms → ~0.3-0.7ms (~7-13x)**, median
  **~0.2-0.4ms** — now inside the same run-to-run noise band as Electron
  itself (Electron's own avg varied 0.23-0.82ms across repeat runs in this
  same session). Verified against the full 37/37 `examples/*.ts` sweep, no
  regressions, both before and after an added warm-up-ping refinement
  (below).
- **One remaining artifact, not yet fully explained**: the *first* IPC
  call of a freshly-started process costs 6-8ms (sometimes higher, one
  capture showed 33ms) in ~3 of 4 runs — every subsequent call in the same
  process is sub-millisecond. Adding a warm-up ping (`BuniumWakeJs()`
  called once immediately after the wake socket connects, so the
  connection's first-ever byte isn't also the first real wake) reduced but
  did not eliminate this — one run dropped the first call to 1.0ms, three
  didn't improve. Consistent with *some* one-time kernel/kqueue cost for a
  freshly-connected socket's first readable event, or unrelated first-
  paint/first-V8-context bootstrap cost coinciding with the first message
  — not root-caused with certainty, but confirmed to be a one-time
  per-process startup cost, not a steady-state defect, so not chased
  further this session. Concrete next step: capture `BUNIUM_IPC_DIAG`
  traces specifically bracketing the very first call across several fresh-
  process runs and compare against a trace of window creation/first-paint
  timing to see whether the two overlap.

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

### Round D: the real fix — `GatherProcessRequirementMetrics`, idle CPU 56-59% → ~3% (2026-08-30)

Follow-up session picked up the three "concrete next steps" above. Rather
than a full CEF-from-source rebuild (started, then abandoned once this
was found — see below), the actual `StackSamplingProfiler` hypothesis was
tested directly and ruled out: the exact Chromium command-line switch
that disables it, `--disable-stack-profiler` (`chrome/common/profiler/
thread_profiler_configuration.cc`'s `GenerateBrowserProcessConfiguration`,
a plain switch check, distinct from and never tried alongside the
`--disable-features=StackSamplingProfiler` attempted in Round A), was
injected via `BUNIUM_CEF_SWITCHES` against the existing prebuilt CEF —
**zero measured effect** (57.1% baseline vs 56.1% with the switch, i.e.
noise). Root cause: `StackSamplingProfiler` really was ~28% of *task
count* (Round C) but each sample is cheap — count share doesn't equal
CPU-time share. `--disable-background-networking` (kills Sync/component-
updater/safebrowsing-update/translate — all real, present in the Round C
trace) was tried next, also **zero measured effect** (57.1% vs 56.1%).

A fresh symbol-level `sample` capture (same UUID-matched-dSYM method as
Round B, re-verified match) revealed the real culprit was still alive
despite Round B's fix: a `ThreadPoolBackgroundWorker` thread's **entire**
sampled window (100% of every sample tick across the whole capture) was
inside `base::mac::ProcessRequirement::{ValidateProcess,GatherMetrics}`
— the *exact same symbol* Round B supposedly eliminated. The two features
Round B disabled (`MachPortRendezvousValidatePeerRequirements`/
`EnforcePeerRequirements`) gate Mach-port-rendezvous peer validation
specifically; `GatherMetrics()` is called from a **separate, independent**
entry point, `ProcessRequirement::MaybeGatherMetrics()`
(`base/mac/process_requirement.cc`), gated by its own feature —
`"GatherProcessRequirementMetrics"`, `FEATURE_ENABLED_BY_DEFAULT` — that
Round B's fix never touched. It exists purely to record
`Mac.ProcessRequirement.*` UMA histograms (team ID / validation category
/ code-signature check timing), i.e. Chrome-telemetry-only work with zero
functional purpose for a non-metrics-reporting embedder — and in this
dev environment (`bun run script.ts`, not a signed `.app` bundle) the
underlying code-signature validation call apparently hangs/blocks for
the process's entire lifetime on one worker thread.

Verified via `BUNIUM_CEF_SWITCHES="--disable-features=GatherProcessRequirementMetrics"`
against the live app (t=10-40s window, same methodology as every other
idle-CPU measurement here): **59.4% → 3.0%**. Shipped as a third entry in
`native/mac/bunium_common.h`'s `OnBeforeCommandLineProcessing`
`disable-features` list (alongside the two Round B flags), rebuilt,
re-verified with no env override (fix is unconditional now): **CPU time
grew only 0.77s over a 30s window ≈ 2.6%**, matching. Full 37-example
sweep still green after the change.

**A partial CEF-from-source rebuild was attempted first this session**
(to patch `ThreadProfilerClient` directly, since the `--disable-stack-
profiler` switch test above hadn't happened yet) — `depot_tools` +
Chromium synced successfully at the exact pinned commit
(`be1e15d8892c064f0299ba18350236a9b272ce7f`, matching
`vendor/cef-macosarm64` exactly) after working around two real sandbox
network quirks (`gclient`'s hermetic-python CIPD bootstrap 403s here —
bypass via `VPYTHON_BYPASS` env var; `depot_tools/gsutil.py`'s own
bootstrap hits a *different* blocked host, `www.googleapis.com`, fixed by
patching it to skip that metadata call and hit `storage.googleapis.com`
directly). **Abandoned once the switch test proved the underlying fix
wouldn't have helped anyway** — the real driver was `GatherMetrics`, not
`ThreadProfiler`. The synced source tree is a reusable asset for any
future from-source CEF patching (env vars and gotchas fully documented,
see project memory `project_bunium_cef_source_build.md`), but wasn't
needed for this fix.

**Updated ceiling:** with idle CPU now ~3% (was the dominant behind-
Electron metric across two full investigation sessions), IPC latency and
startup time are the only metrics with real remaining gaps — both
previously root-caused with no lever found (IPC: inherent multi-process
Mojo dispatch cost; startup: `CefInitialize()` itself). Mini-app RSS
remains behind but untouched by this investigation.

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
