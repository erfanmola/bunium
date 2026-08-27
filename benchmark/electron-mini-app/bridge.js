// Host bridge for the Electron mini-app: implements window.bench on top of
// ipcRenderer.send()/on(), the closest fire-and-forget analog to bunium's
// window.__bunium.send()/on(). Loaded with nodeIntegration on (see main.js)
// so this can require('electron') directly like bridge.js's bunium sibling
// reaches window.__bunium directly -- not a contextBridge/preload setup,
// since this benchmark measures raw IPC-channel overhead, not the extra
// context-isolation hop a production Electron app would add.
const { ipcRenderer } = require("electron");

window.bench = {
  increment() {
    ipcRenderer.send("increment");
  },
  onCount(cb) {
    ipcRenderer.on("count-updated", (_event, count) => cb(count));
  },
};
