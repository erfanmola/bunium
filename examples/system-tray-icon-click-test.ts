// Phase 5 smoke test: tray icon (SF Symbol) + opt-in click delivery for a
// menu-less tray.
//
// Verifies the new tray ABI surface links and executes without crashing:
// creating an icon-only tray, switching it to an SF Symbol glyph, attaching
// an onClick handler (which wires the native button target/action), pumping
// the event loop, then tearing down cleanly.
//
// What this can NOT verify headlessly: the actual OS click on the tray item
// (button target/action fires through real AppKit event delivery on a live
// desktop -- the same interactive gap as menu-item clicks). The icon itself
// is set natively but rendering is only observable on a real menu bar.
import { app, BuniumWindow, Tray } from "../src/index";

app.init();

const tray = new Tray(""); // icon-only tray: no title
tray.setSymbol("bell.fill");
tray.onClick((id) => console.log(`[tray] clicked id=${id}`));
console.log("[tray] icon set + click handler attached");

const win = new BuniumWindow({
  url: "about:blank",
  width: 320,
  height: 240,
  title: "tray-icon",
});
await new Promise((r) => setTimeout(r, 800));
console.log("[window] frames:", win.frameCount);

tray.destroy();
win.close();
app.shutdown();
console.log("OK: tray icon + click plumbing created and torn down cleanly");
process.exit(0);
