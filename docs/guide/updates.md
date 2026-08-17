# Auto-update

Phase 9 — bsdiff-based updater with a deliberate app-layer / CEF-layer split: the
CEF distribution is huge (~130MB compressed per platform and nearly never changes),
so the updater never treats a release as one monolithic blob. Small app-code
patches ship as binary deltas; a rare CEF bump ships as a whole-file replace.

## One-line app wiring

```ts
import { app, BuniumWindow, updater, relaunchApp } from "bunium";

// self-repair any interrupted swap from a previous run, once at startup:
updater.repairInterruptedUpdate(installDir);

updater.on("ready", ({ dir }) => updater.relaunch(relaunchApp));
```

## How it works

- **Feed:** static artifact host (S3, R2, GitHub Releases — no update server
  backend). Manifest at `<channel>-<os>-<arch>-update.json`
  (`stable-mac-arm64-update.json`). Flat, prefix-based naming mirrors
  Electrobun's convention.
- **`check()`** fetches just the small JSON manifest and decides **patch** vs
  **full**: delta `patch.bsdiff` only when `currentVersion == fromVersion`;
  otherwise `full.tar.zst` (Zstandard via `Bun.zstdDecompressSync`). Anyone more
  than one version behind gets the full download — a documented, deliberate
  simplification (single-previous-version patch, not a full patch graph), same
  tradeoff Electrobun makes.
- **`install()`** downloads and stages into a sibling dir; on success the old
  install is renamed to a backup and the staged tree renamed into place. The
  patch path re-tars the *installed* tree with the same deterministic ustar
  writer the build side uses (byte-equal), validates the patch header against
  `manifest.fullSize` + sha256 before applying. **Never touches CEF** — that's a
  separately-versioned artifact by design.
- **Crash journal:** `<installDir>.updating` records the staging path before the
  first rename. `repairInterruptedUpdate()` resolves every intermediate crash
  state: staged tree present → roll forward; staging lost + backup present +
  install missing → roll back; install already live → finish cleanup; corrupt
  journal → backup semantics. Invoked defensively at the top of every `install()`
  too.
- **`relaunchApp()`** shuts down CEF then re-execs `process.execPath` +
  `process.argv[1..]` — what the launcher originally ran, so `package.sh` needs
  zero changes. CEF's per-profile `ProcessSingleton` aborts a second concurrent
  browser, so a detached `sh` shim waits for the parent PID to die
  (`kill -0` polling, fractional-second `sleep`) before `exec`-ing.

## API

```ts
export type Platform = "mac" | "linux" | "win";
export type Arch = "arm64" | "x64";

updater.check({ feedUrl, currentVersion, channel?, platform?, arch? });
// → { status: "up-to-date" } | { status: "update-available", update: { method: "patch"|"full", ... } }

updater.isUpToDate; // last check result
updater.install(installDir); // after a check() that found an update
updater.relaunch(relaunchApp);

// events: checking / downloadStarted / progress {phase: "download"|"apply"} /
//         applying {method} / ready {version, dir} / relaunching {dir} /
//         error {message, recoverable}
```

`relaunchApp` and `buildRelaunchCommand` (pure, testable) are exported from
`bunium` as well.

## Releasing

`bun run release:update --old <prev-dist> --new <cur-dist> --out <dir>`
emits the flat artifact set — manifest, `patch.bsdiff`, `full.tar.zst`.
Deterministic: two runs produce identical sha256s. Publishing those artifacts to
your static host is currently manual (no feed CI yet).

## Verification

Headless: `examples/bsdiff-test.ts` (round-trip + corrupt/truncated-header
rejection), `examples/update-e2e-test.ts` (full flow over a local HTTP host:
patch path, full fallback when >1 version behind, up-to-date, recoverable
corrupt-patch failure), `examples/update-journal-test.ts` (all six crash-repair
states), `examples/relaunch-test.ts` (wait-for-death timing, argv fidelity incl.
space-containing args). The real quit-then-relaunch of a packaged app needs a
desktop session.

Related: [Packaging](/guide/packaging).
