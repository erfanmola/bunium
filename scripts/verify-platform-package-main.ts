import { join } from "node:path";
import { app, BuniumWindow } from "bunium";
import { verifyTrustedOriginBridge } from "./trusted-origin-smoke";

// End-to-end smoke test for an INSTALLED bunium consumer: this app is run
// from dist-release/_consumer/, where node_modules/bunium is a materialized
// copy of the package and node_modules/bunium-darwin-arm64 points at the
// staged platform package (real shim + trimmed CEF). The dev tree is not
// reachable from here, so src/paths.ts must fall back to the platform
// package -- if it instead resolves nothing usable, dlopen fails and window
// creation crashes.
app.setAppRoot(join(import.meta.dirname, "dist"));
const win = new BuniumWindow({
  url: "bunium://app/",
  trustedOrigins: ["bunium://app"],
  width: 320,
  height: 240,
  title: "platform package smoke",
});
let paintPassed = false;
const paintDeadline = Date.now() + 8000;
let centerPixel = "unavailable";
while (Date.now() < paintDeadline && !paintPassed) {
  if (win.frameCount > 0) {
    const shot = win.captureScreenshot();
    const idx =
      (Math.floor(shot.height / 2) * shot.width + Math.floor(shot.width / 2)) *
      4;
    if (shot.width > 0 && shot.height > 0 && shot.data.length >= idx + 3) {
      const b = shot.data[idx]!;
      const g = shot.data[idx + 1]!;
      const r = shot.data[idx + 2]!;
      centerPixel = `${b} ${g} ${r}`;
      paintPassed = r >= 40 && r < 60 && g > 190 && b < 60;
    }
  }
  if (!paintPassed) await Bun.sleep(50);
}
console.log("center pixel BGR:", centerPixel);
const trustedOriginPassed = paintPassed && (await verifyTrustedOriginBridge());
console.log(
  trustedOriginPassed
    ? "TRUSTED_ORIGIN_VERIFY:PASS"
    : "TRUSTED_ORIGIN_VERIFY:FAIL",
);
const passed = paintPassed && trustedOriginPassed;
console.log(
  passed ? "PLATFORM-PACKAGE-SMOKE PASS" : "PLATFORM-PACKAGE-SMOKE FAIL",
);
win.close();
app.shutdown();
process.exit(passed ? 0 : 1);
