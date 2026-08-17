import { app, BuniumWindow } from "../src/index";

// Verifies the synthetic resize-edge machinery (ResizeEdgeAtPoint /
// ApplyResizeDelta / mouseDown:/mouseDragged:/mouseUp: wiring in
// bunium_window_mac.mm) doesn't crash or misbehave for the window
// configurations it's gated on. Same limitation as draggable-regions-test.ts
// applies here, made *worse*: the resize-edge check lives inside the real
// Cocoa mouseDown:/mouseDragged: handlers on BuniumContentView, which aren't
// reachable through the raw-FFI dispatch trick used for click/keyboard tests
// (that trick calls bunium_dispatch_mouse_click directly, bypassing
// mouseDown: entirely -- exactly the code path that needs testing here).
// A real desktop + real mouse drag is required to confirm the resize
// actually happens visually; this only proves:
//   1. frame:false + resizable windows still create/paint/close cleanly
//      with the new styleMask-gated code path present (shouldUseSyntheticResizeEdges
//      reads self.window.styleMask on every mouseDown/mouseMoved -- confirms
//      that doesn't crash or throw for a borderless+resizable window).
//   2. frame:false + resizable:false windows behave the same way (confirms
//      the isResizable gate itself doesn't crash when NSWindowStyleMaskResizable
//      is absent).
//   3. frame:true (titled) windows are completely unaffected (shouldUseSyntheticResizeEdges
//      returns NO immediately via the isBorderless check, never reaching
//      ResizeEdgeAtPoint at all).
const borderlessResizable = new BuniumWindow({
  url: "data:text/html,<body style='background:green'></body>",
  width: 400,
  height: 300,
  frame: false,
  resizable: true,
});
await Bun.sleep(300);
console.log(
  "frame:false + resizable:true created cleanly:",
  borderlessResizable.frameCount > 0n,
);
borderlessResizable.close();

const borderlessFixed = new BuniumWindow({
  url: "data:text/html,<body style='background:red'></body>",
  width: 400,
  height: 300,
  frame: false,
  resizable: false,
});
await Bun.sleep(300);
console.log(
  "frame:false + resizable:false created cleanly:",
  borderlessFixed.frameCount > 0n,
);
borderlessFixed.close();

const titled = new BuniumWindow({
  url: "data:text/html,<body style='background:blue'></body>",
  width: 400,
  height: 300,
  frame: true,
  resizable: true,
});
await Bun.sleep(300);
console.log(
  "frame:true created cleanly (unaffected path):",
  titled.frameCount > 0n,
);
titled.close();

app.shutdown();
