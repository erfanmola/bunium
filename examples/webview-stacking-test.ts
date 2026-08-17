// Verifies stacking/z-order sync for sibling <bunium-webview> elements:
// two overlapping webviews, CSS z-index decides which one is "on top" and
// should receive a click landing in the overlapping region -- exercises
// _syncOrder (WEBVIEW_ELEMENT_JS) -> __bunium_webview_order ->
// WebviewManager.updateOrder (window.ts) -> bunium_raise_native_sublayer
// (bunium_shim.cpp/bunium_window_mac.mm), both the CALayer paint-order
// raise and the g_window_sublayers hit-test registry reorder.
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

// Two fully-overlapping webviews at the same rect. "top" starts with
// z-index 2 (on top), "bottom" with z-index 1 (underneath). A small script
// listens for a 'set-z' message from the main side so the test can flip
// stacking order mid-run and verify _syncOrder picks it up.
const outerHtml = `data:text/html,${encodeURIComponent(`
<body style="margin:0">
<div id="box" style="width:100%;height:100%;background:red"></div>
<bunium-webview id="bottom" src="${clickablePage("blue")}"
  style="position:absolute;left:100px;top:100px;width:200px;height:150px;z-index:1;">
</bunium-webview>
<bunium-webview id="top" src="${clickablePage("yellow")}"
  style="position:absolute;left:100px;top:100px;width:200px;height:150px;z-index:2;">
</bunium-webview>
<script>
window.__bunium.on('set-z', function(payload) {
  document.getElementById(payload.id).style.zIndex = String(payload.z);
});
</script>
</body>
`)}`;

const win = new BuniumWindow({
  url: outerHtml,
  width: 600,
  height: 400,
  title: "webview stacking test",
});

function pump(ms: number) {
  return (async () => {
    const start = performance.now();
    while (performance.now() - start < ms) {
      await Bun.sleep(16);
    }
  })();
}

// Let the rAF loop detect+create both webview elements' native
// sublayers/views, and let _syncOrder run at least once.
await pump(1500);

const webviews: Map<string, { sublayerHandle: unknown; viewHandle: unknown }> =
  // biome-ignore lint/suspicious/noExplicitAny: test-only reflection into private state
  (win as any).webviews.webviews;
const bottom = webviews.get("wv-1");
const top = webviews.get("wv-2");
if (!bottom || !top) throw new Error("expected both elements to register");

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

function isGreen(p: { r: number; g: number; b: number }) {
  return p.g > 100 && p.r < 100 && p.b < 100;
}

console.log("top before:", readCenterPixel(top.viewHandle));
console.log("bottom before:", readCenterPixel(bottom.viewHandle));

// biome-ignore lint/suspicious/noExplicitAny: reflection into private state
const windowHandle = (win as any).windowHandle;

// Click at the center of the fully-overlapping rect -- window coord
// (200, 175) -- should reach "top" (z-index 2), not "bottom".
lib.symbols.bunium_dispatch_mouse_click(windowHandle, 200, 175, 0, 0, 1);
lib.symbols.bunium_dispatch_mouse_click(windowHandle, 200, 175, 0, 1, 1);
await pump(500);

const topAfterFirstClick = readCenterPixel(top.viewHandle);
const bottomAfterFirstClick = readCenterPixel(bottom.viewHandle);
console.log("top after click (z-index 2 on top):", topAfterFirstClick);
console.log("bottom after click (z-index 2 on top):", bottomAfterFirstClick);
console.log(
  "click routed to the topmost (z-index 2) webview only:",
  isGreen(topAfterFirstClick) && !isGreen(bottomAfterFirstClick),
);

// Now flip stacking order: give "bottom" the higher z-index so it becomes
// the topmost element, and let _syncOrder pick it up.
win.emit("set-z", { id: "bottom", z: 3 });
await pump(1000);

lib.symbols.bunium_dispatch_mouse_click(windowHandle, 200, 175, 0, 0, 1);
lib.symbols.bunium_dispatch_mouse_click(windowHandle, 200, 175, 0, 1, 1);
await pump(500);

const bottomAfterReorder = readCenterPixel(bottom.viewHandle);
console.log(
  "bottom after re-stacking on top and clicking:",
  bottomAfterReorder,
);
console.log(
  "click now routed to the re-stacked (formerly bottom) webview:",
  isGreen(bottomAfterReorder),
);

win.close();
app.shutdown();
