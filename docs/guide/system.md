# System features

Native menu bar, tray icon, notifications, and dialogs — each a small typed class.

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
`{ label, id?, submenu? }` — nested `submenu` arrays build a submenu hierarchy;
numeric `id`s map clicks back to your code.

`setAsApplicationMenu()` is a single app-wide menu bar on macOS and Windows. On
Linux there's no cross-desktop "global app menu" convention, so it's a no-op —
use `tray.setMenu()` instead for a real menu there.

## Tray

```ts
const tray = new Tray({ title: "Bunium" });
tray.setMenu(menu);   // context menu; supersedes onClick
tray.onClick((id) => {}); // menu-less click
tray.setIcon("/abs/path/icon.png", { template: true }); // file-based
tray.setSymbol("waveform.path.ecg"); // named-icon shorthand
```

`setIcon` (arbitrary image file) works on macOS and Windows; `setSymbol` (named
icon) works on macOS and Linux. Use whichever fits your platform target, or both
and let the no-op fall through. Text-only title is a deliberate v1 simplification.

## Notifications

```ts
const notif = new Notification({ title: "Done", body: "Build finished", id: 7 });
notif.show();
notif.onClick(() => {});
```

Native notification banners on all three platforms. Clicks arrive via `onClick`.

## Dialogs

All three are promise-based and never block the UI:

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

## A note on testing

Tray clicks, notification banners, and dialog panels need a real desktop
session to see rendered — they're covered by automated tests, but worth a
manual click-through before shipping.

Related: [Getting started](/guide/getting-started), [Window](/guide/window).
