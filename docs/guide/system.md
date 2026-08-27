# System features

`src/system/` package: native OS features each wrapped as a thin
typed class over a flat C ABI — no single "system" god object; each slice
(menu, tray, notification, dialog) is independent, and they share one
`SystemEventBus` drained by the app pump.

```ts
import { Menu, Tray, Notification, showMessageBox, systemEvents } from "bunium";
```

## Menu bar

```ts
const menu = new Menu([
  { label: "File" },
  { label: "Edit", submenu: [
    { label: "Copy", id: 42 },
    { type: "separator" },
    { label: "Paste", id: 43 },
  ]},
]);

menu.onClick((itemId) => {
  // fired for any item with an id
});

menu.setAsApplicationMenu(); // replaces the app menu bar
```

`MenuItemSpec` is a flat union: `{ type: "separator" }` or
`{ label, id?, submenu? }` — nested `submenu` arrays build a native submenu
hierarchy; numeric `id`s map clicks back to your code.

`setAsApplicationMenu()` behavior differs per platform: on **macOS** it's a single
app-wide menu bar (`NSApp.mainMenu`); on **Windows** it's attached per-window
(`SetMenu`, one `HMENU` per framed window); on **Linux** there's no cross-desktop
"global app menu" convention, so it's an honest no-op — use `tray.setMenu()`
instead for a real menu (rendered via the tray icon's own dbusmenu).

## Tray

```ts
const tray = new Tray({ title: "Bunium" });
tray.setMenu(menu);   // context menu; supersedes onClick
tray.onClick((id) => {}); // menu-less click
tray.setIcon("/abs/path/icon.png", { template: true }); // file-based
tray.setSymbol("waveform.path.ecg"); // named-icon shorthand
```

`setIcon`/`setSymbol` support differs per platform: **macOS** supports both
(`setIcon` is file-based with template-image dark/light auto-adapt; `setSymbol`
takes an SF Symbol name); **Windows** supports `setIcon` (any image file, alpha
preserved via GDI+) but `setSymbol` is a no-op; **Linux** is the reverse —
`setSymbol` takes a freedesktop icon-theme name and works, `setIcon` is currently
a no-op. Text-only title is a deliberate v1 simplification.

## Notifications

```ts
const notif = new Notification({ title: "Done", body: "Build finished", id: 7 });
notif.show();
notif.onClick(() => {});
```

Backend is native per platform: **macOS** uses `UNUserNotificationCenter` for
bundled/packaged apps and falls back to the deprecated `NSUserNotification` for
unbundled dev binaries (referencing UN from an unbundled process throws
`NSInternalInconsistencyException`); **Linux** talks to the
`org.freedesktop.Notifications` D-Bus service directly; **Windows** uses a hidden
tray-icon balloon (`Shell_NotifyIcon`) rather than the modern toast API. Clicks
from any path arrive as `bunium-notification-click {id}` events.

## Dialogs

All three are promise-based and completion-handler driven — they never block the
JS pump:

```ts
const open = await showOpenDialog({ title: "Open", allowMultiple: true });
if (open.canceled) return;
console.log(open.paths);

const save = await showSaveDialog({ title: "Save as", defaultPath: "out.txt" });

const msg = await showMessageBox({
  title: "Quit?",
  message: "Really quit?",
  buttons: ["Cancel", "Quit"],
});
if (msg.response === 1) app.shutdown();
```

Results arrive as `bunium-dialog-result {requestId, result}` events (paths
JSON-encoded via `CefWriteJSON`, so quotes/backslashes in paths are safe).

## Events bus

`systemEvents` (`SystemEventBus` singleton) is drained every pump tick by
`app.ts`. Events are typed envelopes; `Menu`, `Tray`, `Notification`, and the
dialog promises wire into it internally — app code only sees the typed classes
above.

## Verification notes

Interactive outcomes (tray clicks, notification banners, dialog panels) need a
real desktop session. Headless smoke tests verify plumbing: wiring, no crashes,
clean teardown (`examples/system-menu-tray-test.ts`, `system-tray-icon-click-test.ts`,
`system-notifications-test.ts`, `system-dialogs-test.ts`).

Related: [Getting started](/guide/getting-started), [Window](/guide/window).
