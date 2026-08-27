// Shared mini-app logic, identical DOM/render cost on both hosts. Each host
// (bunium-mini-app/bridge.js, electron-mini-app/bridge.js) implements
// window.bench.{increment,onCount} differently; this file is host-agnostic.
const t0 = performance.now();

const rows = document.getElementById("rows");
const frag = document.createDocumentFragment();
for (let i = 0; i < 200; i++) {
  const tr = document.createElement("tr");
  tr.innerHTML = `<td>${i}</td><td>item-${i}</td><td>${(i * 37) % 1000}</td>`;
  frag.appendChild(tr);
}
rows.appendChild(frag);

const countEl = document.getElementById("count");
document.getElementById("incr").addEventListener("click", () => {
  const start = performance.now();
  window.bench.increment();
  window.__benchIpcStart = start;
});
window.bench.onCount((count) => {
  countEl.textContent = String(count);
  if (window.__benchIpcStart) {
    const rtt = performance.now() - window.__benchIpcStart;
    console.log(`BENCH: ipc_rtt_ms ${rtt.toFixed(3)}`);
  }
});

window.__benchRenderMs = performance.now() - t0;
console.log(`BENCH: mini_app_render_ms ${window.__benchRenderMs.toFixed(3)}`);

// Automatic IPC round-trip sweep (renderer -> main -> renderer), N
// fire-and-forget send/receive cycles spaced out so each round trip is
// individually timed (back-to-back would queue on the message loop and
// measure throughput, not per-call latency). Starts after the render burst
// above settles so it isn't measuring under first-paint contention. Uses a
// single persistent onCount listener (registered once) rather than one per
// iteration -- neither bunium's window.__bunium.on() nor a naive
// ipcRenderer.on() wrapper supports unsubscribing, so re-registering per
// call would leak a growing pile of stale listeners that fire (with garbage
// timings) on every later increment.
let pendingStart = null;
let pendingResolve = null;
window.bench.onCount(() => {
  if (pendingResolve) {
    console.log(`BENCH: ipc_rtt_ms ${(performance.now() - pendingStart).toFixed(3)}`);
    const resolve = pendingResolve;
    pendingResolve = null;
    resolve();
  }
});
async function runIpcSweep(n) {
  for (let i = 0; i < n; i++) {
    await new Promise((resolve) => {
      pendingStart = performance.now();
      pendingResolve = resolve;
      window.bench.increment();
    });
    await new Promise((r) => setTimeout(r, 20));
  }
}
setTimeout(() => runIpcSweep(50), 300);
