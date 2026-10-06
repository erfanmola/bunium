import { app, BuniumWindow, deviceEmulationCapabilities } from "../src/index";

const viewport = { width: 360, height: 640 };
const screen = { width: 390, height: 844 };
const host = new BuniumWindow({
  url: "data:text/html,<title>device emulation host</title>",
  width: 800,
  height: 700,
  title: "device emulation qualification",
});

const bridgeScript = `
  setTimeout(function () {
    post(JSON.stringify({
      type: "metrics",
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      visualWidth: window.visualViewport.width,
      visualHeight: window.visualViewport.height,
      screenWidth: window.screen.width,
      screenHeight: window.screen.height,
      dpr: window.devicePixelRatio,
      maxTouchPoints: navigator.maxTouchPoints,
      coarse: matchMedia('(pointer: coarse)').matches,
      fine: matchMedia('(pointer: fine)').matches,
      anyCoarse: matchMedia('(any-pointer: coarse)').matches,
      anyFine: matchMedia('(any-pointer: fine)').matches,
      hover: matchMedia('(hover: hover)').matches,
      anyHover: matchMedia('(any-hover: hover)').matches
    }));
  }, 250);
  return function () {};
`;

function createGuest(x: number, scale: number) {
  const guest = host.createGuest({
    ...viewport,
    x,
    y: 0,
    url: "data:text/html,<title>emulated guest</title>",
    bridgeScript,
    emulation: {
      screen,
      deviceScaleFactor: scale,
      touch:
        scale === 1
          ? { enabled: true, maxTouchPoints: 5 }
          : { enabled: false, maxTouchPoints: 0 },
      pointer:
        scale === 1
          ? { primary: "coarse", any: "coarse", hover: false, anyHover: false }
          : { primary: "fine", any: "fine", hover: true, anyHover: true },
    },
  });
  const metrics = new Promise<Record<string, number>>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("guest metrics timed out")),
      5000,
    );
    guest.onMessage(({ data }) => {
      try {
        const message = JSON.parse(data) as Record<string, number | string>;
        if (message.type === "metrics") {
          clearTimeout(timeout);
          resolve(message as Record<string, number>);
        }
      } catch {
        // Ignore unrelated guest messages.
      }
    });
  });
  return { guest, metrics };
}

try {
  const one = createGuest(0, 1);
  const two = createGuest(400, 2);
  const [oneMetrics, twoMetrics] = await Promise.all([
    one.metrics,
    two.metrics,
  ]);
  await Bun.sleep(500);

  const expected = (scale: number) => ({
    type: "metrics",
    innerWidth: viewport.width,
    innerHeight: viewport.height,
    visualWidth: viewport.width,
    visualHeight: viewport.height,
    screenWidth: screen.width,
    screenHeight: screen.height,
    dpr: scale,
    maxTouchPoints: scale === 1 ? 5 : 0,
    coarse: scale === 1,
    fine: scale === 2,
    anyCoarse: scale === 1,
    anyFine: scale === 2,
    hover: scale === 2,
    anyHover: scale === 2,
  });
  const oneRaster = one.guest.renderedSize;
  const twoRaster = two.guest.renderedSize;
  const checks = [
    JSON.stringify(oneMetrics) === JSON.stringify(expected(1)),
    JSON.stringify(twoMetrics) === JSON.stringify(expected(2)),
    oneMetrics.maxTouchPoints === 5 && !twoMetrics.maxTouchPoints,
    oneRaster.width === viewport.width && oneRaster.height === viewport.height,
    twoRaster.width === viewport.width * 2 &&
      twoRaster.height === viewport.height * 2,
  ];
  console.log(
    JSON.stringify(
      {
        gate: checks.every(Boolean)
          ? "DEVICE_EMULATION_GATE:PASS"
          : "DEVICE_EMULATION_GATE:FAIL",
        hostDpr: host.devicePixelRatio,
        capabilities: deviceEmulationCapabilities,
        one: { metrics: oneMetrics, raster: oneRaster },
        two: { metrics: twoMetrics, raster: twoRaster },
      },
      null,
      2,
    ),
  );
  if (!checks.every(Boolean))
    throw new Error("device emulation qualification mismatch");
} finally {
  host.close();
  app.shutdown();
}
