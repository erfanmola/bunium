const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("node:path");

const t0 = Date.now();
console.log(`BENCH: process_start ${t0}`);

let count = 0;
ipcMain.on("increment", (event) => {
  count++;
  event.sender.send("count-updated", count);
});

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 900,
    height: 600,
    title: "electron mini-app",
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });
  console.log(`BENCH: created ${Date.now()}`);

  // Electron doesn't forward renderer console.log to the host process by
  // default (bunium's OnConsoleMessage does) -- forward it explicitly so
  // this app's own BENCH: lines (mini_app_render_ms, ipc_rtt_ms) reach the
  // harness the same way they do for the bunium side.
  win.webContents.on("console-message", (event) => {
    console.log(event.message);
  });

  win.once("ready-to-show", () => {
    console.log(`BENCH: paint ${Date.now()}`);
    win.show();
  });

  win.loadFile(path.join(__dirname, "index.html"));

  process.on("SIGTERM", () => app.exit(0));
  setTimeout(() => app.exit(0), 30000);
});
