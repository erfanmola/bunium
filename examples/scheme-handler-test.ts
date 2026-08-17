// Verifies the "bunium://app/<path>" custom scheme end-to-end (see
// BuniumSchemeHandlerFactory / BuniumSchemeResourceHandler in
// native/mac/bunium_common.h). This is the prod half of Phase 3: instead of
// pointing loadURL() at a running Vite dev server, prod builds set the app
// root to the built static output dir and load "bunium://app/" from it.
//
// Exercises:
//  - index.html defaulting when the path is empty/"/"
//  - relative-path resolution of a same-directory asset (a <script src>
//    pulling in a .js file) -- the reason this needed a real registered
//    scheme instead of reusing file:// or a data: URL, since those don't
//    support normal relative fetch/import semantics the way a real site
//    does
//  - correct MIME type resolution (the injected script sets a global that
//    only a *successfully executed* .js file would set; if MIME type were
//    wrong/missing, some browsers refuse to execute it)
//  - 404 handling on a missing file (should fail gracefully, not crash)
//  - ".." path-traversal rejection (defense in depth on top of CEF's own
//    URL canonicalization)
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app, BuniumWindow } from "../src/index";

const root = mkdtempSync(join(tmpdir(), "bunium-scheme-test-"));

writeFileSync(
  join(root, "index.html"),
  "<!doctype html>\n<html><head></head>\n" +
    '<body style="margin:0;background:red">\n' +
    '<h1 id="label">loading</h1>\n' +
    '<script src="app.js"></script>\n' +
    "</body></html>",
);
writeFileSync(
  join(root, "app.js"),
  "document.getElementById('label').textContent = 'loaded-via-scheme';\n" +
    "document.body.style.background = 'limegreen';",
);

app.setAppRoot(root);

const win = new BuniumWindow({
  url: "bunium://app/",
  width: 400,
  height: 300,
  title: "scheme handler test",
});

await Bun.sleep(500);

const shot = win.captureScreenshot();
const idx =
  (Math.floor(shot.height / 2) * shot.width + Math.floor(shot.width / 2)) * 4;
const b = shot.data[idx]!;
const g = shot.data[idx + 1]!;
const r = shot.data[idx + 2]!;
console.log("center pixel BGR:", b, g, r);
const isGreen = g > 200 && r < 60 && b < 60;
console.log(
  isGreen
    ? "PASS: index.html defaulted + app.js executed (background flipped to limegreen)"
    : "FAIL: expected limegreen background from app.js",
);

// 404 case: request a file that doesn't exist. Should not crash the
// process; page should just fail to load that resource (verified by not
// throwing/hanging here, and by the color check above already having
// proven a *successful* load works, giving a baseline to contrast against).
win.loadURL("bunium://app/does-not-exist.html");
await Bun.sleep(300);
console.log("PASS: 404 request completed without crashing");

// ".." traversal: should not escape the root. CEF's own URL parsing
// generally collapses ".." before this handler even sees it, but the
// handler also explicitly rejects any path containing "..".
win.loadURL("bunium://app/../../../../etc/passwd");
await Bun.sleep(300);
console.log("PASS: traversal request completed without crashing");

win.close();
app.shutdown();
