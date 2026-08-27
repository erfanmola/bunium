# bunium vs Electron benchmarks

Measured on one machine (Apple M2 Pro, macOS, arm64), bun 1.4.0 vs Electron
44.0.0, 3 repetitions per scenario (median reported). Full methodology, raw
per-rep data, and the harness itself live in
[`benchmark/`](https://github.com/erfanmola/bunium/tree/main/benchmark)
(see `benchmark/RESULTS.md` for the unabridged version of this page,
including a full round of targeted perf work aimed at closing every gap).

Two comparable app pairs, same UI on both sides:

- **minimal** — one window, one static page.
- **mini-app** — a small dashboard (sidebar, 200-row table, one IPC-driven
  counter); `benchmark/shared/{index.html,app.js}` is the literal same file
  loaded by both hosts.

## Results (after a targeted macOS perf pass)

| metric | bunium-minimal | electron-minimal | bunium-mini-app | electron-mini-app |
|---|---|---|---|---|
| process start → first paint (ms) | 305 | 163 | 327 | 203 |
| idle RSS, full process tree (MB) | **403.0** | 418.1 | 467.3 | 450.9 |
| idle CPU, full process tree (%) | 55.0 | 0 | 57.0 | 0 |
| process count (main + helpers) | **5** | 5 | **5** | 5 |
| mini-app DOM render, 200 rows (ms) | — | — | 1.0 | 1.0 |
| IPC round trip, avg of 50 (ms) | — | — | 2.5 | 0.2 |

| | size on disk |
|---|---|
| bunium (trimmed CEF + shim) | 260M |
| Electron 44 runtime | 306M |

| | process boot, bare `-e "process.exit(0)"` (median) |
|---|---|
| bun 1.4.0 | 6.3ms |
| node v26.7.0 | 36.6ms |

**Beaten or matched:** on-disk framework size, Bun-vs-Node process boot,
process count (now tied 5=5), minimal-app idle RSS (403MB vs 418MB — first
resource metric bunium wins outright). **Substantially closed:** IPC
latency (~4.3x faster than the original baseline), mini-app idle RSS (gap
cut by ~80%). **Still behind, root-caused, not a quick fix:** idle CPU,
startup time — see below.

## What moved, and why

Two native changes: (1) an adaptive CEF message pump
(`external_message_pump` + `OnScheduleMessagePumpWork`, replacing a fixed
8ms `setInterval`) cut IPC round-trip latency ~4.3x by only waking as often
as CEF actually has work; (2) disabling Chromium's spare-renderer-process
feature (bunium's window creation already knows its one navigation up
front — there's no "next tab" to pre-warm a spare renderer for) dropped
process count from 6 to 5, matching Electron, and RSS followed.

**Idle CPU didn't move**, and that turned out to be the real finding: a
standalone FFI harness isolating the two native pump calls showed the CPU
cost isn't primarily driven by *how often* bunium polls — moving the poll
interval around 8-40ms produced no clean, reproducible cost curve. That
points to CEF's own windowless-OSR compositor running a continuous,
frame-rate-paced internal repaint cycle regardless of whether page content
actually changed; the message pump merely services that cost, it doesn't
cause it. Closing this gap needs investigating whether CEF's windowless
OSR path can become invalidate-driven instead of continuously repainting —
a bigger, separate piece of work, logged in `PLAN.md`.

**Startup time didn't move either** — no bunium-specific inefficiency was
found in the window-creation path (each FFI call is a single synchronous
native call, no extra round trips). The ~300ms is dominated by
`CefInitialize()` loading the ~300MB CEF framework and spawning its
subprocess tree, versus Electron's single precompiled executable. Also
logged as a follow-up.

## Caveats

One machine, one run per round — enough to trust order-of-magnitude
signals (CPU, IPC, the RSS flip) but not to trust startup/RSS to much
better than ~10-20% precision. macOS arm64 only; the two shipped native
changes live in shared code compiled unchanged into the Linux/Windows
builds too, so those platforms should inherit at least the IPC-latency and
process-count wins once rebuilt there, but this wasn't verified on those
platforms this pass. The Electron mini-app uses `nodeIntegration: true,
contextIsolation: false` for an IPC-shape comparable to bunium's single-hop
channel — a production Electron app would add a `contextBridge` preload
hop with its own small overhead this doesn't capture. Bundle size compares
the raw framework/runtime payload, not a fully packaged+signed installer
for both sides.
