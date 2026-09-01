# bunium vs Electron

Measured on an Apple M2 Pro (macOS, arm64) and a bare-metal x86_64 Linux
box, bun 1.4.0 vs Electron 44.0.0, median of 5 runs per scenario. Full
methodology, raw data, and the benchmark harness itself live in
[`benchmark/`](https://github.com/erfanmola/bunium/tree/main/benchmark).

Two comparable app pairs, same UI on both sides:

- **minimal** — one window, one static page.
- **mini-app** — a small dashboard (sidebar, 200-row table, one IPC-driven
  counter), built from the exact same HTML/JS loaded by both hosts.

## macOS results

| metric | bunium | Electron | winner |
|---|---|---|---|
| framework/runtime on-disk size | 260 MB | 306 MB | **bunium** |
| process boot (bare `-e "exit(0)"`) | 6.3 ms (bun) | 36.6 ms (node) | **bunium** |
| idle RSS, minimal app | 432.7 MB | 374.1 MB | Electron |
| idle RSS, mini-app | 501.0 MB | 408.0 MB | Electron |
| process count (main + helpers) | 5 | 4 | Electron |
| first paint after launch | 305-335 ms | 159-196 ms | Electron |
| idle CPU, full process tree | 3.5-4.0% | 0-0.5% | Electron |
| IPC round trip (avg of 50) | 4.5 ms | 0.5 ms | Electron |
| mini-app DOM render, 200 rows | 1.0 ms | 1.0 ms | tied |

bunium wins on disk footprint and process boot time (Bun starts roughly 6x
faster than Node), and comes close everywhere else. Electron still leads on
memory, first paint, and IPC latency on this platform.

Linux numbers currently favor bunium on paint time, RSS, and process count
instead — the two platforms don't have the same shape, since they exercise
different OS-level facilities. See `benchmark/RESULTS.md` for the full Linux
table.

## What moved the numbers

Two changes accounted for most of the gains during development:

- **Adaptive message pump.** CEF's event loop now runs off an
  `external_message_pump` callback instead of polling on a fixed interval,
  which cut IPC round-trip latency roughly 4-9x.
- **Spare-renderer disabled.** A bunium window's navigation target is known
  at creation time, so there's no "next tab" to pre-warm a spare renderer
  for — turning that Chromium feature off dropped process count and idle
  RSS on the minimal-app case.

One more change, merging Chromium's GPU service into the browser process
(`--in-process-gpu`), got bunium's process count and mini-app RSS below
Electron's — but was reverted at the maintainer's request to keep GPU work
isolated in its own OS process. `--single-process` was tested too (drops to
one process entirely) but rejected: it also merges the *renderer*, which is
Chromium's real security boundary against untrusted content a
`<bunium-webview>` might load.

Idle CPU dropped from ~59% to ~3% by disabling two Chromium features that
have no purpose for a non-Electron embedder: Mach-port code-signature
peer validation, and `GatherProcessRequirementMetrics` (pure telemetry).
Both are internal Chromium flags with no user-facing effect.

## Known gaps

- **Windows IPC/idle-CPU numbers** reflect an earlier build before the
  message-pump work landed for that platform — re-benchmark before citing
  Windows numbers for anything other than "it runs."
- Startup time (~300ms) traces to `CefInitialize()` itself spawning CEF's
  subprocess tree — no bunium-side inefficiency found there so far.

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
