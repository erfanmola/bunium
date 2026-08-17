// Phase 5 smoke test: native dialogs (open/save panels, message box).
//
// Verifies the new dialog ABI surface links and executes without crashing:
// kicking off an open panel, a save panel, and a message box, pumping long
// enough for any results to drain, then tearing down cleanly. Because the
// native side is completion-handler driven, none of these calls block the
// pump.
//
// What this can NOT verify headlessly: actual user interaction (selecting a
// file / clicking an alert button runs through real Cocoa panel/alert
// behavior on a live desktop -- the same interactive gap as menu clicks).
// Note: running this on a real desktop will briefly pop real panels and an
// alert sheet on screen; they resolve with a cancel once the window closes
// and the app shuts down.
import {
  app,
  BuniumWindow,
  showMessageBox,
  showOpenDialog,
  showSaveDialog,
} from "../src/index";

app.init();

const win = new BuniumWindow({
  url: "about:blank",
  width: 320,
  height: 240,
  title: "dialogs",
});

void showOpenDialog({
  title: "Pick something",
  allowMultiple: true,
  canChooseDirectories: true,
  okLabel: "Pick",
}).then((r) => console.log("[open] result:", JSON.stringify(r)));

void showSaveDialog({
  title: "Where to?",
  defaultName: "untitled.txt",
  okLabel: "Save",
}).then((r) => console.log("[save] result:", JSON.stringify(r)));

void showMessageBox({
  message: "Hello from bunium",
  detail: "The message box attaches as a sheet on the app window.",
  okLabel: "OK",
  cancelLabel: "Cancel",
}).then((r) => console.log("[message] result:", JSON.stringify(r)));

await new Promise((r) => setTimeout(r, 1500));
console.log("[window] frames:", win.frameCount);

win.close();
app.shutdown();
console.log("OK: dialogs invoked and torn down cleanly");
process.exit(0);
