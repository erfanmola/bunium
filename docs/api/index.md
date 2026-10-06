# API reference

All exports are typed, strict-mode TS. Everything below is the full public
surface of the `bunium` package.

## Main process singleton

| Export                | Notes                                                                                                                                  |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `app`                 | `BuniumApp` singleton. `init()` (implicit via first window), `setAppRoot(dir)`, `shutdown()`. One per process — CEF's singleton model. |
| `BuniumWindow`        | `new BuniumWindow<M>(options)`. See [Window](/guide/window).                                                                           |
| `BuniumWindow.createOverlay(options)` | Creates a trusted transparent CEF surface above native guests; macOS-only pending Windows/Linux qualification. |
| `BuniumWindowOptions` | Constructor options type.                                                                                                              |
| `WindowControlCapabilities` / `WindowControl` | Per-window minimize/maximize/restore/focus/show/hide/always-on-top support and operation names. |
| `WindowControlError` | Thrown for unsupported operations, native failures, or controls used after close; inspect `code` for the reason. |
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
| `updater.check` inputs                | `UpdateCheckOptions`: expected `product`, `feedUrl`, `currentVersion`, exact `runtimeVersion`/`cefVersion`, current three-part `currentOsVersion`, persisted `currentSequence`, `trustedKeys`, `channel?`, `platform?`, `arch?`. Result: `UpdateCheckResult`; schema-2 signed manifest binds product, updater ABI, runtime/CEF compatibility, minimum Bun/OS versions, app-tree payload kind, sequence, timestamps, platform/channel and artifact sizes/hashes. `Platform` = `"mac" \| "linux" \| "win"`; `Arch` = `"arm64" \| "x64"`; `defaultPlatform()`/`defaultArch()` helpers. |
| `updateAbiVersion`                    | Manifest/apply compatibility version; increment for incompatible updater changes.                                                                                                                                                                                       |
| `UpdaterEvent(s)` / `UpdaterEvents`   | Discriminated-union event payloads: `checking`, `downloadStarted`, `progress` (`phase: "download"\|"apply"`), `applying` (`method: "patch"\|"full"`), `ready`, `relaunching`, `error` (`recoverable` flag).                                                           |
| `repairInterruptedUpdate(installDir)` | Recovers from an interrupted update; returns `UpdateRepairResult` (`"repaired"\|"rolled-back"\|"none"`).                                                                                                                                                              |
| `relaunchApp(options?)`               | Restart the app after an update. `RelaunchOptions`: `args?`, `pollIntervalMs?`.                                                                                                                                                                                       |
| `buildRelaunchCommand(options?)`      | Pure; returns the detached restart command for testing.                                                                                                                                                                                                               |

See [Auto-update](/guide/updates).

## Guest views

| Export | Notes |
| --- | --- |
| `BuniumGuest` | Native untrusted guest view composited into a `BuniumWindow`. Supports a bounded document-start bridge, instance-scoped messages, navigation generations, lifecycle events, rectangular or rounded clipping on macOS, and disposal. The flattened primary host DOM still paints below guests. |
| `BuniumGuestOptions`, `GuestBounds`, `GuestEvent`, `GuestMessage` | Guest creation options, geometry, lifecycle events and generation-tagged messages. |
| `BuniumOverlay` | Trusted transparent CEF surface with independent IPC, bounds, rectangular clipping and origin-restricted navigation. Transparent pixels inside its hit-test rectangle still receive input. |
| `BuniumOverlayOptions`, `OverlayBounds` | Overlay URL and window-local logical-pixel geometry. |
| `DeviceEmulationDescriptor` | Supported guest screen dimensions and device scale factor; viewport comes from guest bounds. |
| `deviceEmulationCapabilities`, `validateDeviceEmulation` | Capability declaration and bounded screen, raster, touch and pointer descriptor validation. |
| `guestApiVersion` | Runtime capability version for consumers that require native guest views. |

See [Guest views](/guide/guest) and [Device emulation](/guide/device-emulation).

## Renderer types

| Export                     | Notes                                                                                                                                                   |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HTMLBuniumWebviewElement` | Ambient global type (`src` property) + `HTMLElementTagNameMap` augmentation. See [&lt;bunium-webview&gt;](/guide/webview). |
