import { app, BuniumWindow } from "../src/index";

const html = `data:text/html,${encodeURIComponent(`
<body style="margin:0;background:#222;color:white;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh">
<h1>bunium — real API, not raw FFI calls</h1>
</body>
`)}`;

const win = new BuniumWindow({
  url: html,
  width: 600,
  height: 400,
  title: "bunium example",
});

await Bun.sleep(6000);

console.log("frameCount:", win.frameCount);
win.close();
app.shutdown();
