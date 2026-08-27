// Minimal bunium app for the startup/idle-resource benchmark. Mirrors
// benchmark/electron-minimal/main.js exactly (same HTML, same milestone
// protocol) so the two are an apples-to-apples comparison. Printed
// "BENCH: <name> <epoch_ms>" lines are parsed by benchmark/scripts/*.
import { app, BuniumWindow } from "bunium";

const t0 = Date.now();
console.log(`BENCH: process_start ${t0}`);

const html = `data:text/html,${encodeURIComponent(`
<body style="margin:0;background:#222;color:white;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh">
<h1>bench</h1>
</body>
`)}`;

const win = new BuniumWindow({
  url: html,
  width: 600,
  height: 400,
  title: "bunium bench",
});
console.log(`BENCH: created ${Date.now()}`);

const waitForPaint = async (): Promise<void> => {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (win.frameCount >= 1) return;
    await Bun.sleep(10);
  }
};
await waitForPaint();
console.log(`BENCH: paint ${Date.now()}`);

// Idle window for the harness to sample RSS/CPU against, then exit on
// SIGTERM (the harness kills after its idle sampling window) or a hard cap.
process.on("SIGTERM", () => {
  win.close();
  app.shutdown();
  process.exit(0);
});
await Bun.sleep(30000);
win.close();
app.shutdown();
