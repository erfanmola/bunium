// Phase 9: packaged-app restart helper, paired with Updater.relaunch().
//
// An install swaps files inside the app's Resources/app tree; finishing the
// update means starting a fresh process that picks up the new code. The fresh
// invocation is identical to what the packaged launcher
// (packaging/mac/package.sh) originally ran -- a re-exec of
// `process.execPath` + `process.argv[1..]` -- so no launcher changes are
// needed for a restart to work: the child re-runs the same bun + main script,
// inherits the BUNIUM_* env vars, and the new Resources/app content is what
// gets loaded.
//
// The one constraint that makes this non-trivial: CEF's per-profile
// ProcessSingleton (PLAN.md testing footnote) aborts a second concurrent
// browser process. A naively-spawned child starts dlopen'ing CEF while the
// parent still holds the singleton, so a detached `sh` shim waits for the
// parent PID to disappear (i.e. CefShutdown has run and the process is truly
// gone) before exec'ing the app.
import { app } from "./app";

export interface RelaunchOptions {
  /** Replaces `process.argv.slice(1)` when provided (same shape: script
   *  path first, then any args the app was launched with). */
  args?: string[];
  /** Poll interval for the parent-exit wait, ms. Default 200. */
  pollIntervalMs?: number;
}

/**
 * Builds the detached restart command line. Pure function -- exported so the
 * wait-then-exec semantics are verifiable headlessly
 * (examples/relaunch-test.ts) without spawning a real bunium app.
 *
 * The shim: `kill -0` succeeds while the parent PID is alive, so the loop
 * sleeps and re-checks; once the PID is gone (or was never alive), it shifts
 * past the PID/interval args and execs the command, replacing the shim
 * process entirely. `kill` is a sh builtin, so no procps dependency. The
 * poll interval is passed in fractional-seconds form (`sleep` takes seconds;
 * a bare integer would mean seconds, not ms -- the ms values callers think
 * in would sleep that many *seconds* per poll). macOS/Linux /bin/sh `sleep`
 * both accept fractions.
 *
 * Windows exception: Git Bash's `kill -0` resolves MSYS PIDs, but callers
 * pass real Win32 PIDs (from Bun.spawn), so it would always say "dead" and
 * exec prematurely. Use PowerShell's Get-Process (Win32 PID namespace) for
 * the wait instead -- one invocation that polls internally with the same
 * millisecond interval.
 */
export function buildRelaunchCommand(
  parentPid: number,
  command: string[],
  pollIntervalMs = 200,
): string[] {
  if (process.platform === "win32") {
    const shim =
      'powershell -NoProfile -NonInteractive -Command "' +
      "while (Get-Process -Id $1 -ErrorAction SilentlyContinue) " +
      '{ Start-Sleep -Milliseconds $2 }"; shift 2; exec "$@"';
    return [
      "sh",
      "-c",
      shim,
      "bunium-relaunch",
      String(parentPid),
      String(Math.round(pollIntervalMs)),
      ...command,
    ];
  }
  const intervalSecs = (pollIntervalMs / 1000).toFixed(3);
  const shim =
    'while kill -0 "$1" 2>/dev/null; do sleep "$2"; done; shift 2; exec "$@"';
  return [
    "sh",
    "-c",
    shim,
    "bunium-relaunch",
    String(parentPid),
    intervalSecs,
    ...command,
  ];
}

/**
 * Shuts down CEF, then detaches a wait-for-exit shim that re-execs the same
 * bun + script invocation the packaged launcher used. Meant to be the
 * `relaunchApp` handler passed to `updater.relaunch(relaunchApp)` from the
 * app's `bunium/main.ts` on the updater's `ready` event:
 *
 *     updater.on("ready", () => updater.relaunch(relaunchApp));
 *
 * Never returns (exits the current process). Safe to call when the app was
 * never initialized -- `app.shutdown()` is a no-op then, and the shim simply
 * re-execs without waiting.
 */
export function relaunchApp(options: RelaunchOptions = {}): void {
  app.shutdown();
  const argv = options.args ?? process.argv.slice(1);
  const child = Bun.spawn(
    buildRelaunchCommand(
      process.pid,
      [process.execPath, ...argv],
      options.pollIntervalMs ?? 200,
    ),
    { detached: true, stdio: ["inherit", "inherit", "inherit"] as const },
  );
  child.unref?.();
  process.exit(0);
}
