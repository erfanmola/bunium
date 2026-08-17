// Closes the "not re-verified against an auto-created <bunium-webview>
// sublayer" gap noted in PLAN.md: sublayer-hit-test.ts already proved
// bunium_dispatch_mouse_click's hit-testing (g_window_sublayers in
// bunium_shim.cpp) works for a hand-wired sublayer/view pair, and
// webview-element-test.ts already proved a <bunium-webview> element causes
// WebviewManager to call the exact same bunium_create_native_sublayer that
// registers a sublayer into that same hit-test registry -- this test
// verifies those two previously-separate proofs actually compose: a click
// dispatched at a live <bunium-webview>'s on-screen position reaches the
// EMBEDDED page, not the OUTER page, purely from declaring the element in
// HTML (no manual sublayer/view wiring, unlike sublayer-hit-test.ts).
import { app } from "../src/app";
import { BuniumWindow } from "../src/index";
import { lib } from "../src/native";

function clickablePage(bg: string) {
  return `data:text/html,${encodeURIComponent(`
<body style="margin:0">
<div id="box" style="width:100%;height:100%;background:${bg}"
     onclick="document.getElementById('box').style.background='lime'"></div>
</body>
`)}`;
}

const outerHtml = `data:text/html,${encodeURIComponent(`
<body style="margin:0">
<div id="box" style="width:100%;height:100%;background:red"
     onclick="document.getElementById('box').style.background='lime'"></div>
<bunium-webview id="wv" src="${clickablePage("blue")}"
  style="position:absolute;left:100px;top:100px;width:250px;height:150px;">
</bunium-webview>
</body>
`)}`;

const win = new BuniumWindow({
  url: outerHtml,
  width: 600,
  height: 400,
  title: "webview hit test",
});

function pump(ms: number) {
  return (async () => {
    const start = performance.now();
    while (performance.now() - start < ms) {
      await Bun.sleep(16);
    }
  })();
}

// Let the rAF loop detect+create the webview element's native sublayer/view.
await pump(1500);

const webviews: Map<string, { sublayerHandle: unknown; viewHandle: unknown }> =
  // biome-ignore lint/suspicious/noExplicitAny: test-only reflection into private state
  (win as any).webviews.webviews;
const tracked = webviews.get("wv-1");
if (!tracked) throw new Error("expected element to have registered as wv-1");

// biome-ignore lint/suspicious/noExplicitAny: reflection into private state
const outerViewHandle = (win as any).viewHandle;
// biome-ignore lint/suspicious/noExplicitAny: reflection into private state
const windowHandle = (win as any).windowHandle;

function readCenterPixel(view: unknown) {
  const { ptr, toArrayBuffer } = require("bun:ffi");
  const w = new Int32Array(1);
  const h = new Int32Array(1);
  // biome-ignore lint/suspicious/noExplicitAny: bun:ffi pointer args are loosely typed in tests
  const framePtr = lib.symbols.bunium_get_frame(view as any, ptr(w), ptr(h));
  const bgra = new Uint8Array(toArrayBuffer(framePtr!, 0, w[0]! * h[0]! * 4));
  const idx = (Math.floor(h[0]! / 2) * w[0]! + Math.floor(w[0]! / 2)) * 4;
  return { r: bgra[idx + 2]!, g: bgra[idx + 1]!, b: bgra[idx]! };
}

console.log("outer before:", readCenterPixel(outerViewHandle));
console.log("webview before:", readCenterPixel(tracked.viewHandle));

// Click at window coord (200, 150) -- inside the webview's rect
// (100,100)-(350,250) -- should route to the EMBEDDED view, not the outer
// page, purely via the registry bunium_create_native_sublayer already
// populated when WebviewManager.create() ran.
lib.symbols.bunium_dispatch_mouse_click(windowHandle, 200, 150, 0, 0, 1);
lib.symbols.bunium_dispatch_mouse_click(windowHandle, 200, 150, 0, 1, 1);
await pump(500);

const outerAfter = readCenterPixel(outerViewHandle);
const webviewAfter = readCenterPixel(tracked.viewHandle);
console.log("outer after click-inside-webview:", outerAfter);
console.log("webview after click-inside-webview:", webviewAfter);

const outerStayedRed = outerAfter.r > 200 && outerAfter.g < 50;
const webviewTurnedGreen = webviewAfter.g > 100 && webviewAfter.r < 100;
console.log(
  "click routed to the <bunium-webview>'s embedded page only (outer untouched):",
  outerStayedRed && webviewTurnedGreen,
);

// Now click at (30, 30) -- outside the webview's rect -- should route to
// the outer page instead.
lib.symbols.bunium_dispatch_mouse_click(windowHandle, 30, 30, 0, 0, 1);
lib.symbols.bunium_dispatch_mouse_click(windowHandle, 30, 30, 0, 1, 1);
await pump(500);

const outerAfterOuterClick = readCenterPixel(outerViewHandle);
console.log("outer after click-outside-webview:", outerAfterOuterClick);
const outerTurnedGreen =
  outerAfterOuterClick.g > 100 && outerAfterOuterClick.r < 100;
console.log("second click routed to OUTER page:", outerTurnedGreen);

win.close();
app.shutdown();
