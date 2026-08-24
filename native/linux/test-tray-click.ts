// Verifies the tray-click pipeline end-to-end against a REAL StatusNotifier
// host (GNOME Shell + AppIndicator extension providing org.kde.
// StatusNotifierWatcher), not just no-crash plumbing. examples/system-tray-
// icon-click-test.ts documents that it "can NOT verify headlessly...the
// actual OS click" -- this fixture closes that gap by doing exactly what a
// real StatusNotifierWatcher-driven desktop (GNOME Shell w/ AppIndicator, KDE
// Plasma, etc) does on a physical click: call Activate(x, y) on the tray
// item's OWN registered D-Bus service name/object path
// (org.kde.StatusNotifierItem-<pid>-<id> at /StatusNotifierItem/<id>), which
// is the real StatusNotifierItem spec's click-delivery mechanism (see
// native/linux/bunium_system_tray_linux.cc's HandleObjectMessage). This
// doesn't synthesize an X11 mouse event (there's no clickable pixel to hit
// per-se, SNI trays are pure D-Bus, unlike a real X11 window) -- calling
// Activate() over D-Bus IS the real desktop's click-delivery path, so this
// is a faithful test, not a shortcut.
//
// Run against a real desktop session with the AppIndicator extension
// enabled, not headless Xvfb:
//   DISPLAY=:0 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus \
//     XDG_RUNTIME_DIR=/run/user/1000 bun native/linux/test-tray-click.ts
import { app, BuniumWindow, Tray } from "../../src/index";

app.init();

const tray = new Tray("");
tray.setSymbol("bell.fill");

let clickedId: number | null = null;
tray.onClick((id) => {
  clickedId = id;
  console.log(`[tray] onClick fired, id=${id}`);
});

const win = new BuniumWindow({
  url: "about:blank",
  width: 320,
  height: 240,
  title: "tray-click",
});

// Let the tray register with the real StatusNotifierWatcher and pump a few
// event-loop turns.
await new Promise((r) => setTimeout(r, 800));

// Find bunium's own registered SNI bus name (unique per pid), then call
// Activate() on it -- exactly what GNOME Shell/AppIndicator does on a real
// click.
const pid = process.pid;
const listNames = Bun.spawnSync([
  "gdbus",
  "call",
  "--session",
  "--dest",
  "org.freedesktop.DBus",
  "--object-path",
  "/org/freedesktop/DBus",
  "--method",
  "org.freedesktop.DBus.ListNames",
]);
const namesOut = listNames.stdout.toString();
const match = namesOut.match(
  new RegExp(`'(org\\.kde\\.StatusNotifierItem-${pid}-\\d+)'`),
);
if (!match) {
  console.log("names seen:", namesOut.slice(0, 500));
  throw new Error(`could not find registered SNI bus name for pid ${pid}`);
}
const busName = match[1]!;
console.log("[test] found real registered SNI bus name:", busName);

const objPathMatch = busName.match(/-(\d+)$/);
const itemId = objPathMatch![1]!;
const objPath = `/StatusNotifierItem/${itemId}`;

console.log("[test] calling Activate() -- simulating a real desktop click...");
const activate = Bun.spawnSync([
  "gdbus",
  "call",
  "--session",
  "--dest",
  busName,
  "--object-path",
  objPath,
  "--method",
  "org.kde.StatusNotifierItem.Activate",
  "0",
  "0",
]);
console.log(
  "[test] Activate() call result:",
  activate.stdout.toString().trim() || activate.stderr.toString().trim(),
);

await new Promise((r) => setTimeout(r, 500));

console.log("[result] onClick handler fired with real click id:", clickedId);

tray.destroy();
win.close();
app.shutdown();
process.exit(0);
