#!/usr/bin/env bun
import { mkdirSync, writeFileSync } from "node:fs";
// Runs each benchmark scenario N times (sequentially -- CEF's
// ProcessSingleton rule applies to the bunium scenarios, and running
// Electron concurrently alongside would skew the CPU/RSS numbers anyway),
// takes the median of each numeric field, and writes both raw JSON and a
// markdown table to benchmark/results/.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { runOnce } from "./bench";

const REPS = Number(process.env.BENCH_REPS ?? 3);
const IDLE_SECONDS = Number(process.env.BENCH_IDLE_SECONDS ?? 6);

// `new URL(...).pathname` yields a POSIX-style path (leading `/`,
// %-encoded spaces) even on Windows -- passing that straight to
// child_process.spawn's `cwd` breaks Windows' CreateProcess PATH search
// entirely (even a plain `bun` on PATH fails to resolve with ENOENT).
// fileURLToPath gives the real platform-native path (`C:\...`, decoded).
const REPO = fileURLToPath(new URL("../..", import.meta.url));

// Warns (doesn't block) if the platform's compiled native/build*/
// bunium_shim.* predates its own sources -- exactly the bug found while
// re-verifying the IPC-latency wake-socket fix on Linux (2026-08-31, see
// benchmark/RESULTS.md): a stale checked-in-or-cached .so silently ran
// old native code under an otherwise-clean benchmark run. That incident
// happened to fail loudly (a missing FFI symbol crashed the process); a
// signature-compatible but behaviorally-stale rebuild would not have.
function warnIfNativeStale(): void {
  const platform =
    process.platform === "darwin"
      ? "mac"
      : process.platform === "win32"
        ? "win"
        : "linux";
  // Windows' uv_spawn can't exec a .sh shebang script directly (EFTYPE) --
  // needs bash explicitly, unlike mac/Linux where the shebang line alone
  // is enough.
  const result = Bun.spawnSync(
    process.platform === "win32"
      ? ["bash", `${REPO}scripts/check-native-freshness.sh`, platform]
      : [`${REPO}scripts/check-native-freshness.sh`, platform],
  );
  if (result.exitCode !== 0) {
    console.error(result.stdout.toString());
    console.error(result.stderr.toString());
    console.error(
      `WARNING: native build for ${platform} may be stale -- benchmark numbers below may not reflect the current source tree. Run \`bun run check:native:${platform} -- --fix\` or rebuild manually.`,
    );
  }
}
warnIfNativeStale();

interface Scenario {
  label: string;
  cwd: string;
  cmd: string[];
}

// The `electron` npm package's main export is a string: the path to the
// real platform-specific binary (.exe on Windows, no `.bin/electron` shim
// involved) -- this is the documented cross-platform way to launch it
// from another Node/Bun process, and avoids Windows needing `shell: true`
// to run a `.bin/electron.cmd` shim.
function resolveElectronBinary(cwd: string): string {
  const require = createRequire(`${cwd}/`);
  return require("electron") as unknown as string;
}

const scenarios: Scenario[] = [
  {
    label: "bunium-minimal",
    cwd: `${REPO}benchmark/bunium-minimal`,
    cmd: ["bun", "run", "main.ts"],
  },
  {
    label: "electron-minimal",
    cwd: `${REPO}benchmark/electron-minimal`,
    cmd: [resolveElectronBinary(`${REPO}benchmark/electron-minimal`), "."],
  },
  {
    label: "bunium-mini-app",
    cwd: `${REPO}benchmark/bunium-mini-app`,
    cmd: ["bun", "run", "main.ts"],
  },
  {
    label: "electron-mini-app",
    cwd: `${REPO}benchmark/electron-mini-app`,
    cmd: [resolveElectronBinary(`${REPO}benchmark/electron-mini-app`), "."],
  },
];

function median(nums: number[]): number | null {
  const clean = nums.filter((n): n is number => n !== null && !Number.isNaN(n));
  if (clean.length === 0) return null;
  const sorted = [...clean].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
}

const allResults: Record<string, unknown>[] = [];
const summaries: Record<string, Record<string, number | null>> = {};

for (const scenario of scenarios) {
  console.log(`\n=== ${scenario.label} (${REPS} reps) ===`);
  const runs = [];
  for (let i = 0; i < REPS; i++) {
    const r = await runOnce({
      label: scenario.label,
      cwd: scenario.cwd,
      cmd: scenario.cmd,
      idleSeconds: IDLE_SECONDS,
    });
    console.log(`  rep ${i + 1}:`, JSON.stringify(r));
    runs.push(r);
    allResults.push({ ...r, rep: i + 1 });
    // Let the previous process's helper tree fully tear down before the
    // next launch -- avoids ProcessSingleton contention / RSS sampling a
    // straggler from the prior run.
    await Bun.sleep(2000);
  }

  summaries[scenario.label] = {
    ms_process_start_to_paint: median(
      runs
        .map((r) => r.ms_process_start_to_paint)
        .filter((x): x is number => x !== null),
    ),
    rss_mb: median(runs.map((r) => r.rss_mb)),
    cpu_percent: median(runs.map((r) => r.cpu_percent)),
    process_count: median(runs.map((r) => r.process_count)),
    mini_app_render_ms: median(
      runs.flatMap((r) => r.extra.mini_app_render_ms ?? []),
    ),
    ipc_avg_rtt_ms: median(runs.flatMap((r) => r.ipc_rtt_ms)),
  };
}

mkdirSync(`${REPO}benchmark/results`, { recursive: true });
writeFileSync(
  `${REPO}benchmark/results/raw.json`,
  JSON.stringify(allResults, null, 2),
);
writeFileSync(
  `${REPO}benchmark/results/summary.json`,
  JSON.stringify(summaries, null, 2),
);
console.log("\n=== SUMMARY (median of", REPS, "reps) ===");
console.log(JSON.stringify(summaries, null, 2));
