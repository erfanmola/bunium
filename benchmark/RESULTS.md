# bunium vs Electron — benchmark results

Raw numbers backing [`docs/guide/benchmarks.md`](../docs/guide/benchmarks.md). One table
per OS; a platform stays a placeholder here until it's been measured against the
current build.

## Methodology

Two comparable app pairs, same UI on both sides:

- **minimal** — one window, one static page.
- **mini-app** — a small dashboard (sidebar, 200-row table, one IPC-driven counter),
  built from the exact same HTML/JS loaded by both hosts
  (`benchmark/shared/{index.html,app.js}`, symlinked into each app dir).

Runs are sequential, never parallel (CEF's `ProcessSingleton` aborts a concurrent
second bunium process; running Electron alongside would contaminate CPU/RSS samples
anyway), median of `BENCH_REPS` reps reported. Real GPU compositing on both sides
(no `--disable-gpu`) — that switch only exists in CI to work around GitHub's
GPU-less runners, it's not representative of a real machine.

```sh
bun link                                    # from the repo root
bun link bunium                             # inside each benchmark/*-minimal, *-mini-app dir
BENCH_REPS=5 BENCH_IDLE_SECONDS=6 bun run benchmark/scripts/report.ts
```

Requires the native build for your platform (`bun run build:native:mac` / `:linux` /
`:win`) and Electron's real binary installed in each `benchmark/electron-*` app
(`bun install`, then — if lifecycle scripts were skipped — `bun run
node_modules/electron/install.js`).

## macOS

- Hardware: Apple M2 Pro, macOS 27.0 (arm64)
- bun 1.4.0, node v26.8.1, Electron 44.0.0
- 5 reps/scenario, median (10 reps for the bare process-boot numbers)
- Measured 2026-09-02, `BENCH_REPS=5 BENCH_IDLE_SECONDS=6`, disk size from a
  freshly staged `bun run release:artifacts` output

| metric | bunium | Electron | winner |
|---|---|---|---|
| framework/runtime on-disk size | 260 MB | 306 MB | **bunium** |
| process boot (bare `-e "exit(0)"`) | 6.1 ms (bun) | 35.2 ms (node) | **bunium** |
| process count (main + helpers) | **1** | 4 | **bunium** |
| idle RSS, minimal app | **273.8 MB** | 373.1 MB | **bunium** |
| idle RSS, mini-app | **334.4 MB** | 405.6 MB | **bunium** |
| first paint after launch | 295 ms | 161 ms | Electron |
| first paint, mini-app | 319 ms | 195 ms | Electron |
| idle CPU, full process tree | 1.5–2.0% | 0–0.5% | Electron (near-tied) |
| IPC round trip (median avg-of-50) | 0.2 ms | 0.2 ms | tied |
| mini-app DOM render, 200 rows | 1.0 ms | 1.0 ms | tied |

macOS runs `--single-process` (renderer + GPU + all utility services merged into the
main process) and `--in-process-gpu`, a deliberate reversal of an earlier decision —
see `ARCHITECTURE.md` §19 for the full tradeoff (isolation/crash-containment given up,
V8 PAC-proxy support lost). **Not enabled on Linux/Windows** — `--single-process` has a
documented real crash risk from Windows native bring-up (`docs/guide/dev-from-mac.md`),
gated to macOS only in `bunium_common.h` until independently verified elsewhere. Idle
CPU and IPC latency both used to be the big Electron leads (59% vs ~3% era, 4.5ms era)
— both fixes already shipped and are holding here; see `PLAN.md`'s post-Phase-11 notes
for the root causes if that history is ever needed.

## Linux

Not yet re-benchmarked against the current build with this table format. A real run
happened on bare-metal x86_64 during development (see `PLAN.md`) but is not
transcribed here — TODO, next benchmarking pass.

## Windows

- Hardware: real Windows hardware — GitHub Actions `windows-latest` runner, via
  `.github/workflows/win-smoke.yml` (Tier 1 of `docs/guide/dev-from-mac.md`'s
  remote-Windows workflow), clang-cl build via `native/win/build.sh`
- bun 1.4.0, Electron (bundled version resolved by `bun install` on the runner)
- 5 reps/scenario, median
- Measured 2026-09-03, `BENCH_REPS=5 BENCH_IDLE_SECONDS=6`

| metric | bunium | Electron | winner |
|---|---|---|---|
| process count (main + helpers) | 4 | 4 | tied |
| idle RSS, minimal app | **224.5 MB** | 252.1 MB | **bunium** |
| idle RSS, mini-app | **256.3 MB** | 281.4 MB | **bunium** |
| first paint after launch | 255 ms | 164 ms | Electron |
| first paint, mini-app | 279 ms | 213 ms | Electron |
| idle CPU, full process tree | 3.1% | 0% | Electron |
| IPC round trip (median avg-of-50) | 0.5 ms | 0.3 ms | Electron |
| mini-app DOM render, 200 rows | 3.9 ms | 2.9 ms | Electron |

**`--single-process` was tested on Windows and rejected — confirmed genuinely
unsafe, not just unverified.** Baseline full `examples/*.ts` sweep (flag off): 37/38
clean (only the expected mac-only `color-scheme-live-test.ts` failure). With the flag
added: 34/38, three *new* failures not present in the baseline —
`relaunch-test.ts` (shim timing assertion failed), `scheme-handler-test.ts` (hung to
timeout; CEF itself logged `Cannot use V8 Proxy resolver in single process mode` —
an explicit CEF-side rejection of the combination, not a flake), and
`vite-dev-test.ts` (dev server never became ready). This matches and confirms the
pre-existing documented "bun + in-process CEF SEGVs" risk from Windows native
bring-up noted in `docs/guide/dev-from-mac.md`. See the dated comment in
`native/mac/bunium_common.h` next to the `--single-process` gate for the full repro
notes, and `PLAN.md`'s post-Phase-11 section for the investigation writeup. The
numbers above are the shipping configuration: no `--single-process`, no
`--in-process-gpu`.

## Framework/runtime on-disk size (macOS)

| | size |
|---|---|
| bunium (trimmed CEF + shim, `dist-release/bunium-darwin-arm64/`) | 260 MB |
| Electron 44 `node_modules/electron/dist` | 306 MB |

## Bun vs Node process boot (bare `-e "process.exit(0)"`, median of 10, macOS)

| | median ms |
|---|---|
| bun 1.4.0 | 6.1 |
| node v26.8.1 | 35.2 |

## Caveats

- One machine per platform, small rep counts — enough to trust order-of-magnitude
  signals and structural flips (RSS/process-count), not to treat startup-time numbers
  as accurate to better than ~10–20%.
- The mini-app's Electron `bridge.js` runs with `nodeIntegration: true,
  contextIsolation: false` for a same-shape IPC comparison against bunium's
  single-hop `window.__bunium` channel — a production Electron app should use
  `contextBridge` + a preload script instead, which adds its own (small) overhead
  this benchmark doesn't capture.
- Bundle-size comparison is the raw framework/runtime payload, not a fully
  packaged+signed installer for both sides — treat it as "what ships with the app,"
  not "final download size."
