import { app, BuniumWindow } from "../src/index";

const fixed = new BuniumWindow({
  url: "data:text/html,<body></body>",
  width: 300,
  height: 200,
  resizable: false,
});
await Bun.sleep(300);
const fixedResizable = fixed.resizable;
console.log("fixed window resizable:", fixedResizable);
fixed.close();

const constrained = new BuniumWindow({
  url: "data:text/html,<body></body>",
  width: 400,
  height: 300,
  minWidth: 200,
  minHeight: 150,
  maxWidth: 800,
  maxHeight: 600,
});
await Bun.sleep(300);
const constrainedResizable = constrained.resizable;
const c = constrained.sizeConstraints;
console.log("constrained window resizable:", constrainedResizable);
console.log("size constraints:", c);

const correct =
  fixedResizable === false &&
  constrainedResizable === true &&
  c.minWidth === 200 &&
  c.minHeight === 150 &&
  c.maxWidth === 800 &&
  c.maxHeight === 600;
console.log("resizable + constraints applied correctly:", correct);

constrained.close();
app.shutdown();
