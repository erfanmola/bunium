import { app, BuniumWindow } from "../src/index";

const win = new BuniumWindow({
  url: "data:text/html,<body style='background:red'></body>",
  width: 400,
  height: 300,
  title: "dpr + screenshot test",
});

await Bun.sleep(500);

console.log("innerSize:", win.innerSize);
console.log("devicePixelRatio:", win.devicePixelRatio);
console.log("renderedSize:", win.renderedSize);
console.log(
  "renderedSize matches innerSize * dpr:",
  win.renderedSize.width === win.innerSize.width * win.devicePixelRatio &&
    win.renderedSize.height === win.innerSize.height * win.devicePixelRatio,
);

const shot = win.captureScreenshot();
console.log("screenshot dims:", shot.width, "x", shot.height);
console.log(
  "screenshot data length:",
  shot.data.length,
  "expected:",
  shot.width * shot.height * 4,
);
// center pixel should be red (BGRA: B=0, G=0, R=255)
const idx =
  (Math.floor(shot.height / 2) * shot.width + Math.floor(shot.width / 2)) * 4;
console.log(
  "center pixel BGRA:",
  shot.data[idx],
  shot.data[idx + 1],
  shot.data[idx + 2],
  shot.data[idx + 3],
);

win.close();
app.shutdown();
