import { app, BuniumWindow } from "../src/index";

// A transparent window with a page that only paints a small opaque red
// square in the corner, leaving the rest transparent -- verifies alpha=0
// in most of the buffer and alpha=255 where the page actually painted.
const html = `data:text/html,${encodeURIComponent(`
<body style="margin:0;background:transparent">
<div style="position:absolute;top:0;left:0;width:50px;height:50px;background:red"></div>
</body>
`)}`;

const win = new BuniumWindow({
  url: html,
  width: 200,
  height: 200,
  transparent: true,
});
await Bun.sleep(500);

const shot = win.captureScreenshot();

function pixelAt(x: number, y: number) {
  const idx = (y * shot.width + x) * 4;
  return {
    b: shot.data[idx],
    g: shot.data[idx + 1],
    r: shot.data[idx + 2],
    a: shot.data[idx + 3],
  };
}

const corner = pixelAt(10, 10); // inside the red square
const middle = pixelAt(150, 150); // outside it, should be transparent

console.log("corner pixel (should be opaque red):", corner);
console.log("middle pixel (should be transparent):", middle);

const cornerOk = corner.r === 255 && corner.a === 255;
const middleOk = middle.a === 0;
console.log("transparency works:", cornerOk && middleOk);

win.close();
app.shutdown();
