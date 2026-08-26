// Verifies bunium_system_tray_set_icon (SNI IconPixmap) end-to-end: an
// arbitrary image file decoded via GdkPixbuf actually round-trips through
// the real D-Bus StatusNotifierItem service as the byte-exact a(iiay)
// IconPixmap the freedesktop.org spec defines (big-endian ARGB32,
// row-major), not just "didn't crash". Same real-D-Bus-round-trip pattern
// as native/linux/test-tray-click.ts, but for setIcon() instead of
// onClick() -- no fake watcher/daemon needed since IconPixmap is read via
// a plain Properties.Get on bunium's own registered SNI object, which
// works with or without a real StatusNotifierWatcher present.
//
// Run against any session bus (headless Xvfb + `dbus-launch` is enough --
// unlike test-tray-click.ts this doesn't need a real desktop panel, since
// it reads the property directly rather than needing a watcher to route a
// click):
//   Xvfb :99 -screen 0 1024x768x24 & DISPLAY=:99 \
//     eval $(dbus-launch --sh-syntax) && bun native/linux/test-tray-set-icon.ts
import { app, Tray } from "../../src/index";

app.init();

// A tiny deterministic 2x3 test PNG: distinct, easy-to-check-by-hand RGBA
// corners (opaque red top-left, opaque green top-right, semi-transparent
// blue bottom-left, opaque white bottom-right, black middle row) --
// generated on the fly so this fixture has no binary fixture file to keep
// in sync. Requires ImageMagick's `convert`/`magick` (already a dev-host
// dependency per docker/linux/Dockerfile's `imagemagick` package).
const pngPath = `/tmp/bunium-tray-icon-test-${process.pid}.png`;
const gen = Bun.spawnSync([
  "convert",
  "-size",
  "2x3",
  "xc:none",
  "-fill",
  "red",
  "-draw",
  "point 0,0",
  "-fill",
  "lime",
  "-draw",
  "point 1,0",
  "-fill",
  "black",
  "-draw",
  "point 0,1",
  "-draw",
  "point 1,1",
  "-fill",
  "white",
  "-draw",
  "point 0,2",
  "-fill",
  "blue",
  "-draw",
  "point 1,2",
  pngPath,
]);
if (gen.exitCode !== 0) {
  console.log("convert stderr:", gen.stderr.toString());
  throw new Error("failed to generate test PNG (needs ImageMagick `convert`)");
}

const tray = new Tray("");
tray.setIcon(pngPath, false);

// Let the tray register + the icon decode land.
await new Promise((r) => setTimeout(r, 500));

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
const itemId = busName.match(/-(\d+)$/)![1]!;
const objPath = `/StatusNotifierItem/${itemId}`;
console.log("[test] found real registered SNI bus name:", busName);

const getIcon = Bun.spawnSync([
  "gdbus",
  "call",
  "--session",
  "--dest",
  busName,
  "--object-path",
  objPath,
  "--method",
  "org.freedesktop.DBus.Properties.Get",
  "org.kde.StatusNotifierItem",
  "IconPixmap",
]);
const out = getIcon.stdout.toString();
if (getIcon.exitCode !== 0) {
  console.log("gdbus stderr:", getIcon.stderr.toString());
  throw new Error("Properties.Get IconPixmap failed");
}
console.log("[test] raw IconPixmap reply:", out.trim());

// gdbus prints tuples like: (<[(2, 3, [byte 0xff, ...])]>,)
// Pull out width, height, and the byte list to check shape + a handful of
// exact pixel values -- this is the real byte-for-byte contract a
// StatusNotifierHost (a real panel) parses, so checking actual values
// (not just "some bytes came back") is the meaningful assertion here.
const wh = out.match(/\((\d+), (\d+), \[byte/);
if (!wh) throw new Error(`could not parse width/height from: ${out}`);
const w = Number(wh[1]);
const h = Number(wh[2]);
console.log(`[test] parsed dimensions: ${w}x${h}`);
if (w !== 2 || h !== 3) {
  throw new Error(`expected 2x3, got ${w}x${h}`);
}

const byteMatches = [...out.matchAll(/0x([0-9a-f]{2})/g)].map((m) =>
  Number.parseInt(m[1]!, 16),
);
if (byteMatches.length !== w * h * 4) {
  throw new Error(
    `expected ${w * h * 4} ARGB bytes, got ${byteMatches.length}`,
  );
}
// Pixel (0,0): opaque red -> A=0xff R=0xff G=0x00 B=0x00 (big-endian ARGB).
const p00 = byteMatches.slice(0, 4);
console.log("[test] pixel(0,0) ARGB:", p00);
const redOk = p00[0]! > 200 && p00[1]! > 200 && p00[2]! < 30 && p00[3]! < 30;
// Pixel (1,0): opaque green -> A=0xff R=0x00 G=0xff B=0x00.
const p10 = byteMatches.slice(4, 8);
console.log("[test] pixel(1,0) ARGB:", p10);
const greenOk = p10[0]! > 200 && p10[1]! < 30 && p10[2]! > 200 && p10[3]! < 30;

const passed = redOk && greenOk;
console.log(passed ? "TRAY-SET-ICON PASS" : "TRAY-SET-ICON FAIL");

tray.destroy();
app.shutdown();
try {
  require("node:fs").unlinkSync(pngPath);
} catch {}
process.exit(passed ? 0 : 1);
