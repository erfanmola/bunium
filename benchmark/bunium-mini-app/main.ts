import { join } from "node:path";
import { app, BuniumWindow } from "bunium";

interface AppMessages {
  increment: Record<string, never>;
  "count-updated": { count: number };
}

const t0 = Date.now();
console.log(`BENCH: process_start ${t0}`);

app.setAppRoot(join(import.meta.dirname, "dist"));

const win = new BuniumWindow<AppMessages>({
  url: "bunium://app/",
  width: 900,
  height: 600,
  title: "bunium mini-app",
});
console.log(`BENCH: created ${Date.now()}`);

let count = 0;
win.on("increment", () => {
  count++;
  win.emit("count-updated", { count });
});

const waitForPaint = async (): Promise<void> => {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (win.frameCount >= 1) return;
    await Bun.sleep(10);
  }
};
await waitForPaint();
console.log(`BENCH: paint ${Date.now()}`);

process.on("SIGTERM", () => {
  win.close();
  app.shutdown();
  process.exit(0);
});
await Bun.sleep(30000);
win.close();
app.shutdown();
