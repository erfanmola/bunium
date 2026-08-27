// Minimal Electron app for the startup/idle-resource benchmark. Mirrors
// benchmark/bunium-minimal/main.ts exactly (same HTML, same milestone
// protocol) so the two are an apples-to-apples comparison.
const { app, BrowserWindow } = require("electron");

const t0 = Date.now();
console.log(`BENCH: process_start ${t0}`);

const html = `data:text/html,${encodeURIComponent(`
<body style="margin:0;background:#222;color:white;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh">
<h1>bench</h1>
</body>
`)}`;

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 600,
    height: 400,
    title: "electron bench",
    show: false,
  });
  console.log(`BENCH: created ${Date.now()}`);

  win.once("ready-to-show", () => {
    console.log(`BENCH: paint ${Date.now()}`);
    win.show();
  });

  win.loadURL(html);

  process.on("SIGTERM", () => {
    app.exit(0);
  });
  setTimeout(() => app.exit(0), 30000);
});
