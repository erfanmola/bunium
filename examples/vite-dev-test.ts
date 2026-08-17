// Verifies the dev half of Phase 3: loadURL() pointed at a real running
// Vite dev server. No new native code needed here -- loadURL() already
// exists and a bunium window is just a real Chromium tab, so a Vite dev
// server should "just work," including HMR, the same as any other browser.
//
// Exercises:
//  - loadURL() against a real `vite dev` process (spawned as a child
//    process from this script, not mocked) actually renders the served
//    page (pixel readback, not just "didn't crash")
//  - HMR: editing the source file on disk while the window stays open
//    causes the page to update in place via Vite's client-injected
//    WebSocket, without this script calling loadURL() or reload() again
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app, BuniumWindow } from "../src/index";

const fixtureDir = join(import.meta.dirname, "vite-dev-fixture");
const mainJsPath = join(fixtureDir, "main.js");
const originalMainJs = readFileSync(mainJsPath, "utf8");

const devServerUrl = "http://localhost:5199/";

const vite = spawn("bunx", ["vite", "--strictPort"], {
  cwd: fixtureDir,
  stdio: ["ignore", "pipe", "pipe"],
});

let viteReady = false;
vite.stdout.on("data", (chunk: Buffer) => {
  if (chunk.toString().includes("ready in")) viteReady = true;
});
vite.stderr.on("data", (chunk: Buffer) => {
  process.stderr.write(`[vite] ${chunk}`);
});

async function cleanup(exitCode: number) {
  writeFileSync(mainJsPath, originalMainJs);
  vite.kill();
  app.shutdown();
  process.exit(exitCode);
}

// Wait for vite's dev server to report readiness (up to ~10s), rather than
// a fixed sleep -- cold `bunx vite` startup time varies with npm registry
// cache state.
const startWait = Date.now();
while (!viteReady && Date.now() - startWait < 10_000) {
  await Bun.sleep(100);
}
if (!viteReady) {
  console.log("FAIL: vite dev server did not become ready in time");
  await cleanup(1);
}

const win = new BuniumWindow({
  url: devServerUrl,
  width: 400,
  height: 300,
  title: "vite dev test",
});

await Bun.sleep(1000);

function readCenter() {
  const shot = win.captureScreenshot();
  const idx =
    (Math.floor(shot.height / 2) * shot.width + Math.floor(shot.width / 2)) * 4;
  return {
    b: shot.data[idx]!,
    g: shot.data[idx + 1]!,
    r: shot.data[idx + 2]!,
  };
}

const before = readCenter();
console.log("before edit, center pixel BGR:", before);
const initialLoadOk = before.g > 200 && before.r < 60 && before.b < 60;
console.log(
  initialLoadOk
    ? "PASS: initial dev-server page loaded (main.js executed, background limegreen)"
    : "FAIL: expected limegreen background on initial load",
);

// Trigger HMR: edit the source file on disk. Vite's dev server watches it,
// pushes an update over its client WebSocket, and (since this changes a
// top-level statement Vite can't hot-swap as a pure module update) the
// injected HMR client falls back to a full page reload -- still exercises
// the same "dev server drives the page" path with zero bunium-side
// involvement, just via reload instead of true hot-swap.
writeFileSync(
  mainJsPath,
  'document.getElementById("label").textContent = "hmr-updated";\n' +
    'document.body.style.background = "blue";\n',
);

const hmrWaitStart = Date.now();
let hmrObserved = false;
while (Date.now() - hmrWaitStart < 8_000) {
  await Bun.sleep(250);
  const p = readCenter();
  if (p.b > 200 && p.r < 60 && p.g < 60) {
    hmrObserved = true;
    break;
  }
}
console.log(
  hmrObserved
    ? "PASS: HMR/reload picked up the on-disk edit (background flipped to blue)"
    : "FAIL: page never reflected the on-disk edit within timeout",
);

await cleanup(0);
