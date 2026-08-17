// Phase 9: swap-crash journal self-repair verification.
//
// `updater.install()` swaps the install dir via two renames (install -> backup,
// staging -> install), journaled via `<installDir>.updating`. If the process
// dies between them, the next launch must detect and resolve the interrupted
// swap. This test simulates every intermediate crash state on disk and asserts
// `repairInterruptedUpdate()` resolves each one correctly:
//
//   1. Roll forward   — crash between the two renames: install missing,
//                       staged (new) tree + backup (old) present.
//   2. Roll forward   — crash before the first rename: install (old) still
//                       present, staged (new) tree present.
//   3. Roll forward   — crash after the second rename, before cleanup: install
//                       is the new tree, old backup still present.
//   4. Roll back      — staging lost, backup (old) present, install missing.
//   5. Unreadable journal + backup present -> roll back (no staging to trust).
//   6. No journal     — untouched, "none".
//
// Exit codes: 0 = PASS, 1 = FAIL. Headless (no CEF, no network), like
// update-e2e-test.ts.

import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repairInterruptedUpdate } from "../src/update";

const base = await mkdtemp(join(tmpdir(), "bunium-update-journal-"));
let failures = 0;

function check(cond: boolean, label: string): void {
  if (cond) {
    console.log(`ok: ${label}`);
  } else {
    console.error(`FAIL: ${label}`);
    failures++;
  }
}

async function marker(p: string): Promise<string> {
  try {
    return await readFile(p, "utf8");
  } catch {
    return "<missing>";
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** `installDir` name is fixed per case so `.backup`/`.updating` derive from it. */
interface Case {
  label: string;
  install: string | null; // null = absent (already renamed away)
  staging: string | null; // null = absent (lost)
  backup: string | null;
  journal: string | null; // null = absent; content overrides staging path
  expect: "repaired" | "rolled-back" | "none";
  expectMarker: string; // expected install marker after repair
}

const cases: Case[] = [
  {
    label: "crash between renames -> roll forward",
    install: null,
    staging: "NEW",
    backup: "OLD",
    journal: "NEW",
    expect: "repaired",
    expectMarker: "NEW",
  },
  {
    label: "crash before first rename -> roll forward",
    install: "OLD",
    staging: "NEW",
    backup: null,
    journal: "NEW",
    expect: "repaired",
    expectMarker: "NEW",
  },
  {
    label: "crash after second rename (pre-cleanup) -> already live",
    install: "NEW",
    staging: null,
    backup: "OLD",
    journal: "NEW",
    expect: "repaired",
    expectMarker: "NEW",
  },
  {
    label: "staging lost -> roll back to old install",
    install: null,
    staging: null,
    backup: "OLD",
    journal: "NEW",
    expect: "rolled-back",
    expectMarker: "OLD",
  },
  {
    label: "unreadable journal + backup -> roll back",
    install: null,
    staging: null,
    backup: "OLD",
    journal: "CORRUPT",
    expect: "rolled-back",
    expectMarker: "OLD",
  },
  {
    label: "no journal -> untouched",
    install: "OLD",
    staging: null,
    backup: null,
    journal: null,
    expect: "none",
    expectMarker: "OLD",
  },
];

for (const [i, c] of cases.entries()) {
  const dir = join(base, `case-${i}`);
  const installDir = join(dir, "app");
  const backup = `${installDir}.backup`;
  const journal = `${installDir}.updating`;
  const staging = join(dir, "staging");
  await mkdir(dir, { recursive: true });

  if (c.install !== null) {
    const iDir = join(installDir, "assets");
    await mkdir(iDir, { recursive: true });
    await writeFile(join(installDir, "app.js"), `${c.install}\n`);
    await writeFile(join(iDir, "marker.bin"), `${c.install}\n`);
  }
  if (c.staging !== null) {
    await mkdir(staging, { recursive: true });
    await writeFile(join(staging, "app.js"), `${c.staging}\n`);
  }
  if (c.backup !== null) {
    await mkdir(backup, { recursive: true });
    await writeFile(join(backup, "app.js"), `${c.backup}\n`);
  }
  if (c.journal !== null) {
    await writeFile(
      journal,
      c.journal === "CORRUPT"
        ? "{{ not json }\n"
        : `${JSON.stringify({ staging })}\n`,
    );
  }

  const result = await repairInterruptedUpdate(installDir);
  check(result === c.expect, `${c.label}: result ${result}`);
  check(
    (await marker(join(installDir, "app.js"))) === `${c.expectMarker}\n`,
    `${c.label}: install marker is ${c.expectMarker}`,
  );
  // The new tree always carries the layout the swap would have produced: when
  // rolling forward, the staged tree is a plain sibling dir (no assets/), while
  // a restored old install keeps its assets/ layout — only check the marker.
  const backupLeft = await exists(backup);
  check(!backupLeft, `${c.label}: backup cleaned up`);
  const journalLeft = await exists(journal);
  check(!journalLeft, `${c.label}: journal cleaned up`);
}

await rm(base, { recursive: true, force: true });

if (failures > 0) {
  console.error(`FAILED: ${failures} check(s)`);
  process.exit(1);
}
console.log("PASS: swap-crash journal self-repair (all crash windows)");
process.exit(0);
