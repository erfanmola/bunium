// Scratch-verification script (not part of the CLI). Run manually against
// a scaffolded template's dist/ to confirm it renders through
// app.setAppRoot() + "bunium://app/". Not wired into any script/CI.
import { app, BuniumWindow } from "../src/index";

const distDir = process.argv[2];
if (!distDir) {
  console.error("usage: bun verify-prod.ts <dist-dir>");
  process.exit(1);
}

app.setAppRoot(distDir);
const win = new BuniumWindow({
  url: "bunium://app/",
  width: 400,
  height: 300,
  title: "prod verify",
});

await Bun.sleep(800);
const shot = win.captureScreenshot();
const idx =
  (Math.floor(shot.height / 2) * shot.width + Math.floor(shot.width / 2)) * 4;
console.log(
  "center pixel BGR:",
  shot.data[idx],
  shot.data[idx + 1],
  shot.data[idx + 2],
);
console.log("frame dims:", shot.width, "x", shot.height);

win.close();
app.shutdown();
