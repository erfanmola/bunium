// Verifies clip-aware hit-testing: a click landing in a portion of a
// <bunium-webview>'s NOMINAL rect that's actually clipped away by a DOM
// overflow:hidden ancestor should NOT reach the webview -- it should fall
// through to whatever's underneath (the outer page here), matching how a
// real DOM child element only receives clicks within its own
// visually-clipped bounds. Closes the "clip-aware hit-testing" gap noted
// in PLAN.md after webview-clip-test.ts (which only verified the visual
// clip, not hit-testing) and webview-hit-test.ts (which only tested an
// UNclipped webview).
//
// Layout: same clipped-webview geometry as webview-clip-test.ts -- an
// element at (150,50)-(350,200) inside a (50,50)-(200,200) overflow:hidden
// container, so the element's visible (post-clip) rect is (150,50)-(200,200)
// and its clipped-away portion is (200,50)-(350,200).
import { app } from "../src/app";
import { BuniumWindow } from "../src/index";
import { lib } from "../src/native";

const innerPage = (bg: string) =>
  `data:text/html,${encodeURIComponent(`
<body style="margin:0">
<div id="box" style="width:100%;height:100%;background:${bg}"
     onclick="document.getElementById('box').style.background='lime'"></div>
</body>
`)}`;

const outerHtml = `data:text/html,${encodeURIComponent(`
<body style="margin:0">
<div id="obox" style="width:100%;height:100%;background:red"
     onclick="document.getElementById('obox').style.background='lime'"></div>
<div style="position:absolute;left:50px;top:50px;width:150px;height:150px;overflow:hidden">
  <bunium-webview id="wv" src="${innerPage("blue")}"
    style="position:absolute;left:100px;top:0px;width:200px;height:150px;">
  </bunium-webview>
</div>
</body>
`)}`;

const win = new BuniumWindow({
  url: outerHtml,
  width: 600,
  height: 400,
  title: "webview clip hit test",
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

// Click at (280, 100) -- inside the webview's NOMINAL rect (150,50)-(350,200)
// but inside its CLIPPED-AWAY portion (200,50)-(350,200). This must NOT
// reach the webview -- it should fall through to the outer page.
lib.symbols.bunium_dispatch_mouse_click(windowHandle, 280, 100, 0, 0, 1);
lib.symbols.bunium_dispatch_mouse_click(windowHandle, 280, 100, 0, 1, 1);
await pump(500);

const outerAfterClippedClick = readCenterPixel(outerViewHandle);
const webviewAfterClippedClick = readCenterPixel(tracked.viewHandle);
console.log(
  "outer after click-in-clipped-away-region:",
  outerAfterClippedClick,
);
console.log(
  "webview after click-in-clipped-away-region:",
  webviewAfterClippedClick,
);

const clickFellThroughToOuter =
  outerAfterClippedClick.g > 100 && outerAfterClippedClick.r < 100;
const webviewUntouched =
  webviewAfterClippedClick.b > 200 && webviewAfterClippedClick.g < 50;
console.log(
  "click in clipped-away region correctly fell through to outer page (webview untouched):",
  clickFellThroughToOuter && webviewUntouched,
);

// Sanity control: a click at (170, 100) -- inside the webview's VISIBLE
// (post-clip) rect (150,50)-(200,200) -- should still reach the webview
// normally, confirming clip-awareness didn't break ordinary hit-testing.
lib.symbols.bunium_dispatch_mouse_click(windowHandle, 170, 100, 0, 0, 1);
lib.symbols.bunium_dispatch_mouse_click(windowHandle, 170, 100, 0, 1, 1);
await pump(500);

const webviewAfterVisibleClick = readCenterPixel(tracked.viewHandle);
console.log("webview after click-in-visible-region:", webviewAfterVisibleClick);
const visibleClickReachedWebview =
  webviewAfterVisibleClick.g > 100 && webviewAfterVisibleClick.r < 100;
console.log(
  "click in visible region still reaches the webview normally:",
  visibleClickReachedWebview,
);

win.close();
app.shutdown();
