import { app } from "../src/app";
import { lib } from "../src/native";
import { BuniumWindow } from "../src/window";

const html = `data:text/html,${encodeURIComponent(`
<body style="margin:0">
${Array.from(
  { length: 200 },
  (_, i) =>
    `<div style="height:40px;background:hsl(${(i * 17) % 360},80%,50%)">row ${i}</div>`,
).join("")}
</body>
`)}`;

const win = new BuniumWindow({
  url: html,
  width: 800,
  height: 600,
  title: "scroll timing",
});

for (let i = 0; i < 200; i++) {
  if (win.frameCount > 0n) break;
  await Bun.sleep(5);
}
console.log("warmed up, frameCount:", win.frameCount);

const startCount = win.frameCount;
const start = performance.now();
const durationMs = 1500; // shorter than before: stop before hitting page bottom
let lastCount = startCount;
const gaps: number[] = [];
let lastChangeTime = start;

while (performance.now() - start < durationMs) {
  // @ts-expect-error -- accessing private viewHandle for a raw scroll call;
  // BuniumWindow doesn't expose scroll in its public API yet (Phase 2 territory)
  lib.symbols.bunium_send_scroll(win.viewHandle, 400, 300, 0, -10);
  const now = performance.now();
  const count = win.frameCount;
  if (count !== lastCount) {
    gaps.push(now - lastChangeTime);
    lastChangeTime = now;
    lastCount = count;
  }
  await Bun.sleep(4);
}

const elapsed = performance.now() - start;
const framesRendered = Number(win.frameCount - startCount);
console.log("frames rendered:", framesRendered, "in", elapsed.toFixed(1), "ms");
console.log("effective fps:", ((framesRendered / elapsed) * 1000).toFixed(1));
console.log(
  "avg inter-frame gap (ms):",
  (gaps.reduce((a, b) => a + b, 0) / gaps.length).toFixed(2),
);
console.log("max inter-frame gap (ms):", Math.max(...gaps).toFixed(2));

win.close();
app.shutdown();
