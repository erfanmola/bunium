import { app, BuniumWindow } from "../src/index";

interface AppMessages {
  "set-color": { color: string };
}

const html = `data:text/html,${encodeURIComponent(`
<body style="margin:0">
<div id="box" style="width:300px;height:200px;background:red"></div>
<script>
  window.__bunium.on("set-color", (payload) => {
    document.getElementById("box").style.background = payload.color;
  });
</script>
</body>
`)}`;

const win = new BuniumWindow<AppMessages>({
  url: html,
  width: 300,
  height: 200,
});

function pump(ms: number) {
  return Bun.sleep(ms);
}

await pump(500);
const before = win.captureScreenshot();
const idxBefore =
  (Math.floor(before.height / 2) * before.width +
    Math.floor(before.width / 2)) *
  4;
console.log(
  "before emit (BGR):",
  before.data[idxBefore],
  before.data[idxBefore + 1],
  before.data[idxBefore + 2],
);

win.emit("set-color", { color: "lime" });
await pump(500);

const after = win.captureScreenshot();
const idxAfter =
  (Math.floor(after.height / 2) * after.width + Math.floor(after.width / 2)) *
  4;
console.log(
  "after emit (BGR):",
  after.data[idxAfter],
  after.data[idxAfter + 1],
  after.data[idxAfter + 2],
);

const wasRed =
  before.data[idxBefore + 2] === 255 && before.data[idxBefore + 1] === 0;
const isGreen =
  after.data[idxAfter + 1]! > 100 && after.data[idxAfter + 2]! < 100;
console.log(
  "main->renderer emit reached page and updated DOM:",
  wasRed && isGreen,
);

win.close();
app.shutdown();
