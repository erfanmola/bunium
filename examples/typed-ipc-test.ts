import { app, BuniumWindow } from "../src/index";

interface AppMessages {
  "user-clicked": { id: string; count: number };
  ping: { ts: number };
}

const html = `
<script>
  window.__bunium.send("user-clicked", JSON.stringify({ id: "btn-1", count: 3 }));
  window.__bunium.send("ping", JSON.stringify({ ts: 42 }));
  window.__bunium.send("user-clicked", JSON.stringify({ id: "btn-2", count: 7 }));
</script>
`;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: () => new Response(html, { headers: { "content-type": "text/html" } }),
});
const origin = server.url.origin;

const win = new BuniumWindow<AppMessages>({
  url: `${origin}/`,
  trustedOrigins: [origin],
  width: 300,
  height: 200,
});

const received: Array<{ id: string; count: number }> = [];
win.on("user-clicked", (payload) => {
  // payload is typed as { id: string; count: number } at compile time
  received.push({ id: payload.id, count: payload.count });
});

let pingReceived = false;
win.on("ping", (payload) => {
  pingReceived = payload.ts === 42;
});

const start = performance.now();
while (performance.now() - start < 1000) {
  await Bun.sleep(8);
}

console.log("received user-clicked messages:", received);
console.log(
  "both user-clicked messages arrived in order:",
  received.length === 2 &&
    received[0]?.id === "btn-1" &&
    received[1]?.id === "btn-2",
);
console.log("ping message arrived with correct payload:", pingReceived);

win.close();
server.stop();
app.shutdown();
