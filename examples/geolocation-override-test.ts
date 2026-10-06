import { app, BuniumWindow } from "../src/index";

let serverPort = 0;
const server = Bun.serve({
  port: 0,
  fetch(request) {
    if (new URL(request.url).pathname === "/cross-origin") {
      return new Response(
        `<!doctype html><script>
        navigator.geolocation.getCurrentPosition(
          () => parent.postMessage({ source: "cross-origin", status: "ok" }, "*"),
          (error) => parent.postMessage({ source: "cross-origin", status: "error", code: error.code }, "*")
        );
      </script>`,
        { headers: { "Content-Type": "text/html; charset=utf-8" } },
      );
    }
    return new Response(
      `<!doctype html><title>guest location</title><script>
      window.addEventListener("message", (event) => {
        if (event.origin === "http://localhost:${serverPort}" &&
            event.data?.source === "cross-origin") {
          document.documentElement.dataset.crossOriginResult = JSON.stringify(event.data);
        }
      });
    </script>`,
      { headers: { "Content-Type": "text/html; charset=utf-8" } },
    );
  },
});
if (server.port === undefined)
  throw new Error("local fixture server failed to bind");
serverPort = server.port;
const host = new BuniumWindow({
  url: "data:text/html,<title>geolocation host</title>",
  width: 800,
  height: 700,
  title: "guest geolocation qualification",
});

const bridgeScript = `
  return function (message) {
    if (message === "cross-origin-permission") {
      const frame = document.createElement("iframe");
      frame.src = "http://localhost:${serverPort}/cross-origin";
      document.body.append(frame);
      return;
    }
    if (message === "read-cross-origin-result") {
      post(document.documentElement.dataset.crossOriginResult ?? "pending");
      return;
    }
    if (message !== "read-location") return;
    navigator.geolocation.getCurrentPosition(
      (position) => post(JSON.stringify({
        status: "ok",
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        accuracy: position.coords.accuracy
      })),
      (error) => post(JSON.stringify({ status: "error", code: error.code }))
    );
  };
`;

