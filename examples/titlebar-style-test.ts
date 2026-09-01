// Verifies titleBarStyle/trafficLightPosition don't crash and produce a
// painted window on macOS -- there's no readback API for native button
// frames, so this checks the observable JS-side contract (paints, closes
// cleanly) rather than pixel-testing traffic-light position directly.
import { app, BuniumWindow } from "../src/index";

const html = `data:text/html,${encodeURIComponent(`
<body style="margin:0;background:#2b2b2b;color:white;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh">
<h1>hiddenInset + custom traffic-light position</h1>
</body>
`)}`;

const win = new BuniumWindow({
  url: html,
  width: 600,
  height: 400,
  title: "titlebar-style-test",
  titleBarStyle: "hiddenInset",
  trafficLightPosition: { x: 16, y: 16 },
});

await Bun.sleep(3000);

if (win.frameCount < 1n) {
  console.error("FAIL: no frames painted");
  process.exit(1);
}
console.log("PASS: hiddenInset window painted, frameCount =", win.frameCount);
win.close();

// Second window: titleBarStyle "hidden" without an explicit position (falls
// back to the normal traffic-light spot, no crash expected).
const win2 = new BuniumWindow({
  url: html,
  width: 600,
  height: 400,
  title: "titlebar-style-test-2",
  titleBarStyle: "hidden",
});
await Bun.sleep(2000);
if (win2.frameCount < 1n) {
  console.error("FAIL: window 2 no frames painted");
  process.exit(1);
}
console.log("PASS: hidden window painted, frameCount =", win2.frameCount);
win2.close();

app.shutdown();
