import { app, BuniumWindow } from "../src/index";

const blank = "data:text/html,<body style='background:black'></body>";
const win = new BuniumWindow({
  url: blank,
  width: 500,
  height: 300,
  title: "loadurl test",
});

await Bun.sleep(1000);
const countBeforeNav = win.frameCount;
console.log("frames before nav:", countBeforeNav);

win.loadURL(
  "data:text/html,<body style='background:limegreen'><h1>navigated</h1></body>",
);

await Bun.sleep(1000);
const countAfterNav = win.frameCount;
console.log("frames after nav:", countAfterNav);
console.log("navigation produced new frames:", countAfterNav > countBeforeNav);

win.close();
app.shutdown();
