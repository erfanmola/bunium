// Phase 9: headless verification of the packaged-app restart shim
// (buildRelaunchCommand in src/relaunch.ts).
//
// relaunchApp() itself can't run here -- it shuts down CEF (a live-window
// app) and exits the process. What IS testable headlessly is the shim's
// contract, which is the entire non-trivial part:
//   1. Spawned against a live parent PID, the shim must NOT exec its target
//      until that PID dies (the CEF ProcessSingleton handoff requirement --
//      starting the child early aborts the new browser).
//   2. Spawned against an already-dead PID, it execs immediately.
//   3. The exec'd command receives the exact argv given to the shim (the
//      launcher will exec bun + main.ts + original args; here a `sh` echo
//      target proves argv fidelity, including args containing spaces).
//
// Exit codes: 0 = PASS, 1 = FAIL. No CEF, so headless-safe; matches
// bsdiff-test.ts / update-e2e-test.ts.

import { buildRelaunchCommand } from "../src/relaunch";

let failures = 0;

function check(cond: boolean, label: string): void {
  if (cond) {
    console.log(`ok: ${label}`);
  } else {
    console.error(`FAIL: ${label}`);
    failures++;
  }
}

/** Runs the command with captured stdout; resolves text when it finishes. */
async function run(
  cmd: string[],
): Promise<{ text: string; elapsedMs: number }> {
  const t0 = performance.now();
  const proc = Bun.spawn(cmd, {
    stdio: ["ignore", "pipe", "pipe"] as const,
  });
  const text = await new Response(proc.stdout).text();
  await proc.exited;
  return { text, elapsedMs: performance.now() - t0 };
}

// --- 1. live parent: shim must wait for death, then exec with argv intact ---
{
  const parent = Bun.spawn(["sh", "-c", "sleep 0.7"], {
    stdio: ["ignore", "ignore", "ignore"] as const,
  });
  const target = [
    "sh",
    "-c",
    'echo RELAUNCH_OK; for a in "$@"; do echo "arg:$a"; done',
    "expect",
    "alpha",
    "beta two",
  ];
  const { text, elapsedMs } = await run(
    buildRelaunchCommand(parent.pid, target, 100),
  );
  await parent.exited;

  const lines = text.trim().split("\n");
  check(
    lines[0] === "RELAUNCH_OK" &&
      lines.includes("arg:alpha") &&
      lines.includes("arg:beta two"),
    "target exec'd with argv intact (incl. space-containing arg)",
  );
  check(
    elapsedMs >= 600,
    `shim waited for parent exit (elapsed ${Math.round(elapsedMs)}ms >= 600ms)`,
  );
  check(
    elapsedMs < 5000,
    `shim did not hang (elapsed ${Math.round(elapsedMs)}ms < 5000ms)`,
  );
}

// --- 2. already-dead parent: exec proceeds immediately ---
{
  // A fresh `sh -c "exit 0"` gives a pid that is guaranteed dead by the time
  // the shim first polls it. (The PID-reuse footgun -- the OS handing the
  // recycled pid to the shim itself, which would make `kill -0` succeed
  // forever -- is avoided only probabilistically here, which is acceptable
  // for a test: reuse within the sub-50ms window is not practical.)
  const dead = Bun.spawn(["sh", "-c", "exit 0"], {
    stdio: ["ignore", "ignore", "ignore"] as const,
  });
  await dead.exited;
  const { text, elapsedMs } = await run(
    buildRelaunchCommand(dead.pid, ["sh", "-c", "echo IMMEDIATE"], 50),
  );
  check(text.trim() === "IMMEDIATE", "dead-parent shim execs immediately");
  check(
    elapsedMs < 1000,
    `dead-parent shim did not wait (elapsed ${Math.round(elapsedMs)}ms < 1000ms)`,
  );
}

console.log(failures === 0 ? "PASS" : `FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
