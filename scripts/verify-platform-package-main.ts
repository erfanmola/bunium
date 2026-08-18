import { app, BuniumWindow } from "bunium";

// End-to-end smoke test for an INSTALLED bunium consumer: this app is run
// from dist-release/_consumer/, where node_modules/bunium is a materialized
// copy of the package and node_modules/bunium-darwin-arm64 points at the
// staged platform package (real shim + trimmed CEF). The dev tree is not
// reachable from here, so src/paths.ts must fall back to the platform
// package -- if it instead resolves nothing usable, dlopen fails and window
// creation crashes.
const win = new BuniumWindow({
  url: "data:text/html,<style>body{margin:0;background:rgb(0,255,0)}</style>",
  width: 320,
  height: 240,
  title: "platform package smoke",
});
await Bun.sleep(600);

const shot = win.captureScreenshot();
const idx =
  (Math.floor(shot.height / 2) * shot.width + Math.floor(shot.width / 2)) * 4;
const b = shot.data[idx]!;
const g = shot.data[idx + 1]!;
const r = shot.data[idx + 2]!;
console.log("center pixel BGR:", b, g, r);
const passed = r < 20 && g > 235 && b < 20;
console.log(passed ? "PLATFORM-PACKAGE-SMOKE PASS" : "PLATFORM-PACKAGE-SMOKE FAIL");
win.close();
app.shutdown();
process.exit(passed ? 0 : 1);
