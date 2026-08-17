import { app, BuniumWindow } from "../src/index";

const html = "data:text/html,<body style='background:teal'></body>";
const win = new BuniumWindow({
  url: html,
  width: 400,
  height: 300,
  title: "close test",
});

let closeFired = false;
win.onClose(() => {
  closeFired = true;
});

await Bun.sleep(500);
win.close();
await Bun.sleep(100);

console.log("closeFired:", closeFired);
console.log("calling close() again is a no-op (no crash):");
win.close(); // should be a no-op, not double-free
console.log("survived double close");

app.shutdown();
