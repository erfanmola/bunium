import { app, BuniumWindow } from "../src/index";

// Verifies frame:false doesn't crash and the view still paints correctly.
// Whether the title bar is actually visually absent needs a real desktop
// to confirm (same category as other Cocoa-visual gaps this session) --
// this only proves the styleMask change didn't break window/view creation.
const win = new BuniumWindow({
  url: "data:text/html,<body style='background:blue'></body>",
  width: 300,
  height: 200,
  frame: false,
});

await Bun.sleep(500);
console.log("frameCount:", win.frameCount);
console.log("no crash with frame:false:", win.frameCount > 0n);

win.close();
app.shutdown();
