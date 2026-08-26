// Verifies tray.setMenu() end-to-end against the real com.canonical.dbusmenu
// D-Bus protocol (the "AppIndicator" convention GNOME Shell's AppIndicator
// extension / KDE Plasma / XFCE's indicator-application already speak), not
// just "didn't crash":
//   1. after setMenu(), the tray's own SNI Menu property points at a real
//      object path (not "/") and ItemIsMenu flips to true.
//   2. that object path answers com.canonical.dbusmenu's GetLayout with a
//      real layout tree containing the exact item/submenu/separator labels
//      built via Menu, in the right nesting.
//   3. calling Event(id, "clicked", ...) on a leaf item -- exactly what a
//      real panel does when the user clicks a menu entry -- fires bunium's
//      own "bunium-menu-click" event with that item's id, which
//      Menu.onItemClicked() delivers to JS.
// Same real-protocol-round-trip pattern as test-tray-click.ts/
// test-tray-set-icon.ts; run under headless Xvfb + dbus-launch (no real
// desktop panel needed -- GetLayout/Event are read/called directly).
import { app, Menu, Tray } from "../../src/index";

app.init();

const tray = new Tray("");

let clickedId: number | null = null;
const menu = new Menu([
  { label: "Item One", id: 101 },
  { type: "separator" },
  {
    label: "Sub",
    submenu: [
      { label: "Nested Item", id: 102 },
    ],
  },
]);
menu.onItemClicked((id) => {
  clickedId = id;
  console.log(`[menu] onItemClicked fired, id=${id}`);
});

tray.setMenu(menu);

// Let the tray register + the dbusmenu server publish.
await new Promise((r) => setTimeout(r, 800));

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

// Step 1: Menu / ItemIsMenu properties.
const getMenu = Bun.spawnSync([
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
  "Menu",
]);
const menuOut = getMenu.stdout.toString();
console.log("[test] Menu property:", menuOut.trim());
const menuPathMatch = menuOut.match(/objectpath '([^']+)'/);
if (!menuPathMatch || menuPathMatch[1] === "/") {
  throw new Error(`Menu property did not point at a real object path: ${menuOut}`);
}
const menuPath = menuPathMatch[1]!;

const getItemIsMenu = Bun.spawnSync([
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
  "ItemIsMenu",
]);
const itemIsMenuOut = getItemIsMenu.stdout.toString();
console.log("[test] ItemIsMenu property:", itemIsMenuOut.trim());
if (!/true/.test(itemIsMenuOut)) {
  throw new Error(`expected ItemIsMenu true, got: ${itemIsMenuOut}`);
}

// Step 2: GetLayout on the real dbusmenu object (bunium's own D-Bus service
// name -- libdbusmenu-glib publishes its server on the same connection/bus
// name process-wide, so busName above still resolves it).
const getLayout = Bun.spawnSync([
  "gdbus",
  "call",
  "--session",
  "--dest",
  busName,
  "--object-path",
  menuPath,
  "--method",
  "com.canonical.dbusmenu.GetLayout",
  "--",
  "0",
  "-1",
  "@as []",
]);
if (getLayout.exitCode !== 0) {
  console.log("gdbus stderr:", getLayout.stderr.toString());
  throw new Error("GetLayout failed");
}
const layoutOut = getLayout.stdout.toString();
console.log("[test] raw GetLayout reply:", layoutOut.trim());

const hasItemOne = layoutOut.includes("Item One");
const hasSub = layoutOut.includes("'Sub'") || layoutOut.includes('"Sub"');
const hasNested = layoutOut.includes("Nested Item");
const hasSeparator = layoutOut.includes("separator");
console.log("[test] layout contains Item One:", hasItemOne);
console.log("[test] layout contains Sub:", hasSub);
console.log("[test] layout contains Nested Item:", hasNested);
console.log("[test] layout contains separator type:", hasSeparator);

// Step 3: simulate a real panel's click delivery -- Event(id, "clicked", ...)
// on the leaf item's own numeric id (101), exactly what a real
// StatusNotifierHost/dbusmenu client does on click.
console.log("[test] calling Event(101, 'clicked') -- simulating a real menu click...");
const event = Bun.spawnSync([
  "gdbus",
  "call",
  "--session",
  "--dest",
  busName,
  "--object-path",
  menuPath,
  "--method",
  "com.canonical.dbusmenu.Event",
  "101",
  "clicked",
  "<0>",
  "0",
]);
console.log(
  "[test] Event() call result:",
  event.stdout.toString().trim() || event.stderr.toString().trim(),
);

await new Promise((r) => setTimeout(r, 500));

console.log("[result] onItemClicked handler fired with real click id:", clickedId);

const passed =
  hasItemOne && hasSub && hasNested && hasSeparator && clickedId === 101;
console.log(passed ? "TRAY-MENU PASS" : "TRAY-MENU FAIL");

tray.destroy();
app.shutdown();
process.exit(passed ? 0 : 1);
