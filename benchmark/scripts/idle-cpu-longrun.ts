#!/usr/bin/env bun
// Standalone long-running window for idle-CPU sampling past the known
// ~3-4s delayed-onset window (see benchmark/RESULTS.md's idle-CPU
// methodology note) -- no self-destruct timer, stays open until SIGTERM.
import { app, BuniumWindow } from "../../src/index";

const html = `data:text/html,${encodeURIComponent(`
<body style="margin:0;background:#222;color:white;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh">
<h1>idle-cpu-longrun</h1>
</body>
`)}`;

const win = new BuniumWindow({
  url: html,
  width: 600,
  height: 400,
  title: "idle-cpu-longrun",
});

process.on("SIGTERM", () => {
  win.close();
  app.shutdown();
  process.exit(0);
});

console.log(`READY pid=${process.pid}`);
