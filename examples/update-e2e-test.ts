// Phase 9 end-to-end verification of the auto-updater.
//
// Simulates the full update flow without any windows/CEF (pure HTTP + fs):
//   1. Fixture app-layer trees: an "installed" old version and a new release.
//   2. Release tooling (scripts/release.ts) produces the three flat artifacts
//      (update.json / patch.bsdiff / full.tar.zst) from the two trees.
//   3. A tiny static HTTP server serves them (like S3/GH-Releases).
//   4. updater.check() + install() against a copy of the old install:
//      - patch path when currentVersion == fromVersion (asserts new tree)
//      - full fallback when currentVersion is further behind (asserts)
//      - up-to-date when currentVersion >= manifest version (asserts)
//   5. Corrupt-patch sanity: a mangled patch.bsdiff must fail the header check
//      in install (recoverable error), not corrupt the install.
//
// Exit codes: 0 = PASS, 1 = FAIL. Uses its own updater instance, and spins no
// CEF, so it can run headless like bsdiff-test.ts -- but still run it alone.

import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import { releaseArtifacts } from "../scripts/release";
import { Updater } from "../src/update";

const base = await mkdtemp(join(tmpdir(), "bunium-update-e2e-"));
let failures = 0;

function check(cond: boolean, label: string): void {
  if (cond) {
    console.log(`ok: ${label}`);
  } else {
    console.error(`FAIL: ${label}`);
    failures++;
  }
}

async function writeFixtureTree(
  root: string,
  variant: "old" | "new",
): Promise<void> {
  await mkdir(join(root, "assets"), { recursive: true });
  if (variant === "old") {
    await writeFile(join(root, "index.html"), "<html>old v1</html>\n");
    await writeFile(join(root, "app.js"), "console.log('v1');\n".repeat(64));
    await writeFile(
      join(root, "assets", "logo.bin"),
      new Uint8Array([0xde, 0xad, 0xbe, 0xef, 1, 2, 3, 4]),
    );
  } else {
    // Same shape, mostly overlapping content: ideal delta-patch material.
    await writeFile(join(root, "index.html"), "<html>new v2</html>\n");
    await writeFile(join(root, "app.js"), "console.log('v2');\n".repeat(64));
    await writeFile(
      join(root, "assets", "logo.bin"),
      new Uint8Array([0xde, 0xad, 0xbe, 0xef, 1, 2, 3, 99]),
    );
    await writeFile(join(root, "assets", "extra.txt"), "added in v2\n");
  }
}

const oldTree = join(base, "old-src");
const newTree = join(base, "new-src");
const outDir = join(base, "artifacts");
await writeFixtureTree(oldTree, "old");
await writeFixtureTree(newTree, "new");

await releaseArtifacts({
  name: "e2e-app",
  channel: "stable",
  platform: "mac",
  arch: "arm64",
  version: "1.0.2",
  fromVersion: "1.0.1",
  oldTreeDir: oldTree,
  newTreeDir: newTree,
  outDir,
});

// Static host: serve the artifact dir over HTTP.
const server: Server<never> = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const name = url.pathname.split("/").filter(Boolean).pop();
    if (!name) return new Response("not found", { status: 404 });
    const file = Bun.file(join(outDir, name));
    if (await file.exists()) return new Response(file);
    return new Response("not found", { status: 404 });
  },
});
const feedUrl = `http://127.0.0.1:${server.port}`;

