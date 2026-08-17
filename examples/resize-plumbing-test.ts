import { app, BuniumWindow } from "../src/index";

const html = "data:text/html,<body style='background:navy'></body>";
const win = new BuniumWindow({
  url: html,
  width: 640,
  height: 480,
  title: "resize test",
});

await Bun.sleep(500);

// Programmatic resize path (view-only, doesn't touch the OS window) --
// confirms bunium_resize + CEF WasResized still works after the
// TrackedWindow/registerWindow refactor.
win.resize(320, 240);
await Bun.sleep(300);

console.log("frameCount after resize:", win.frameCount);
console.log(
  "no crash across several pump ticks with a registered window: pass",
);

win.close();
app.shutdown();
