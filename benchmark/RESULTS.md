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
V8 PAC-proxy support lost). **Not enabled on Linux/Windows** — `--single-process` was
independently verified and rejected on both (see each platform's section below for the
full repro details): a real shutdown-path crash plus real-HTTP-load breakage on Linux,
and the same CEF-side "V8 Proxy resolver" rejection causing non-deterministic real test
failures on Windows, matching the documented crash risk from Windows native bring-up
(`docs/guide/dev-from-mac.md`). Gated to macOS only in `bunium_common.h`. Idle CPU and
IPC latency both used to be the big Electron leads (59% vs ~3% era, 4.5ms era) — both
fixes already shipped and are holding here; see `PLAN.md`'s post-Phase-11 notes for the
root causes if that history is ever needed.

## Linux

- Hardware: real bare-metal x86_64 (Arch Linux, `7.1.11-arch1-1`), not a VM/emulator
- bun 1.4.0, Electron (bundled version resolved by `bun install`)
- 5 reps/scenario, median; run under `Xvfb :N -screen 0 1024x768x24` + a
  `dbus-launch` session bus, matching `docker/linux/run-examples.sh`'s setup
- Measured 2026-09-03, `BENCH_REPS=5 BENCH_IDLE_SECONDS=6`, native build via
  `native/linux/build.sh` against `vendor/cef-linux64`

| metric | bunium | Electron | winner |
|---|---|---|---|
| process count (main + helpers) | 6 | 11 | **bunium** |
| idle RSS, minimal app | **641.2 MB** | 777.1 MB | **bunium** |
| idle RSS, mini-app | **673.0 MB** | 866.2 MB | **bunium** |
| first paint after launch | 98 ms | 392 ms | **bunium** |
| first paint, mini-app | 110 ms | 435 ms | **bunium** |
| idle CPU, full process tree | 0% | 0% | tied |
| IPC round trip (median avg-of-50) | 0.4 ms | 0.5 ms | **bunium** |
| mini-app DOM render, 200 rows | 1.1 ms | 1.0 ms | Electron (near-tied) |

This host's `ps`-based process-tree walk correctly found Electron's full helper
tree (11 processes) — unlike an earlier WSL2 run referenced in `PLAN.md`, where the
same walk undercounted Electron's descendants (a harness gap specific to that host,
not a real result). Treat this bare-metal run as the trustworthy one. Absolute RSS is
much higher than macOS's numbers for both bunium and Electron — expected, this host
has no GPU and both browsers fall back to software compositing under Xvfb; the
relative bunium-vs-Electron comparison stays valid, the absolute numbers are not
comparable across platforms. idle CPU reads 0% for both at this rep count/idle
window (6s settle + 2s delta) — plausible for two genuinely idle windows with no
animation loop, not a broken measurement (spot-checked: no stray processes lingered
after each run).

**`--single-process` was independently re-verified on Linux (2026-09-03,
bare-metal x86_64, not just the earlier WSL2 host) and rejected — confirmed
unsafe, not just unverified.** Temporarily added `__linux__` to the `#if
defined(__APPLE__)` gate in `bunium_common.h`, rebuilt, ran the full
`examples/*.ts` sweep via `docker/linux/run-examples.sh`: 36/38, only
`vite-dev-test.ts` newly failed on the first pass, with a **new SIGTRAP core
dump during `app.shutdown()` cleanup** — reproducing the exact WSL2 finding
from `PLAN.md`'s earlier verification pass on completely different real
hardware, not a fluke of that one host. Re-running `vite-dev-test.ts` alone
several more times surfaced a second, more consistently reproducible failure
mode: real HTTP navigation (`loadURL()` against a live `localhost` Vite dev
server) failing with `ERR_ABORTED` on every run, correlated with CEF logging
`Cannot use V8 Proxy resolver in single process mode` — the same explicit
CEF-side rejection independently observed on Windows (see below). `data:` URL
navigations (`loadurl-test.ts`) are unaffected — only real network loads break.
**Not enabling `--single-process` on Linux.** Reverted the gate back to
`__APPLE__`-only immediately after verification; the shipping build was
rebuilt and re-confirmed clean (37/38, only the expected
`color-scheme-live-test.ts` failure) before these benchmark numbers were taken.

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
| idle RSS, minimal app | **223.5 MB** | 253.1 MB | **bunium** |
| idle RSS, mini-app | **257.1 MB** | 280.3 MB | **bunium** |
| first paint after launch | 265 ms | 147 ms | Electron |
| first paint, mini-app | 271 ms | 202 ms | Electron |
| idle CPU, full process tree | 0.8% | 0% | Electron |
| IPC round trip (median avg-of-50) | 0.4 ms | 0.3 ms | Electron |
| mini-app DOM render, 200 rows | 3.0 ms | 2.1 ms | Electron |

**`--single-process` was re-verified on Windows (2026-09-03) across two
independent fresh CI runs and rejected again — confirmed genuinely unsafe, not
just unverified.** Baseline full `examples/*.ts` sweep (flag off, shipping
config): 37/38 clean (only the expected mac-only `color-scheme-live-test.ts`
failure) — this run's baseline numbers are the table above. With `_WIN32`
added to the gate, real process-count collapse to **1** and RSS wins even
bigger than Electron's (161.4 MB / 192.4 MB vs Electron's 257.0 MB / 283.1 MB)
confirm the flag mechanically works the same way it does on macOS — but two
separate reruns each turned up real, reproducible-but-non-deterministic
functional breakage, not flakiness: run 1 hit 36/38 (`vite-dev-test.ts` failed
to become ready) with the CEF-side `Cannot use V8 Proxy resolver in single
process mode` error present in both the smoke and packaged-app logs even on
an otherwise-green run; run 2 hit 35/38 with two *new* failures —
`relaunch-test.ts` (shim timing assertion failed: `elapsed 5532ms < 5000ms`,
a real behavioral regression) and `scheme-handler-test.ts` (hung to timeout,
same `Cannot use V8 Proxy resolver in single process mode` CEF error logged
first). Different tests tripped each run, but every run showed the identical
root cause (CEF's own explicit rejection of `--single-process` + its network
stack on Windows) and at least one real new failure beyond the documented
baseline. This matches and confirms the pre-existing documented "bun +
in-process CEF SEGVs" risk from Windows native bring-up noted in
`docs/guide/dev-from-mac.md` — re-verified against current code today via the
Tier 1 remote-Windows workflow (throwaway branch + `workflow_dispatch` on
`win-smoke.yml`, `scripts/run-examples-win.sh` for the full sweep), not just
trusted from the old notes. **Not enabling `--single-process` on Windows.**
All temporary workflow/gate changes were reverted immediately after
verification (confirmed via `git diff` against `main` showing no drift) and
the throwaway branch deleted. See the dated comment in
`native/mac/bunium_common.h` next to the `--single-process` gate for the full
repro notes, and `PLAN.md`'s post-Phase-11 section for the investigation
writeup. The numbers above are the shipping configuration: no
`--single-process`, no `--in-process-gpu`.

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
