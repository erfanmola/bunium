# bunium vs Electron

Measured 2026-09-02 on an Apple M2 Pro (macOS, arm64), bun 1.4.0 vs Electron
44.0.0, median of 5 runs per scenario. Full methodology, raw data, and the
benchmark harness itself live in
[`benchmark/`](https://github.com/erfanmola/bunium/tree/main/benchmark).
Linux (real bare-metal x86_64 hardware) and Windows (real Windows hardware via
GitHub Actions) numbers are now measured too — see
[`benchmark/RESULTS.md`](https://github.com/erfanmola/bunium/tree/main/benchmark/RESULTS.md)
for those tables.

Two comparable app pairs, same UI on both sides:

- **minimal** — one window, one static page.
- **mini-app** — a small dashboard (sidebar, 200-row table, one IPC-driven
  counter), built from the exact same HTML/JS loaded by both hosts.

## macOS results

| metric | bunium | Electron | winner |
|---|---|---|---|
| framework/runtime on-disk size | 260 MB | 306 MB | **bunium** |
| process boot (bare `-e "exit(0)"`) | 6.1 ms (bun) | 35.2 ms (node) | **bunium** |
| process count (main + helpers) | **1** | 4 | **bunium** |
| idle RSS, minimal app | **273.8 MB** | 373.1 MB | **bunium** |
| idle RSS, mini-app | **334.4 MB** | 405.6 MB | **bunium** |
| first paint after launch | 295 ms | 161 ms | Electron |
| idle CPU, full process tree | 1.5-2.0% | 0-0.5% | Electron (near-tied) |
| IPC round trip (median avg-of-50) | 0.2 ms | 0.2 ms | tied |
| mini-app DOM render, 200 rows | 1.0 ms | 1.0 ms | tied |

bunium wins on disk footprint, process boot time, process count, and RSS
(both app shapes), and ties on IPC latency and DOM render. Electron still
leads on first paint and idle CPU (though the CPU gap is now noise-level).

macOS runs Chromium in `--single-process` mode (renderer + GPU + all
utility services merged into one OS process) — a deliberate tradeoff, not
a free win: it gives up the renderer/GPU process isolation that's normally
Chromium's crash/security boundary against untrusted content, and disables
PAC-based system proxy autoconfig. See [ARCHITECTURE.md
§19](https://github.com/erfanmola/bunium/blob/main/ARCHITECTURE.md) for the
full reasoning. **Not enabled on Linux or Windows** — both were independently
re-verified and rejected on 2026-09-03, not just left unverified. On Linux
(real bare-metal x86_64 hardware, not a VM), `examples/vite-dev-test.ts`
reproduced the same `SIGTRAP` crash during `app.shutdown()` cleanup seen on
an earlier WSL2 host, plus a newly observed, more consistently reproducible
failure: real HTTP page loads failing outright (`ERR_ABORTED`) alongside CEF
logging `Cannot use V8 Proxy resolver in single process mode`. On Windows
(real Windows hardware via GitHub Actions, two independent CI runs), each run
turned up at least one real new example failure not present in the baseline
— different examples each time, but every failure traced back to that same
CEF-side proxy-resolver rejection, confirming the real crash risk already
documented from Windows native bring-up (see [Dev from
macOS](/guide/dev-from-mac)). Full repro notes: `native/mac/bunium_common.h`
next to the `--single-process` gate, and `benchmark/RESULTS.md`.

## What moved the numbers

- **Adaptive message pump.** CEF's event loop now runs off an
  `external_message_pump` callback instead of polling on a fixed interval,
  which cut IPC round-trip latency roughly 4-9x.
- **Spare-renderer disabled.** A bunium window's navigation target is known
  at creation time, so there's no "next tab" to pre-warm a spare renderer
  for — turning that Chromium feature off dropped process count and idle
  RSS on the minimal-app case.
- **`--single-process` + `--in-process-gpu`** (macOS only, see above) —
  merges everything into one process. Real RSS/process-count win, no
  measured perf cost, at the cost of crash isolation.

Idle CPU dropped from ~59% to ~3% by disabling two Chromium features that
have no purpose for a non-Electron embedder: Mach-port code-signature
peer validation, and `GatherProcessRequirementMetrics` (pure telemetry).
Both are internal Chromium flags with no user-facing effect.

## Known gaps

- First paint (~300ms) breaks down as roughly 112ms `CefInitialize()`, 35ms
  one-time AppKit/WindowServer setup, 120ms renderer/Blink/V8 bootstrap —
  real numbers, not a guess, from `BUNIUM_CEF_VERBOSE=1`'s `[startup-diag]`
  output. The AppKit chunk is a real, quantified lever but not a quick fix
  (see `ARCHITECTURE.md` §20 for why); the other two look like inherent
  Chromium engine cost. Hardware-accelerated OSR
  (`OnAcceleratedPaint`/shared textures) is blocked upstream on macOS, not
  a bunium gap — CEF's own mac header says it's Windows-only today; see
  the Roadmap.
- Linux and Windows now have current-format tables in `benchmark/RESULTS.md`,
  but neither ships the single-process change — both were tested and found
  unsafe (see above).

## Running the benchmarks yourself

```sh
bun link                                    # from the repo root
bun link bunium                             # inside each benchmark/*-minimal, *-mini-app dir
BENCH_REPS=5 BENCH_IDLE_SECONDS=6 bun run benchmark/scripts/report.ts
```

Requires the native build for your platform (`bun run build:native:mac` /
`:linux` / `:win`) and Electron's real binary installed in each
`benchmark/electron-*` app (`bun install`, then — if lifecycle scripts were
skipped — `bun run node_modules/electron/install.js`).
