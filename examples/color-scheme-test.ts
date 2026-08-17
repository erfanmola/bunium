import { app, BuniumWindow } from "../src/index";

// System is currently in Dark mode (`defaults read -g AppleInterfaceStyle`).
// If prefers-color-scheme resolves to dark without any bunium-side work,
// the page background will be black; if CEF defaults to light regardless
// of the OS, it'll be white.
const html = `data:text/html,${encodeURIComponent(`
<style>
  body { margin: 0; background: white; }
  @media (prefers-color-scheme: dark) { body { background: black; } }
</style>
`)}`;

const win = new BuniumWindow({
  url: html,
  width: 300,
  height: 200,
  title: "color scheme test",
});
await Bun.sleep(500);

const shot = win.captureScreenshot();
const idx =
  (Math.floor(shot.height / 2) * shot.width + Math.floor(shot.width / 2)) * 4;
const b = shot.data[idx]!;
const g = shot.data[idx + 1]!;
const r = shot.data[idx + 2]!;
console.log("center pixel BGR:", b, g, r);
console.log(
  "resolved as:",
  r < 20 && g < 20 && b < 20
    ? "DARK"
    : r > 235 && g > 235 && b > 235
      ? "LIGHT"
      : "unknown",
);
console.log("OS is currently in Dark mode -- does this match?");

win.close();
app.shutdown();
