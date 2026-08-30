#!/usr/bin/env bun
// Core benchmark harness: spawns one app (bunium or electron, minimal or
// mini-app), parses its "BENCH: <name> <epoch_ms>" milestone lines off
// stdout for startup timing, then samples RSS + CPU% across its *entire*
// process tree (CEF/Chromium both fan out into renderer/gpu/network/utility
// helper processes -- a single-PID sample would undercount real footprint)
// during a settle window, and finally SIGTERMs it. Prints one JSON object
// per run to stdout; scripts/report.ts aggregates N runs into the table.
import { spawn } from "node:child_process";

interface RunResult {
  label: string;
  ms_process_start_to_created: number | null;
  ms_process_start_to_paint: number | null;
  ms_created_to_paint: number | null;
  rss_mb: number;
  cpu_percent: number;
  process_count: number;
  ipc_rtt_ms: number[];
  extra: Record<string, number[]>;
}

// Windows has no `ps` -- PowerShell's CIM process class is the equivalent
// (ProcessId/ParentProcessId columns, tab-separated for easy parsing).
// UNVERIFIED on real Windows (no Windows machine in this dev environment,
// same posture as packaging/win/cef-trim.sh and the win32-x64 release job --
// see PLAN.md) -- test this for real before trusting it on that platform.
const WIN_DESCENDANTS_CMD = [
  "powershell",
  "-NoProfile",
  "-Command",
  "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ForEach-Object { \"$($_.ProcessId)`t$($_.ParentProcessId)\" }",
];

function descendants(rootPid: number): number[] {
  const out =
    process.platform === "win32"
      ? Bun.spawnSync(WIN_DESCENDANTS_CMD)
      : Bun.spawnSync(["ps", "-axo", "pid=,ppid="]);
  const lines = out.stdout.toString().trim().split("\n");
  const childrenOf = new Map<number, number[]>();
  const sep = process.platform === "win32" ? /\t/ : /\s+/;
  for (const line of lines) {
    const [pid, ppid] = line.trim().split(sep).map(Number);
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
  // ps "time=" format: [[DD-]HH:]MM:SS[.ss]
  const parts = t.split(":").map(Number);
  let seconds = 0;
  if (parts.length === 3) {
    seconds = parts[0]! * 3600 + parts[1]! * 60 + parts[2]!;
  } else if (parts.length === 2) {
    seconds = parts[0]! * 60 + parts[1]!;
  } else {
    seconds = parts[0] ?? 0;
  }
  return seconds;
}

// Same UNVERIFIED-on-real-Windows caveat as descendants() above.
// Get-Process's `CPU` property is already total processor seconds (a
// double) -- no HH:MM:SS parsing needed, unlike ps's `time=`.
// WorkingSet64 is bytes, converted to KB to match ps's `rss=` (KB) unit.
function winSampleTree(pids: number[]): { rssKb: number; cpuSec: number } {
  const idList = pids.join(",");
  const cmd = [
    "powershell",
    "-NoProfile",
    "-Command",
    `Get-Process -Id ${idList} -ErrorAction SilentlyContinue | ForEach-Object { "$($_.WorkingSet64)\`t$($_.CPU)" }`,
  ];
  const out = Bun.spawnSync(cmd);
  let rssKb = 0;
  let cpuSec = 0;
  for (const line of out.stdout.toString().trim().split("\n")) {
    if (!line.trim()) continue;
    const [ws, cpu] = line.trim().split(/\t/);
    if (ws === undefined || cpu === undefined) continue;
    rssKb += Number(ws) / 1024;
    cpuSec += Number(cpu) || 0;
  }
  return { rssKb, cpuSec };
}

function sampleTree(pids: number[]): { rssKb: number; cpuSec: number } {
  if (pids.length === 0) return { rssKb: 0, cpuSec: 0 };
  if (process.platform === "win32") return winSampleTree(pids);
  const out = Bun.spawnSync([
    "ps",
    "-o",
    "pid=,rss=,time=",
    "-p",
    pids.join(","),
  ]);
  let rssKb = 0;
  let cpuSec = 0;
  for (const line of out.stdout.toString().trim().split("\n")) {
    if (!line.trim()) continue;
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+([\d:.]+)$/);
    if (!m) continue;
    rssKb += Number(m[2]);
    cpuSec += parseCpuTime(m[3]!);
  }
  return { rssKb, cpuSec };
}

export async function runOnce(opts: {
  label: string;
  cmd: string[];
  cwd: string;
  idleSeconds?: number;
  env?: Record<string, string>;
}): Promise<RunResult> {
  const idleSeconds = opts.idleSeconds ?? 5;
  const child = spawn(opts.cmd[0]!, opts.cmd.slice(1), {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
  });

  const milestones: Record<string, number> = {};
  const ipcRtt: number[] = [];
  const extra: Record<string, number[]> = {};
  let buf = "";
  const onData = (chunk: Buffer) => {
    buf += chunk.toString();
    let idx: number;
    // biome-ignore lint: simple line-buffered parse loop
    while ((idx = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      const m = line.match(/BENCH:\s+(\S+)\s+([\d.]+)/);
      if (!m) continue;
      const [, name, valueStr] = m;
      const value = Number(valueStr);
      if (name === "ipc_rtt_ms") ipcRtt.push(value);
      else if (name === "process_start" || name === "created" || name === "paint") {
        milestones[name!] = value;
      } else {
        (extra[name!] ?? (extra[name!] = [])).push(value);
      }
    }
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);

  const paintDeadline = Date.now() + 20000;
  while (milestones.paint === undefined && Date.now() < paintDeadline) {
    await Bun.sleep(20);
  }

  await Bun.sleep(idleSeconds * 1000);
  const pids = child.pid ? descendants(child.pid) : [];
  const { rssKb, cpuSec } = sampleTree(pids);
  await Bun.sleep(2000);
  const { cpuSec: cpuSec2 } = sampleTree(pids);
  const cpuPercent = ((cpuSec2 - cpuSec) / 2) * 100;

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

  return {
    label: opts.label,
    ms_process_start_to_created:
      milestones.process_start !== undefined && milestones.created !== undefined
        ? milestones.created - milestones.process_start
        : null,
    ms_process_start_to_paint:
      milestones.process_start !== undefined && milestones.paint !== undefined
        ? milestones.paint - milestones.process_start
        : null,
    ms_created_to_paint:
      milestones.created !== undefined && milestones.paint !== undefined
        ? milestones.paint - milestones.created
        : null,
    rss_mb: rssKb / 1024,
    cpu_percent: cpuPercent,
    process_count: pids.length,
    ipc_rtt_ms: ipcRtt,
    extra,
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const label = args[0]!;
  const cwd = args[1]!;
  const cmd = args.slice(2);
  const result = await runOnce({ label, cwd, cmd });
  console.log(JSON.stringify(result, null, 2));
}
