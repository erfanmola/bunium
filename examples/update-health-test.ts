// Headless verification of the update candidate health handshake and rollback.
// No CEF, network, signing credentials or installed user data is used.

import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acknowledgeUpdateHealthy,
  beginUpdateHealthCheck,
  repairInterruptedUpdate,
} from "../src/update";

const root = await mkdtemp(join(tmpdir(), "bunium-update-health-"));
let failures = 0;

function check(condition: boolean, label: string): void {
  if (condition) console.log(`ok: ${label}`);
  else {
    console.error(`FAIL: ${label}`);
    failures++;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function setup(name: string): Promise<string> {
  const install = join(root, name, "app");
  const backup = `${install}.backup`;
  await mkdir(install, { recursive: true });
  await mkdir(backup, { recursive: true });
  await writeFile(join(install, "version.txt"), "candidate\n");
  await writeFile(join(backup, "version.txt"), "known-good\n");
  await writeFile(
    `${install}.updating`,
    `${JSON.stringify({ phase: "awaiting-health" })}\n`,
  );
  return install;
}

try {
  // A first launch may complete health checks and commit the candidate.
  {
    const install = await setup("healthy");
    check(
      (await beginUpdateHealthCheck(install)) === "pending",
      "first candidate launch begins a health attempt",
    );
    check(
      (await readFile(join(`${install}.backup`, "version.txt"), "utf8")) ===
        "known-good\n",
      "known-good payload remains while health is pending",
    );
    check(
      await acknowledgeUpdateHealthy(install),
      "healthy candidate acknowledges and finalizes update",
    );
    check(
      !(await exists(`${install}.backup`)) &&
        !(await exists(`${install}.updating`)),
      "successful acknowledgment removes backup and journal",
    );
  }

  // A crash or failed boot leaves the attempt marker; the next launch restores
  // the old tree before opening windows.
  {
    const install = await setup("failed-health");
    check(
      (await beginUpdateHealthCheck(install)) === "pending",
      "failed candidate's first launch is marked",
    );
    check(
      (await beginUpdateHealthCheck(install)) === "pending",
      "repeated health-check call in the same process is idempotent",
    );
    const childScript = `
      const { beginUpdateHealthCheck } = await import(${JSON.stringify(new URL("../src/update.ts", import.meta.url).href)});
      console.log(await beginUpdateHealthCheck(process.env.INSTALL_DIR!));
    `;
    const child = Bun.spawn([process.execPath, "-e", childScript], {
      env: { ...process.env, INSTALL_DIR: install },
      stdout: "pipe",
      stderr: "pipe",
    });
    const childOutput = await new Response(child.stdout).text();
    const childExit = await child.exited;
    check(
      childExit === 0 && childOutput.trim() === "rolled-back",
      "unacknowledged candidate rolls back in a fresh process",
    );
    check(
      (await readFile(join(install, "version.txt"), "utf8")) === "known-good\n",
      "rollback restores the complete known-good tree",
    );
    check(
      !(await exists(`${install}.backup`)) &&
        !(await exists(`${install}.updating.attempted`)),
      "rollback removes pending metadata",
    );
  }

  // An interrupted rename before the health phase also prefers the old tree.
  {
    const install = await setup("interrupted-swap");
    await writeFile(
      `${install}.updating`,
      `${JSON.stringify({ phase: "swapping", staging: join(root, "lost") })}\n`,
    );
    const result = await repairInterruptedUpdate(install);
    check(result === "rolled-back", "interrupted swap restores old tree");
    check(
      (await readFile(join(install, "version.txt"), "utf8")) === "known-good\n",
      "interrupted swap keeps prior app bootable",
    );
  }

  // If journal contents are damaged after replacement, the retained backup is
  // still the safest bootable payload.
  {
    const install = await setup("corrupt-health-journal");
    await writeFile(`${install}.updating`, "{{ invalid\n");
    check(
      (await repairInterruptedUpdate(install)) === "rolled-back",
      "corrupt pending journal rolls back when a backup exists",
    );
    check(
      (await readFile(join(install, "version.txt"), "utf8")) === "known-good\n",
      "corrupt-journal rollback preserves bootability",
    );
  }

  {
    const install = await setup("corrupt-startup-journal");
    await writeFile(`${install}.updating`, "{{ invalid\n");
    check(
      (await beginUpdateHealthCheck(install)) === "rolled-back",
      "startup helper reports rollback for a corrupt pending journal",
    );
    check(
      (await readFile(join(install, "version.txt"), "utf8")) === "known-good\n",
      "startup rollback restores old tree before application startup",
    );
  }
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log(failures === 0 ? "PASS" : `FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
