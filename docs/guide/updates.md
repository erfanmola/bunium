# Auto-update

Ships app-code updates as small binary-delta patches instead of re-downloading
everything — CEF itself is never re-downloaded on update.

## Wiring

```ts
import { app, BuniumWindow, updater, relaunchApp } from "bunium";

// self-repair any interrupted update from a previous run, once at startup:
updater.repairInterruptedUpdate(installDir);

updater.on("ready", ({ dir }) => updater.relaunch(relaunchApp));
```

## API

```ts
export type Platform = "mac" | "linux" | "win";
export type Arch = "arm64" | "x64";

updater.check({ feedUrl, currentVersion, channel?, platform?, arch? });
// → { status: "up-to-date" } | { status: "update-available", update: { method: "patch"|"full", ... } }

updater.isUpToDate; // last check result
updater.install(installDir); // after a check() that found an update
updater.relaunch(relaunchApp);

// events: checking / downloadStarted / progress / applying / ready / relaunching / error
```

An update is served as a small JSON manifest plus either a patch or a full
archive, hosted anywhere static (S3, R2, GitHub Releases — no update server
needed). If the running version is more than one release behind, the updater
falls back to a full download rather than chaining patches.

## Releasing an update

```sh
bun run release:update --old <prev-dist> --new <cur-dist> --out <dir>
```

Emits the manifest + patch + full archive for your static host. Publishing them
is up to you (no feed CI built in).

Related: [Packaging](/guide/packaging).
