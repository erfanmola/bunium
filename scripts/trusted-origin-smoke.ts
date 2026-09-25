import { BuniumWindow, trustedOriginsApiVersion } from "bunium";

const trustedName = "fixture-trusted-origin";
const untrustedName = "fixture-untrusted-origin";
const subframeAttemptName = "fixture-subframe-attempted";
const subframeExploitName = "fixture-subframe-exploit";

/** Exercise origin checks using the app's offline bunium:// scheme. */
export async function verifyTrustedOriginBridge(): Promise<boolean> {
  if (trustedOriginsApiVersion !== 1) {
    console.error(
      `TRUSTED_ORIGIN_VERIFY:FAIL (JS capability version ${trustedOriginsApiVersion})`,
    );
    return false;
  }

  const messages = new Set<string>();
  let trustedWindow: BuniumWindow | undefined;
  let untrustedWindow: BuniumWindow | undefined;
  let buniumPortRejected = false;

  try {
    try {
      const portWindow = new BuniumWindow({
        url: "bunium://app/",
        trustedOrigins: ["bunium://app:8484"],
        width: 100,
        height: 80,
      });
      portWindow.close();
    } catch (error) {
      buniumPortRejected = error instanceof TypeError;
    }

    trustedWindow = new BuniumWindow({
      url: "bunium://app/?trusted-origin-smoke=1",
      trustedOrigins: ["bunium://app"],
      width: 320,
      height: 240,
      title: "trusted origin fixture",
    });
    for (const name of [
      trustedName,
      subframeAttemptName,
      subframeExploitName,
    ]) {
      trustedWindow.on(name, (payload) => messages.add(`${name}:${payload}`));
    }

    untrustedWindow = new BuniumWindow({
      // An opaque data origin runs offline and cannot inherit the app origin.
      url: `data:text/html;charset=utf-8,${encodeURIComponent(
        `<!doctype html><html><body style="margin:0"><script>window.__bunium?.send("${untrustedName}",JSON.stringify("leaked"));document.body.style.background="magenta"</script></body></html>`,
      )}`,
      trustedOrigins: ["bunium://app"],
      width: 320,
      height: 240,
      title: "untrusted origin fixture",
    });
    untrustedWindow.on(untrustedName, (payload) =>
      messages.add(`${untrustedName}:${payload}`),
    );

    let untrustedPageRan = false;
    const deadline = Date.now() + 8000;
    while (
      Date.now() < deadline &&
      (!messages.has(`${trustedName}:ok`) ||
        !messages.has(`${subframeAttemptName}:blocked`) ||
        untrustedWindow.frameCount < 1)
    ) {
      if (untrustedWindow.frameCount > 0) {
        const shot = untrustedWindow.captureScreenshot();
        const idx =
          (Math.floor(shot.height / 2) * shot.width +
            Math.floor(shot.width / 2)) *
          4;
        const b = shot.data[idx]!;
        const g = shot.data[idx + 1]!;
        const r = shot.data[idx + 2]!;
        untrustedPageRan = r > 235 && g < 20 && b > 235;
      }
      await Bun.sleep(50);
    }

    // Allow renderer IPC to drain after the page and frame attempts finish.
    await Bun.sleep(500);
    const passed =
      messages.has(`${trustedName}:ok`) &&
      messages.has(`${subframeAttemptName}:blocked`) &&
      untrustedPageRan &&
      buniumPortRejected &&
      !messages.has(`${untrustedName}:leaked`) &&
      !messages.has(`${subframeExploitName}:blocked`);
    console.log(
      `TRUSTED_ORIGIN_VERIFY:${passed ? "PASS" : "FAIL"} (api=${trustedOriginsApiVersion}; untrustedPageRan=${untrustedPageRan}; buniumPortRejected=${buniumPortRejected}; messages=${[...messages].join(",")})`,
    );
    return passed;
  } catch (error) {
    console.error("TRUSTED_ORIGIN_VERIFY:FAIL", error);
    return false;
  } finally {
    trustedWindow?.close();
    untrustedWindow?.close();
  }
}