try {
  const guest = host.createGuest({
    x: 0,
    y: 0,
    width: 390,
    height: 640,
    url: `http://127.0.0.1:${server.port}/`,
    bridgeScript,
  });
  const documentReady = new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("guest load timed out")),
      10_000,
    );
    guest.onEvent((event) => {
      if (event.type === "document") {
        clearTimeout(timeout);
        resolve(event.generation);
      } else if (event.type === "load-error") {
        clearTimeout(timeout);
        reject(new Error(`guest load failed: ${event.code}`));
      }
    });
  });
  const generation = await documentReady;
  let invalidLocationRejected = false;
  try {
    guest.setGeolocationOverride({ latitude: 91, longitude: 0, accuracy: 1 });
  } catch {
    invalidLocationRejected = true;
  }
  if (!invalidLocationRejected)
    throw new Error("out-of-range mock location was accepted");
  guest.setGeolocationOverride({
    latitude: 37.7749,
    longitude: -122.4194,
    accuracy: 12,
  });
  // The native API acknowledges task queueing; allow CEF's UI thread to apply
  // the protocol command before asking the page for its current position.
  await Bun.sleep(250);
  const readPosition = (documentGeneration: number) => {
    const result = new Promise<{
      status: string;
      latitude?: number;
      longitude?: number;
      accuracy?: number;
      code?: number;
    }>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("geolocation result timed out")),
        10_000,
      );
      guest.onMessage(({ data }) => {
        try {
          const parsed = JSON.parse(data) as {
            status: string;
            latitude?: number;
            longitude?: number;
            accuracy?: number;
            code?: number;
          };
          clearTimeout(timeout);
          resolve(parsed);
        } catch {
          // Ignore unrelated page messages.
        }
      });
    });
    if (!guest.post(documentGeneration, "read-location"))
      throw new Error(
        `guest generation became stale (event=${documentGeneration}, current=${guest.generation})`,
      );
    return result;
  };
  const position = await readPosition(generation);
  const passed =
    position.status === "ok" &&
    position.latitude === 37.7749 &&
    position.longitude === -122.4194 &&
    position.accuracy === 12;
  console.log(
    JSON.stringify(
      {
        gate: passed
          ? "GEOLOCATION_OVERRIDE:PASS"
          : "GEOLOCATION_OVERRIDE:FAIL",
        position,
      },
      null,
      2,
    ),
  );
  if (!passed) process.exitCode = 1;
  let resolveCrossOrigin:
    | ((result: { status: string; code?: number }) => void)
    | undefined;
  const crossOriginResult = new Promise<{ status: string; code?: number }>(
    (resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("cross-origin geolocation result timed out")),
        10_000,
      );
      resolveCrossOrigin = (result) => {
        clearTimeout(timeout);
        resolve(result);
      };
      guest.onMessage(({ data }) => {
        if (data === "pending") return;
        try {
          resolveCrossOrigin?.(
            JSON.parse(data) as { status: string; code?: number },
          );
        } catch {
          // Ignore unrelated page messages.
        }
      });
    },
  );
  if (!guest.post(generation, "cross-origin-permission"))
    throw new Error("guest generation became stale before permission test");
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (!guest.post(generation, "read-cross-origin-result")) break;
    await Bun.sleep(100);
  }
  const crossOrigin = await crossOriginResult;
  const crossOriginDenied =
    crossOrigin.status === "error" && crossOrigin.code === 1;
  console.log(
    JSON.stringify(
      {
        gate: crossOriginDenied
          ? "GEOLOCATION_CROSS_ORIGIN_DENIED:PASS"
          : "GEOLOCATION_CROSS_ORIGIN_DENIED:FAIL",
        result: crossOrigin,
      },
      null,
      2,
    ),
  );
  if (!crossOriginDenied) process.exitCode = 1;
  const reloaded = new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("guest reload timed out")),
      10_000,
    );
    guest.onEvent((event) => {
      if (event.type === "document" && event.generation > generation) {
        clearTimeout(timeout);
        resolve(event.generation);
      }
    });
  });
  guest.reload();
  const reloadGeneration = await reloaded;
  await Bun.sleep(250);
  const afterReload = await readPosition(reloadGeneration);
  const reloadPassed =
    afterReload.status === "ok" &&
    afterReload.latitude === 37.7749 &&
    afterReload.longitude === -122.4194 &&
    afterReload.accuracy === 12;
  console.log(
    JSON.stringify(
      {
        gate: reloadPassed
          ? "GEOLOCATION_RELOAD:PASS"
          : "GEOLOCATION_RELOAD:FAIL",
        position: afterReload,
      },
      null,
      2,
    ),
  );
  if (!reloadPassed) process.exitCode = 1;
  const crashed = new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("guest renderer crash event timed out")),
      10_000,
    );
    guest.onEvent((event) => {
      if (event.type === "crashed") {
        clearTimeout(timeout);
        resolve(event.generation);
      }
    });
  });
  // CEF's documented crash test URL terminates only this Guest's renderer.
  // Recovery then uses the public navigation path and verifies the mock is
  // still scoped to the same Guest after a fresh document is created.
  guest.navigate("chrome://crash/");
  const crashedGeneration = await crashed;
  const recovered = new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("guest did not recover after renderer crash")),
      10_000,
    );
    guest.onEvent((event) => {
      if (event.type === "document" && event.generation > crashedGeneration) {
        clearTimeout(timeout);
        resolve(event.generation);
      }
    });
  });
  guest.navigate(`http://127.0.0.1:${server.port}/`);
  const recoveredGeneration = await recovered;
  await Bun.sleep(250);
  const afterCrash = await readPosition(recoveredGeneration);
  const crashRecoveryPassed =
    afterCrash.status === "ok" &&
    afterCrash.latitude === 37.7749 &&
    afterCrash.longitude === -122.4194 &&
    afterCrash.accuracy === 12;
  console.log(
    JSON.stringify(
      {
        gate: crashRecoveryPassed
          ? "GEOLOCATION_CRASH_RECOVERY:PASS"
          : "GEOLOCATION_CRASH_RECOVERY:FAIL",
        crashedGeneration,
        recoveredGeneration,
        position: afterCrash,
      },
      null,
      2,
    ),
  );
  if (!crashRecoveryPassed) process.exitCode = 1;
  const isolatedGuest = host.createGuest({
    x: 400,
    y: 0,
    width: 390,
    height: 640,
    url: `http://127.0.0.1:${server.port}/`,
    bridgeScript,
  });
  const isolatedGeneration = await new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("isolated guest document timed out")),
      10_000,
    );
    isolatedGuest.onEvent((event) => {
      if (event.type === "document") {
        clearTimeout(timeout);
        resolve(event.generation);
      }
    });
  });
  const isolatedResult = new Promise<{ status: string; latitude?: number }>(
    (resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("isolated guest location timed out")),
        10_000,
      );
      isolatedGuest.onMessage(({ data }) => {
        try {
          clearTimeout(timeout);
          resolve(JSON.parse(data) as { status: string; latitude?: number });
        } catch {
          // Ignore unrelated page messages.
        }
      });
    },
  );
  if (!isolatedGuest.post(isolatedGeneration, "read-location"))
    throw new Error("isolated guest generation became stale");
  const isolatedPosition = await isolatedResult;
  const isolatedPassed =
    isolatedPosition.status !== "ok" || isolatedPosition.latitude !== 37.7749;
  console.log(
    JSON.stringify(
      {
        gate: isolatedPassed
          ? "GEOLOCATION_GUEST_ISOLATION:PASS"
          : "GEOLOCATION_GUEST_ISOLATION:FAIL",
        position: isolatedPosition,
      },
      null,
      2,
    ),
  );
  if (!isolatedPassed) process.exitCode = 1;
  isolatedGuest.dispose();
  guest.clearGeolocationOverride();
  await Bun.sleep(250);
  const afterClear = await readPosition(recoveredGeneration);
  const clearPassed = afterClear.status === "error" && afterClear.code === 1;
  console.log(
    JSON.stringify(
      {
        gate: clearPassed
          ? "GEOLOCATION_CLEAR_PERMISSION:PASS"
          : "GEOLOCATION_CLEAR_PERMISSION:FAIL",
        result: afterClear,
      },
      null,
      2,
    ),
  );
  if (!clearPassed) process.exitCode = 1;
  guest.dispose();
} finally {
  host.close();
  server.stop();
  app.shutdown();
}
