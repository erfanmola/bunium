// Proves the <bunium-webview> custom element end-to-end: outer page
// declares one in HTML with a positioned/sized style, the injected element
// runtime (WEBVIEW_ELEMENT_JS, bunium_common.h) auto-detects it via a rAF
// getBoundingClientRect() loop and drives WebviewManager (window.ts) to
// create a real native sublayer + CEF view for it -- no manual
// reportBounds()/create call from this test, unlike ipc-bounds-test.ts and
// sublayer-hit-test.ts which wire the mechanism by hand. Verifies:
// 1) the embedded page actually painted (non-empty frame) purely from the
//    element being present in the outer page's DOM.
// 2) the native sublayer's frame matches the element's initial
//    getBoundingClientRect(), read back through the same
//    bunium_get_native_sublayer_frame used by ipc-bounds-test.ts.
// 3) moving/resizing the element in-page (a live style mutation, no
//    navigation) live-updates the native sublayer's frame via the rAF loop.

import { app } from "../src/app";
import { BuniumWindow } from "../src/index";
import { lib } from "../src/native";

const innerPage = `data:text/html,${encodeURIComponent(
  '<body style="margin:0;background:blue"></body>',
)}`;

const outerHtml = `data:text/html,${encodeURIComponent(`
<body style="margin:0">
  <bunium-webview id="wv" src="${innerPage}"
    style="position:absolute;left:50px;top:40px;width:200px;height:150px;">
  </bunium-webview>
  <script>
    window.__bunium.on('move', function() {
      var el = document.getElementById('wv');
      el.style.left = '120px';
      el.style.top = '90px';
      el.style.width = '250px';
      el.style.height = '180px';
    });
  </script>
</body>
`)}`;

const win = new BuniumWindow({
  url: outerHtml,
  width: 600,
  height: 400,
  title: "webview element test",
});

function pump(ms: number) {
  return (async () => {
    const start = performance.now();
    while (performance.now() - start < ms) {
      await Bun.sleep(16); // BuniumApp's own pump loop drains messages
    }
  })();
}

// Give the rAF loop a few frames to detect the element (fires
// __bunium_webview_create) and give WebviewManager a moment to actually
// create + paint the native view.
await pump(1500);

// Reach into the private WebviewManager the same way the sublayer tests
// reach into raw native handles -- there's no public "list webviews" API
// yet (not needed by real apps, which only interact via the DOM element),
// so this pokes at the internal map for verification purposes only.
const webviews: Map<string, { sublayerHandle: unknown; viewHandle: unknown }> =
  // biome-ignore lint/suspicious/noExplicitAny: test-only reflection into private state
  (win as any).webviews.webviews;

console.log("tracked webview count after creation:", webviews.size);
const tracked = webviews.get("wv-1");
if (!tracked) throw new Error("expected element to have registered as wv-1");

function readFrame(view: unknown) {
  const { ptr } = require("bun:ffi");
  const w = new Int32Array(1);
  const h = new Int32Array(1);
  // biome-ignore lint/suspicious/noExplicitAny: bun:ffi pointer args are loosely typed in tests
  const framePtr = lib.symbols.bunium_get_frame(view as any, ptr(w), ptr(h));
  return { width: w[0]!, height: h[0]!, hasPixels: framePtr !== null };
}

const initialFrame = readFrame(tracked.viewHandle);
console.log("embedded view painted frame:", initialFrame);
console.log(
  "embedded view actually painted:",
  initialFrame.hasPixels && initialFrame.width > 0 && initialFrame.height > 0,
);

function readSublayerFrame(sublayer: unknown) {
  const { ptr } = require("bun:ffi");
  const x = new Int32Array(1);
  const y = new Int32Array(1);
  const w = new Int32Array(1);
  const h = new Int32Array(1);
  lib.symbols.bunium_get_native_sublayer_frame(
    // biome-ignore lint/suspicious/noExplicitAny: bun:ffi pointer args are loosely typed in tests
    sublayer as any,
    ptr(x),
    ptr(y),
    ptr(w),
    ptr(h),
  );
  return { x: x[0], y: y[0], w: w[0], h: h[0] };
}

const initialSublayerFrame = readSublayerFrame(tracked.sublayerHandle);
console.log("sublayer frame after create:", initialSublayerFrame);
console.log(
  "sublayer frame matches initial element rect (50,40,200,150):",
  JSON.stringify(initialSublayerFrame) ===
    JSON.stringify({ x: 50, y: 40, w: 200, h: 150 }),
);

// Move+resize the element in-page (no navigation) and confirm the rAF loop
// picks it up and the sublayer follows. Uses the existing typed IPC
// main->renderer push (BuniumWindow.emit) to tell the page to mutate its
// own DOM -- the page's 'move' listener above does the actual style change.
win.emit("move", {});

await pump(1500);

const movedSublayerFrame = readSublayerFrame(tracked.sublayerHandle);
console.log("sublayer frame after in-page move:", movedSublayerFrame);
console.log(
  "sublayer followed the moved/resized element (120,90,250,180):",
  JSON.stringify(movedSublayerFrame) ===
    JSON.stringify({ x: 120, y: 90, w: 250, h: 180 }),
);

win.close();
app.shutdown();
