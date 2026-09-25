import { BuniumWindow, trustedOriginsApiVersion } from "bunium";

const trustedName = "fixture-trusted-origin";
const untrustedName = "fixture-untrusted-origin";
const subframeAttemptName = "fixture-subframe-attempted";
const subframeExploitName = "fixture-subframe-exploit";
const untrustedAttemptPath = "/untrusted-attempted";
const subframeAttemptPath = "/subframe-attempted";

/**
 * Runs inside the packaged fixture so the checked JS export and packaged
 * native shim are exercised together. The local server stays in-process;
 * the second hostname gives the negative case a genuinely different origin.
 */
export async function verifyTrustedOriginBridge(): Promise<boolean> {
  if (trustedOriginsApiVersion !== 1) {
    console.error(
      `TRUSTED_ORIGIN_VERIFY:FAIL (JS capability version ${trustedOriginsApiVersion})`,
    );
    return false;
  }

  const requests = new Set<string>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      requests.add(path);
      if (path === untrustedAttemptPath || path === subframeAttemptPath) {
        return new Response("ok");
      }
      if (path === "/child") {
        return new Response(
          `<script>parent.__bunium.send("${subframeExploitName}",JSON.stringify("blocked"))</script>`,
          { headers: { "content-type": "text/html" } },
        );
      }

      const script =
        path === "/untrusted"
          ? `window.__bunium?.send("${untrustedName}",JSON.stringify("leaked"));fetch("${untrustedAttemptPath}")`
          : `window.__bunium?.send("${trustedName}",JSON.stringify("ok"));setTimeout(()=>{const f=document.createElement("iframe");f.src="/child";document.body.append(f);setTimeout(()=>{window.__bunium.send("${subframeAttemptName}",JSON.stringify("attempted"));fetch("${subframeAttemptPath}")},750)},200)`;

      return new Response(`<script>${script}</script>`, {
        headers: { "content-type": "text/html" },
      });
    },
  });

  const trustedOrigin = server.url.origin;
  const messages = new Set<string>();
  let trustedWindow: BuniumWindow | undefined;
  let untrustedWindow: BuniumWindow | undefined;

  try {
    trustedWindow = new BuniumWindow({
      url: `${trustedOrigin}/trusted`,
      trustedOrigins: [trustedOrigin],
      width: 320,
      height: 240,
      title: "trusted origin fixture",
    });
    trustedWindow.on(trustedName, (payload) =>
      messages.add(`${trustedName}:${payload}`),
    );
    trustedWindow.on(subframeAttemptName, (payload) =>
      messages.add(`${subframeAttemptName}:${payload}`),
    );
    trustedWindow.on(subframeExploitName, (payload) =>
      messages.add(`${subframeExploitName}:${payload}`),
    );

    untrustedWindow = new BuniumWindow({
      // Same server and port, different hostname: same-origin policy treats
      // localhost and 127.0.0.1 as different origins.
      url: `http://localhost:${server.port}/untrusted`,
      trustedOrigins: [trustedOrigin],
      width: 320,
      height: 240,
      title: "untrusted origin fixture",
    });
    untrustedWindow.on(untrustedName, (payload) =>
      messages.add(`${untrustedName}:${payload}`),
    );

    const deadline = Date.now() + 8000;
    while (
      Date.now() < deadline &&
      (!messages.has(`${trustedName}:ok`) ||
        !messages.has(`${subframeAttemptName}:attempted`) ||
        !requests.has(untrustedAttemptPath) ||
        !requests.has(subframeAttemptPath))
    ) {
      await Bun.sleep(50);
    }
    // Let native IPC from the completed page attempts reach the host before
    // asserting that denied origins and subframes delivered no messages.
    await Bun.sleep(750);

    const passed =
      messages.has(`${trustedName}:ok`) &&
      messages.has(`${subframeAttemptName}:attempted`) &&
      requests.has("/trusted") &&
      requests.has("/untrusted") &&
      requests.has(untrustedAttemptPath) &&
      requests.has(subframeAttemptPath) &&
      !requests.has("/child") &&
      !messages.has(`${untrustedName}:leaked`) &&
      !messages.has(`${subframeExploitName}:blocked`);

    console.log(
      `TRUSTED_ORIGIN_VERIFY:${passed ? "PASS" : "FAIL"} (api=${trustedOriginsApiVersion}; requests=${[...requests].join(",")}; messages=${[...messages].join(",")})`,
    );
    return passed;
  } catch (error) {
    console.error("TRUSTED_ORIGIN_VERIFY:FAIL", error);
    return false;
  } finally {
    trustedWindow?.close();
    untrustedWindow?.close();
    server.stop();
  }
}
