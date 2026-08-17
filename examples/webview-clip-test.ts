// Verifies DOM overflow:hidden ancestor clipping for <bunium-webview>:
// _syncClip (WEBVIEW_ELEMENT_JS, bunium_common.h) walks the element's
// ancestors looking for a non-visible overflow, computes the intersection
// with the element's own rect, and sends __bunium_webview_clip whenever
// that changes; WebviewManager.updateClip (window.ts) applies/removes it
// via bunium_set_native_sublayer_clip/bunium_clear_native_sublayer_clip
// (bunium_window_mac.mm's reparent-under-a-masking-layer mechanism).
//
// Scenario: a <bunium-webview> is placed inside a small overflow:hidden
// container, positioned so only its left half is inside the container's
// bounds -- the right half should end up clipped away. A second,
// unclipped webview (outside any overflow:hidden ancestor) is used as a
// control to confirm clipping doesn't apply where it shouldn't.
import { app } from "../src/app";
import { BuniumWindow } from "../src/index";
import { lib } from "../src/native";

const innerPage = (bg: string) =>
  `data:text/html,${encodeURIComponent(`<body style="margin:0;background:${bg}"></body>`)}`;

const outerHtml = `data:text/html,${encodeURIComponent(`
<body style="margin:0">
  <div style="position:absolute;left:50px;top:50px;width:150px;height:150px;overflow:hidden;background:#333">
    <bunium-webview id="clipped" src="${innerPage("blue")}"
      style="position:absolute;left:100px;top:0px;width:200px;height:150px;">
    </bunium-webview>
  </div>
  <bunium-webview id="unclipped" src="${innerPage("green")}"
    style="position:absolute;left:300px;top:50px;width:150px;height:150px;">
  </bunium-webview>
</body>
`)}`;

const win = new BuniumWindow({
  url: outerHtml,
  width: 600,
  height: 400,
  title: "webview clip test",
});

function pump(ms: number) {
  return (async () => {
    const start = performance.now();
    while (performance.now() - start < ms) {
      await Bun.sleep(16);
    }
  })();
}

await pump(1500);

const webviews: Map<string, { sublayerHandle: unknown; viewHandle: unknown }> =
  // biome-ignore lint/suspicious/noExplicitAny: test-only reflection into private state
  (win as any).webviews.webviews;

const clipped = webviews.get("wv-1");
const unclipped = webviews.get("wv-2");
if (!clipped || !unclipped)
  throw new Error("expected both elements to have registered");

function readClip(sublayer: unknown) {
  const { ptr } = require("bun:ffi");
  const clippedFlag = new Int32Array(1);
  const x = new Int32Array(1);
  const y = new Int32Array(1);
  const w = new Int32Array(1);
  const h = new Int32Array(1);
  lib.symbols.bunium_get_native_sublayer_clip(
    // biome-ignore lint/suspicious/noExplicitAny: bun:ffi pointer args are loosely typed in tests
    sublayer as any,
    ptr(clippedFlag),
    ptr(x),
    ptr(y),
    ptr(w),
    ptr(h),
  );
  return {
    clipped: clippedFlag[0] === 1,
    x: x[0],
    y: y[0],
    w: w[0],
    h: h[0],
  };
}

const clippedResult = readClip(clipped.sublayerHandle);
const unclippedResult = readClip(unclipped.sublayerHandle);
console.log("clipped webview's native clip state:", clippedResult);
console.log("unclipped webview's native clip state:", unclippedResult);

// The clipped element sits inside an overflow:hidden container at
// (50,50)-(200,200), with the element itself at (150,50)-(350,200)
// (container-relative left:100 + container's own left:50 = 150 in window
// coords). The visible (post-clip) rect should be the intersection:
// (150,50) to (200,200) -> x:150, y:50, w:50, h:150.
const clipCorrect =
  clippedResult.clipped &&
  clippedResult.x === 150 &&
  clippedResult.y === 50 &&
  clippedResult.w === 50 &&
  clippedResult.h === 150;
console.log("clip rect computed correctly:", clipCorrect);

const controlCorrect = unclippedResult.clipped === false;
console.log("unclipped control element has no active clip:", controlCorrect);

win.close();
app.shutdown();
