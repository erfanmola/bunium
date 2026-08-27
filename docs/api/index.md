# API reference

All exports are typed, strict-mode TS. Everything below is the full public
surface of the `bunium` package.

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
| `Menu`                                                 | Native menu bar builder. `new Menu(items)`, `onClick(id)`, `setAsApplicationMenu()`.                                                                                                                                                           |
| `MenuItemSpec`                                         | Flat item union: `{type: "separator"}` \| `{label, id?, submenu?}`.                                                                                                                                                                            |
| `Tray`                                                 | Native tray icon. `setMenu`, `onClick`, `setIcon(path, {template})`, `setSymbol(name)`.                                                                                                                                                        |
| `Notification`                                         | `new Notification({title, body?, id?})`, `show()`, `onClick()`.                                                                                                                                                                                |
| `showOpenDialog` / `showSaveDialog` / `showMessageBox` | Promise-based; never block the UI. Result types: `OpenDialogResult` (`canceled`, `paths`), `SaveDialogResult` (`canceled`, `path`), `MessageBoxResult` (`response`). Options: `OpenDialogOptions`, `SaveDialogOptions`, `MessageBoxOptions`. |
| `systemEvents`                                         | Shared event bus for system-feature callbacks.                                                                                                                                                                                                |

See [System features](/guide/system).

## Updates

| Export                                | Notes                                                                                                                                                                                                                                                                 |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `updater`                             | `Updater` singleton: `check()`, `install()`, `relaunch()`, `repairInterruptedUpdate()`, `isUpToDate`, typed `on()`.                                                                                                                                                   |
| `updater.check` inputs                | `UpdateCheckOptions`: `feedUrl`, `currentVersion`, `channel?`, `platform?`, `arch?`. Result: `UpdateCheckResult`; manifest type `UpdateManifest`. `Platform` = `"mac" \| "linux" \| "win"`; `Arch` = `"arm64" \| "x64"`; `defaultPlatform()`/`defaultArch()` helpers. |
| `UpdaterEvent(s)` / `UpdaterEvents`   | Discriminated-union event payloads: `checking`, `downloadStarted`, `progress` (`phase: "download"\|"apply"`), `applying` (`method: "patch"\|"full"`), `ready`, `relaunching`, `error` (`recoverable` flag).                                                           |
| `repairInterruptedUpdate(installDir)` | Recovers from an interrupted update; returns `UpdateRepairResult` (`"repaired"\|"rolled-back"\|"none"`).                                                                                                                                                              |
| `relaunchApp(options?)`               | Restart the app after an update. `RelaunchOptions`: `args?`, `pollIntervalMs?`.                                                                                                                                                                                       |
| `buildRelaunchCommand(options?)`      | Pure; returns the detached restart command for testing.                                                                                                                                                                                                               |

See [Auto-update](/guide/updates).

## Renderer types

| Export                     | Notes                                                                                                                                                   |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HTMLBuniumWebviewElement` | Ambient global type (`src` property) + `HTMLElementTagNameMap` augmentation. See [&lt;bunium-webview&gt;](/guide/webview). |
