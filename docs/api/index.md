# API reference

All exports are typed, strict-mode TS (no `any` without justification). Everything
below is what `src/index.ts` re-exports — the full public surface. Run
`bunx tsc --noEmit` in the repo root to typecheck any usage.

## Main process singleton

| Export                | Notes                                                                                                                                  |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `app`                 | `BuniumApp` singleton. `init()` (implicit via first window), `setAppRoot(dir)`, `shutdown()`. One per process — CEF's singleton model. |
| `BuniumWindow`        | `new BuniumWindow<M>(options)`. See [Window](/guide/window).                                                                           |
| `BuniumWindowOptions` | Constructor options type.                                                                                                              |
| `BuniumMessageMap`    | `Record<string, any>` base; override with your own interface for typed IPC. See [Typed IPC](/guide/ipc).                               |

## System

| Export                                                 | Notes                                                                                                                                                                                                                                          |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Menu`                                                 | Native `NSMenu` builder. `new Menu(items)`, `onClick(id)`, `setAsApplicationMenu()`.                                                                                                                                                           |
| `MenuItemSpec`                                         | Flat item union: `{type: "separator"}` \| `{label, id?, submenu?}`.                                                                                                                                                                            |
| `Tray`                                                 | `NSStatusItem`. `setMenu`, `onClick`, `setIcon(path, {template})`, `setSymbol(name)`.                                                                                                                                                          |
| `Notification`                                         | `new Notification({title, body?, id?})`, `show()`, `onClick()`.                                                                                                                                                                                |
| `showOpenDialog` / `showSaveDialog` / `showMessageBox` | Promise-based; never block the pump. Result types: `OpenDialogResult` (`canceled`, `paths`), `SaveDialogResult` (`canceled`, `path`), `MessageBoxResult` (`response`). Options: `OpenDialogOptions`, `SaveDialogOptions`, `MessageBoxOptions`. |
| `systemEvents`                                         | `SystemEventBus` singleton, drained by the app pump.                                                                                                                                                                                           |

See [System features](/guide/system).

## Updates

| Export                                | Notes                                                                                                                                                                                                                                                                 |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `updater`                             | `Updater` singleton: `check()`, `install()`, `relaunch()`, `repairInterruptedUpdate()`, `isUpToDate`, typed `on()`.                                                                                                                                                   |
| `updater.check` inputs                | `UpdateCheckOptions`: `feedUrl`, `currentVersion`, `channel?`, `platform?`, `arch?`. Result: `UpdateCheckResult`; manifest type `UpdateManifest`. `Platform` = `"mac" \| "linux" \| "win"`; `Arch` = `"arm64" \| "x64"`; `defaultPlatform()`/`defaultArch()` helpers. |
| `UpdaterEvent(s)` / `UpdaterEvents`   | Discriminated-union event payloads: `checking`, `downloadStarted`, `progress` (`phase: "download"\|"apply"`), `applying` (`method: "patch"\|"full"`), `ready`, `relaunching`, `error` (`recoverable` flag).                                                           |
| `repairInterruptedUpdate(installDir)` | Crash-journal self-repair; returns `UpdateRepairResult` (`"repaired"\|"rolled-back"\|"none"`).                                                                                                                                                                        |
| `relaunchApp(options?)`               | Shut down CEF, wait for parent death, re-exec the launcher command. `RelaunchOptions`: `args?`, `pollIntervalMs?`.                                                                                                                                                    |
| `buildRelaunchCommand(options?)`      | Pure; returns the detached restart command for testing.                                                                                                                                                                                                               |

See [Auto-update](/guide/updates).

## Renderer types

| Export                     | Notes                                                                                                                                                   |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HTMLBuniumWebviewElement` | `src/webview-element.d.ts` — ambient global type (`src` property) + `HTMLElementTagNameMap` augmentation. See [&lt;bunium-webview&gt;](/guide/webview). |

## Not in the public API

`bsdiff`, `tar` (deterministic ustar), `native` and platform internals are
intentionally not re-exported — stable public surface only.
