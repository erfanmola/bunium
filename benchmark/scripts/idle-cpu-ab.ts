#!/usr/bin/env bun
// Reusable idle-CPU A/B harness: launches benchmark/scripts/idle-cpu-longrun.ts
// twice (once plain, once with a BUNIUM_CEF_SWITCHES override below) and
// diffs ps-reported CPU time over a t=10-40s window -- long enough to clear
// the known ~3-4s delayed-onset behavior (see benchmark/RESULTS.md's idle-CPU
// section). Edit the env/label below to test a different candidate switch.
import { spawn } from "node:child_process";

function descendants(rootPid: number): number[] {
  const out = Bun.spawnSync(["ps", "-axo", "pid=,ppid="]);
  const lines = out.stdout.toString().trim().split("\n");
  const childrenOf = new Map<number, number[]>();
  for (const line of lines) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (pid === undefined || ppid === undefined) continue;
    (childrenOf.get(ppid) ?? childrenOf.set(ppid, []).get(ppid)!).push(pid);
  }
  const all: number[] = [rootPid];
  const queue = [rootPid];
  while (queue.length) {
    const p = queue.pop()!;
    for (const c of childrenOf.get(p) ?? []) {
      all.push(c);
      queue.push(c);
    }
  }
  return all;
}

function parseCpuTime(t: string): number {
  const parts = t.split(":").map(Number);
  if (parts.length === 3) return parts[0]! * 3600 + parts[1]! * 60 + parts[2]!;
  if (parts.length === 2) return parts[0]! * 60 + parts[1]!;
  return parts[0] ?? 0;
}

function snapshot(rootPid: number): { cpuSec: number; raw: string; n: number } {
  const pids = descendants(rootPid);
  const out = Bun.spawnSync(["ps", "-o", "pid=,rss=,time=,comm=", "-p", pids.join(",")]);
  let cpuSec = 0;
  let n = 0;
  const raw = out.stdout.toString().trim();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+([\d:.]+)\s+(.*)$/);
    if (!m) continue;
    cpuSec += parseCpuTime(m[3]!);
    n++;
  }
  return { cpuSec, raw, n };
}

async function run(label: string, env?: Record<string, string>) {
  console.log(`\n=== ${label} ===`);
  const cwd = new URL("../..", import.meta.url).pathname;
  const child = spawn("bun", ["run", "benchmark/scripts/idle-cpu-longrun.ts"], {
    cwd,
    env: { ...process.env, ...env },
  });
  child.stdout.on("data", (d) => process.stdout.write(`[${label}] ${d}`));
  child.stderr.on("data", (d) => process.stderr.write(`[${label} stderr] ${d}`));

  await Bun.sleep(2000);
  if (!child.pid) throw new Error("no pid");

  await Bun.sleep(8000); // t=10s
  const s1 = snapshot(child.pid);

  await Bun.sleep(30000); // t=40s
  const s2 = snapshot(child.pid);
  console.log(`t=40s snapshot (n=${s2.n} procs):\n${s2.raw}`);

  const cpuPercent = ((s2.cpuSec - s1.cpuSec) / 30) * 100;
  console.log(`${label}: cpu_percent(t=10-40s) = ${cpuPercent.toFixed(1)}`);

  child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const t = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 5000);
    child.once("exit", () => {
      clearTimeout(t);
      resolve();
    });
  });
  return cpuPercent;
}

const baseline = await run("baseline");
await Bun.sleep(3000);
const withSwitch = await run("disable-hang-monitor", {
  BUNIUM_CEF_SWITCHES: "--disable-hang-monitor",
});

console.log("\n=== FINAL SUMMARY (t=10-40s window) ===");
console.log(`baseline:    ${baseline.toFixed(1)}%`);
console.log(`with switch: ${withSwitch.toFixed(1)}%`);
