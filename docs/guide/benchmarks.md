# bunium vs Electron benchmarks

Measured on one machine (Apple M2 Pro, macOS, arm64), bun 1.4.0 vs Electron
44.0.0, 3 repetitions per scenario (median reported). Full methodology, raw
per-rep data, and the harness itself live in
[`benchmark/`](https://github.com/erfanmola/bunium/tree/main/benchmark)
(see `benchmark/RESULTS.md` for the unabridged version of this page).

Two comparable app pairs, same UI on both sides:

- **minimal** — one window, one static page.
- **mini-app** — a small dashboard (sidebar, 200-row table, one IPC-driven
  counter); `benchmark/shared/{index.html,app.js}` is the literal same file
  loaded by both hosts.

## Results

| metric | bunium-minimal | electron-minimal | bunium-mini-app | electron-mini-app |
|---|---|---|---|---|
| process start → first paint (ms) | 320 | 161 | 350 | 195 |
| idle RSS, full process tree (MB) | 466.8 | 416.3 | 532.3 | 451.2 |
| idle CPU, full process tree (%) | 56.5 | 0 | 56.0 | 0 |
| process count (main + helpers) | 6 | 5 | 6 | 5 |
| mini-app DOM render, 200 rows (ms) | — | — | 0.9 | 1.0 |
| IPC round trip, avg of 50 (ms) | — | — | 11.9 | 0.2 |

| | size on disk |
|---|---|
| bunium (trimmed CEF + shim) | 260M |
| Electron 44 runtime | 306M |

| | process boot, bare `-e "process.exit(0)"` (median) |
|---|---|
| bun 1.4.0 | 6.3ms |
| node v26.7.0 | 36.6ms |

## The headline finding

The idle-CPU and IPC-latency gaps (both roughly an order of magnitude) trace
to one root cause: bunium's message pump (`src/app.ts`, `startPumpLoop`)
drives CEF's message loop off a fixed 8ms `setInterval`, unconditionally,
rather than integrating with the OS's native run loop the way Electron
does. Electron blocks until there's real work (idle CPU ≈ 0%, an IPC reply
is processed on the next natural wake); bunium's poll means the process
is never truly idle, and an IPC reply waits an average of roughly half the
poll interval before being noticed. Not a bug, and out of scope for this
benchmarking pass to fix — but it's the clearest, most actionable lead for
a future optimization phase (an adaptive interval, or a real OS-level
wakeup source instead of blind polling).

Everything else — startup time, RSS, DOM render cost, on-disk size, Bun's
much faster process boot than Node's — behaves about how you'd expect two
"real Chromium in a desktop shell" frameworks to compare, with bunium's
higher packaging trim and faster process boot working in its favor and its
younger, simpler pump loop working against it on the two metrics above.

## Caveats

One machine, one run — enough to trust the order-of-magnitude CPU/IPC
signal (reproducible every rep) but not to trust startup/RSS to much better
than ~10-20%. macOS arm64 only; no Linux/Windows numbers yet. The Electron
mini-app uses `nodeIntegration: true, contextIsolation: false` for an
IPC-shape comparable to bunium's single-hop channel — a production Electron
app would add a `contextBridge` preload hop with its own small overhead
this doesn't capture. Bundle size compares the raw framework/runtime
payload, not a fully packaged+signed installer for both sides.