// --- 4a: exactly-one-version-behind -> patch path -------------------------
{
  const installDir = join(base, "install-patch");
  await cp(oldTree, installDir, { recursive: true });

  const updater = new Updater();
  const events: string[] = [];
  updater.on("checking", () => events.push("checking"));
  updater.on("applying", (p) => events.push(`applying:${p.method}`));
  updater.on("ready", (p) => events.push(`ready:${p.version}`));

  const result = await updater.check({
    feedUrl,
    currentVersion: "1.0.1",
    channel: "stable",
    platform: "mac",
    arch: "arm64",
  });
  check(result.status === "update-available", "check: update available");
  if (result.status === "update-available") {
    check(
      result.update.method === "patch",
      `check: patch selected (got ${result.update.method})`,
    );
  }

  const newDir = await updater.install(
    result.status === "update-available" ? result.update : failType(),
    {
      installDir,
    },
  );
  check(newDir === installDir, "install: returned install dir");

  const indexContent = await readFile(join(installDir, "index.html"), "utf8");
  check(indexContent.includes("new v2"), "install: index.html updated");
  const extra = await stat(join(installDir, "assets", "extra.txt"));
  check(extra.isFile(), "install: new file present (extra.txt)");
  // The old install is gone (swapped), no .backup remains.
  let backupLeft = false;
  try {
    await stat(`${installDir}.backup`);
    backupLeft = true;
  } catch {
    /* expected: no backup dir */
  }
  check(!backupLeft, "install: backup cleaned up");
  check(
    events.includes("applying:patch") && events.includes("ready:1.0.2"),
    "install: patch-path events fired",
  );
  console.log(
    `  patch path: ${events.includes("applying:patch") ? "patch" : "???"} -> ready, install intact`,
  );
}

// --- 4b: further behind -> full fallback ----------------------------------
{
  const installDir = join(base, "install-full");
  await cp(oldTree, installDir, { recursive: true });

  const updater = new Updater();
  const result = await updater.check({
    feedUrl,
    currentVersion: "1.0.0", // two versions behind the manifest's fromVersion
    channel: "stable",
    platform: "mac",
    arch: "arm64",
  });
  check(result.status === "update-available", "full: update available");
  if (result.status === "update-available") {
    check(
      result.update.method === "full",
      `full: full bundle selected (got ${result.update.method})`,
    );
    await updater.install(result.update, { installDir });
    const indexContent = await readFile(join(installDir, "index.html"), "utf8");
    check(indexContent.includes("new v2"), "full: index.html updated");
  }
}

// --- 4c: current >= manifest -> up-to-date --------------------------------
{
  const updater = new Updater();
  const result = await updater.check({ feedUrl, currentVersion: "1.0.2" });
  check(result.status === "up-to-date", "up-to-date: manifest version reached");
  check(updater.isUpToDate, "up-to-date: isUpToDate flag");
}

// --- 5: corrupt patch -> recoverable error, install untouched -------------
{
  const installDir = join(base, "install-corrupt");
  await cp(oldTree, installDir, { recursive: true });

  const updater = new Updater();
  const errorState: {
    value: { message: string; recoverable: boolean } | null;
  } = {
    value: null,
  };
  updater.on("error", (e) => {
    errorState.value = { ...e };
  });

  // Corrupt the served patch: flip bytes in the middle of the file.
  const patchPath = join(outDir, "stable-mac-arm64-patch.bsdiff");
  const patchBytes = await readFile(patchPath);
  const corrupt = Buffer.from(patchBytes);
  corrupt[20] = corrupt[20]! ^ 0xff;
  await writeFile(patchPath, corrupt);

  const before = await readFile(join(installDir, "index.html"), "utf8");
  const result = await updater.check({
    feedUrl,
    currentVersion: "1.0.1",
    channel: "stable",
    platform: "mac",
    arch: "arm64",
  });
  check(result.status === "update-available", "corrupt: update available");
  if (result.status === "update-available") {
    try {
      await updater.install(result.update, { installDir });
      check(false, "corrupt: install should have thrown");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      check(
        message.includes("size") ||
          message.includes("sha256") ||
          message.includes("patch"),
        `corrupt: install rejected (${message.slice(0, 60)})`,
      );
    }
  }
  const after = await readFile(join(installDir, "index.html"), "utf8");
  check(before === after, "corrupt: install dir untouched after failure");
  check(
    errorState.value !== null && errorState.value.recoverable === true,
    "corrupt: recoverable error event emitted",
  );

  // Restore the good patch so the artifact dir stays valid.
  await writeFile(patchPath, patchBytes);
}

await server.stop();
await rm(base, { recursive: true, force: true });

if (failures > 0) {
  console.error(`FAILED: ${failures} check(s)`);
  process.exit(1);
}
console.log(
  "PASS: update end-to-end (patch, full fallback, up-to-date, corrupt-patch)",
);
process.exit(0);

// Type-narrowing helper: throws so `install` below gets a real UpdateInfo.
function failType(): never {
  throw new Error("unreachable: update-available branch expected");
}
