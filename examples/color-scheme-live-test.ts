import { app, BuniumWindow } from "../src/index";

// Proves prefers-color-scheme updates live in an already-open window when
// the OS appearance is toggled mid-session, without any bunium-side code --
// Chromium's NativeTheme syncs with the real NSApplication we run
// automatically. Self-contained: forces light -> dark deterministically and
// restores whatever the OS was set to beforehand, regardless of starting
// state (toggling system-wide dark mode is reversible but visible, so this
// puts it back).
const wasDark =
  (await Bun.$`defaults read -g AppleInterfaceStyle`.quiet().nothrow())
    .exitCode === 0;

async function setDarkMode(dark: boolean) {
  await Bun.$`osascript -e ${`tell application "System Events" to tell appearance preferences to set dark mode to ${dark}`}`.quiet();
}

const html = `data:text/html,${encodeURIComponent(`
<style>
  body { margin: 0; background: white; }
  @media (prefers-color-scheme: dark) { body { background: black; } }
</style>
`)}`;

await setDarkMode(false);
await Bun.sleep(300);

const win = new BuniumWindow({
  url: html,
  width: 300,
  height: 200,
  title: "live color scheme test",
});
await Bun.sleep(500);

function readCenter() {
  const shot = win.captureScreenshot();
  const idx =
    (Math.floor(shot.height / 2) * shot.width + Math.floor(shot.width / 2)) * 4;
  return { b: shot.data[idx], g: shot.data[idx + 1], r: shot.data[idx + 2] };
}

const before = readCenter();
console.log("before toggle (forced light mode):", before);

// toggle OS to dark mode WHILE window already open, no reload/recreate
await setDarkMode(true);
await Bun.sleep(800);

const after = readCenter();
console.log("after toggling OS to dark (window stays open, no reload):", after);

const wasLight = before.r === 255 && before.g === 255 && before.b === 255;
const isNowDark = after.r === 0 && after.g === 0 && after.b === 0;
console.log("live color scheme sync works:", wasLight && isNowDark);

win.close();
app.shutdown();

await setDarkMode(wasDark);
