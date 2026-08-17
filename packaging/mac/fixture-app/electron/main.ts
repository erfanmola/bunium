// End-to-end verification for packaging/mac/package.sh: this is the
// fixture's main-process entry, run from inside the packaged .app by the
// launcher wrapper. It exercises the exact prod path a real app takes --
// app.setAppRoot() against the bundled dist/, loading "bunium://app/" via
// the custom scheme, waiting for the first OSR frame, then pixel-verifying
// the page actually rendered. Exits 0 (PASS) / 1 (FAIL) so the packager
// can be validated in CI or a headless-ish terminal, unlike a real app
// whose main loop runs until the user quits.
import { join } from "node:path";
import { app, BuniumWindow } from "bunium";

const distDir = join(import.meta.dirname, "..", "dist");
app.setAppRoot(distDir);

const win = new BuniumWindow({
  url: "bunium://app/",
  width: 400,
  height: 300,
  title: "bunium packaging fixture",
});

const deadline = Date.now() + 15000;
const poll = (): void => {
  if (Date.now() > deadline) {
    console.error(
      "PACKAGED_APP_VERIFY:FAIL (timeout waiting for a green frame)",
    );
    app.shutdown();
    process.exit(1);
  }
  // frameCount is a BigInt (u64 FFI return), so compare against a number
  // via <, not === 0 (0n === 0 is false and would snapshot before paint).
  if (win.frameCount < 1) {
    setTimeout(poll, 50);
    return;
  }
  const shot = win.captureScreenshot();
  const idx =
    (Math.floor(shot.height / 2) * shot.width + Math.floor(shot.width / 2)) * 4;
  const b = shot.data[idx]!;
  const g = shot.data[idx + 1]!;
  const r = shot.data[idx + 2]!;
  // The first OnPaint can be the pre-paint white surface (notably on a
  // cold profile right after packaging), so don't fail on the first
  // snapshot -- keep polling until the page's own paint shows up.
  const ok = g > 200 && r < 60 && b < 60; // dist/index.html turns bg limegreen
  if (!ok) {
    console.log(`pre-paint frame (BGR ${b} ${g} ${r}), retrying...`);
    setTimeout(poll, 50);
    return;
  }
  console.log("center pixel BGR:", b, g, r);
  console.log("PACKAGED_APP_VERIFY:PASS");
  win.close();
  app.shutdown();
  process.exit(0);
};
setTimeout(poll, 50);
