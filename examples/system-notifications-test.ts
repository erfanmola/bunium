// Phase 5 smoke test: OS notifications (UNUserNotificationCenter).
//
// Verifies the new notify ABI surface links and executes without crashing:
// building a Notification, registering a click handler, showing it, pumping
// the event loop (proving the notification's own code path + the shared
// system event drain stay healthy), then tearing down cleanly.
//
// What this can NOT verify headlessly: actual banner delivery and a real click
// on it. Delivery requires a bundled, authorized app (an unbundled dev
// binary can silently drop banners -- see the caveat in
// src/system/notifications.ts), and clicking runs through real
// UNUserNotificationCenter delegate delivery on a live desktop. Same
// interactive-gap category as menu/tray clicks.
import { app, BuniumWindow, Notification } from "../src/index";

app.init();

const notif = new Notification({
  title: "bunium",
  body: "hello from the main process",
});
notif.onClick(() => console.log("[notify] clicked"));
notif.show();
console.log("[notify] posted");

const win = new BuniumWindow({
  url: "about:blank",
  width: 320,
  height: 240,
  title: "notify",
});
await new Promise((r) => setTimeout(r, 800));
console.log("[window] frames:", win.frameCount);

win.close();
app.shutdown();
console.log("OK: notification posted and torn down cleanly");
process.exit(0);
