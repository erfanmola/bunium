import { existsSync } from "node:fs";
import { join } from "node:path";
import { app, BuniumWindow } from "bunium";

// Dev: point loadURL() at the running Vite dev server (matches
// vite.config.ts's fixed strictPort) -- HMR works for free since a bunium
// window is a real Chromium tab. Prod: set the app root to the built
// `dist/` output and load it through the "bunium://app/" custom scheme
// (see bunium's Phase 3 plan entry for why not `file://`). Toggle via
// NODE_ENV, set by the "bunium:dev" script only in dev.
const isDev = process.env.NODE_ENV !== "production";

let win: BuniumWindow;

if (isDev) {
  win = new BuniumWindow({
    url: "http://localhost:5173/",
    width: 1000,
    height: 700,
    title: "__PROJECT_NAME__",
  });
} else {
  const distDir = join(import.meta.dirname, "..", "dist");
  if (!existsSync(distDir)) {
    throw new Error(
      `bunium: no build output at ${distDir} -- run "bun run build" first`,
    );
  }
  app.setAppRoot(distDir);
  win = new BuniumWindow({
    url: "bunium://app/",
    width: 1000,
    height: 700,
    title: "__PROJECT_NAME__",
  });
}

win.onClose(() => {
  app.shutdown();
  process.exit(0);
});
