#!/usr/bin/env bun
// Runs each benchmark scenario N times (sequentially -- CEF's
// ProcessSingleton rule applies to the bunium scenarios, and running
// Electron concurrently alongside would skew the CPU/RSS numbers anyway),
// takes the median of each numeric field, and writes both raw JSON and a
// markdown table to benchmark/results/.
import { mkdirSync, writeFileSync } from "node:fs";
import { runOnce } from "./bench";

const REPS = Number(process.env.BENCH_REPS ?? 3);
const IDLE_SECONDS = Number(process.env.BENCH_IDLE_SECONDS ?? 6);

const REPO = new URL("../..", import.meta.url).pathname;

interface Scenario {
  label: string;
  cwd: string;
  cmd: string[];
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
    cmd: ["./node_modules/.bin/electron", "."],
  },
  {
    label: "bunium-mini-app",
    cwd: `${REPO}benchmark/bunium-mini-app`,
    cmd: ["bun", "run", "main.ts"],
  },
  {
    label: "electron-mini-app",
    cwd: `${REPO}benchmark/electron-mini-app`,
    cmd: ["./node_modules/.bin/electron", "."],
  },
];

function median(nums: number[]): number | null {
  const clean = nums.filter((n): n is number => n !== null && !Number.isNaN(n));
  if (clean.length === 0) return null;
  const sorted = [...clean].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
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
      runs.map((r) => r.ms_process_start_to_paint).filter((x): x is number => x !== null),
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
