// Host bridge for the bunium mini-app: implements window.bench on top of
// bunium's window.__bunium.send()/on() generic IPC channel (fire-and-forget
// both directions -- no built-in request/response, so "count-updated"
// comes back as its own event, same pattern the electron-mini-app bridge
// uses over ipcRenderer/ipcMain).
window.bench = {
  increment() {
    window.__bunium.send("increment", "{}");
  },
  onCount(cb) {
    window.__bunium.on("count-updated", (payload) => cb(payload.count));
  },
};
