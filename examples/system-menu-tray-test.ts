// Phase 5 smoke test: native menu bar (NSMenu) + system tray (NSStatusItem).
//
// Verifies the new system ABI surface links and executes without crashing:
// building a nested Menu, attaching it as the application menu bar, creating
// a Tray with a status menu, pumping the event loop long enough to flush the
// new bunium_poll_system_event drain, then tearing down cleanly.
//
// What this can NOT verify headlessly: an actual OS click on a menu item or
// tray (menu-item selection runs through real Cocoa target/action delivery on
// a live desktop -- same category as the other Cocoa-interactive gaps in the
// plan). The click -> bunium-menu-click event pipeline is exercised only to
// the extent that the native action handler exists and the inbox drains.
import { app, BuniumWindow, Menu, Tray } from "../src/index";

app.init();

const menu = new Menu([
  {
    label: "File",
    submenu: [
      { label: "New Window", id: 1 },
      { type: "separator" },
      { label: "Close", id: 2 },
    ],
  },
  {
    label: "Edit",
    submenu: [
      { label: "Copy", id: 10 },
      { label: "Paste", id: 11 },
    ],
  },
  { type: "separator" },
  { label: "About", id: 99 },
]);
menu.setApplicationMenu();
menu.onItemClicked((id) => console.log(`[menu] clicked id=${id}`));

const tray = new Tray("bun");
tray.setMenu(menu);
tray.setTitle("bunium");
console.log("[tray] created + menu attached");

// One real CEF window so init/pump exercises the full CEF+Cocoa path, not
// just the AppKit slice -- matches every other example's shape.
const win = new BuniumWindow({
  url: "about:blank",
  width: 320,
  height: 240,
  title: "system",
});
await new Promise((r) => setTimeout(r, 800));
console.log("[window] frames:", win.frameCount);

tray.destroy();
win.close();
app.shutdown();
console.log("OK: system menu/tray created and torn down cleanly");
process.exit(0);
