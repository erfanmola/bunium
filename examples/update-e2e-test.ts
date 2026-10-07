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

import { createHash, generateKeyPairSync } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import { releaseArtifacts, releaseRuntimeInstaller } from "../scripts/release";
import {
  type ApplicationTreeManifest,
  acknowledgeUpdateHealthy,
  beginUpdateHealthCheck,
  type RuntimeInstallerFormat,
  type RuntimeInstallerManifest,
  type RuntimeInstallerUpdate,
  signUpdateManifest,
  type UnsignedUpdateManifest,
  type UpdateCheckOptions,
  Updater,
  updateAbiVersion,
} from "../src/update";

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
const runtimeOutDir = join(base, "runtime-artifacts");
const runtimeInstallerSource = join(base, "bunium-installer.fixture");
const runtimeInstallerBytes = new Uint8Array(
  Buffer.from("platform installer fixture; never executed\n"),
);
await writeFile(runtimeInstallerSource, runtimeInstallerBytes);
const signingPair = generateKeyPairSync("ed25519");
const keyId = "ephemeral-e2e";
const privateKeyPem = signingPair.privateKey
  .export({ type: "pkcs8", format: "pem" })
  .toString();
const trustedKeys = {
  [keyId]: signingPair.publicKey
    .export({ type: "spki", format: "pem" })
    .toString(),
};
await writeFixtureTree(oldTree, "old");
await writeFixtureTree(newTree, "new");

const releasedManifest = await releaseArtifacts({
  product: "e2e-app",
  channel: "stable",
  platform: "mac",
  arch: "arm64",
  version: "1.0.2",
  fromVersion: "1.0.1",
  sequence: 2,
  runtimeVersion: "0.0.6",
  cefVersion: "1513.0.0",
  minimumBunVersion: "1.4.0",
  minimumOsVersion: "14.0.0",
  oldTreeDir: oldTree,
  newTreeDir: newTree,
  outDir,
  keyId,
  signingKeyPem: signingPair.privateKey
    .export({ type: "pkcs8", format: "pem" })
    .toString(),
});

const runtimeReleasedManifest = await releaseRuntimeInstaller({
  product: "e2e-app",
  channel: "stable",
  platform: "mac",
  arch: "arm64",
  version: "1.0.2",
  sequence: 3,
  fromRuntimeVersion: "0.0.6",
  fromCefVersion: "1513.0.0",
  runtimeVersion: "0.0.7",
  cefVersion: "1513.0.1",
  minimumBunVersion: "1.4.0",
  minimumOsVersion: "14.0.0",
  installerFormat: "mac-pkg",
  installerPath: runtimeInstallerSource,
  outDir: runtimeOutDir,
  keyId,
  signingKeyPem: privateKeyPem,
});

// Static host: serve the artifact dir over HTTP.
const server: Server<never> = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const sourceDir = url.pathname.startsWith("/runtime/")
      ? runtimeOutDir
      : outDir;
    const name = url.pathname.split("/").filter(Boolean).pop();
    if (!name) return new Response("not found", { status: 404 });
    if (name === "oversized-mac-arm64-update.json") {
      return new Response(new Uint8Array(1024 * 1024 + 1));
    }
    const file = Bun.file(join(sourceDir, name));
    if (await file.exists()) return new Response(file);
    return new Response("not found", { status: 404 });
  },
});
const feedUrl = `http://127.0.0.1:${server.port}`;
const runtimeFeedUrl = `${feedUrl}/runtime`;

const checkRuntimeFeed = (
  platform: "mac" | "linux" | "win",
  arch: "arm64" | "x64",
  channel: string,
  overrides: Partial<UpdateCheckOptions> = {},
) =>
  new Updater().check({
    product: "e2e-app",
    feedUrl: runtimeFeedUrl,
    currentVersion: "1.0.2",
    runtimeVersion: "0.0.6",
    cefVersion: "1513.0.0",
    currentOsVersion: "14.0.0",
    currentSequence: 2,
    channel,
    platform,
    arch,
    trustedKeys,
    ...overrides,
  });

// Runtime installers are selected by an exact base runtime/CEF pair and are
// downloaded to a user-chosen directory. The updater never executes them.
{
  const runtimeManifest: RuntimeInstallerManifest = runtimeReleasedManifest;
  const result = await checkRuntimeFeed("mac", "arm64", "stable");
  const selected =
    result.status === "runtime-installer-available" ? result.update : null;
  check(
    runtimeManifest.payloadKind === "runtime-installer-v1" &&
      selected?.method === "runtime-installer" &&
      selected.format === "mac-pkg",
    "runtime installer manifest: selected for matching macOS runtime",
  );
  if (selected) {
    const runtimeUpdate: RuntimeInstallerUpdate = selected;
    const installDir = join(base, "runtime-route-existing-install");
    await mkdir(installDir, { recursive: true });
    await writeFile(join(installDir, "keep.txt"), "existing app tree\n");
    let readyEvent = "";
    const updaterForDownload = new Updater();
    updaterForDownload.on("runtimeInstallerReady", (event) => {
      readyEvent = `${event.format}:${event.runtimeVersion}`;
    });
    const downloadDir = join(base, "runtime-download");
    const downloaded = await updaterForDownload.downloadRuntimeInstaller(
      runtimeUpdate,
      { directory: downloadDir },
    );
    check(
      (await readFile(downloaded)).equals(Buffer.from(runtimeInstallerBytes)) &&
        readyEvent === "mac-pkg:0.0.7",
      "runtime installer: hash verified and ready path reported",
    );
    let existingRefused = false;
    try {
      await updaterForDownload.downloadRuntimeInstaller(runtimeUpdate, {
        directory: downloadDir,
      });
    } catch (error) {
      existingRefused = String(error).includes("EEXIST");
    }
    check(
      existingRefused &&
        (await readFile(downloaded)).equals(Buffer.from(runtimeInstallerBytes)),
      "runtime installer: existing destination is never overwritten",
    );
    check(
      (await readFile(join(installDir, "keep.txt"), "utf8")) ===
        "existing app tree\n",
      "runtime installer: download leaves the installed app tree unchanged",
    );
    let applyRefused = false;
    try {
      await updaterForDownload.install(runtimeUpdate, { installDir });
    } catch (error) {
      applyRefused = String(error).includes("must be downloaded and applied");
    }
    check(
      applyRefused &&
        (await readFile(join(installDir, "keep.txt"), "utf8")) ===
          "existing app tree\n",
      "runtime installer: app-tree swap API refuses this payload",
    );

    const corrupted = Buffer.from(runtimeInstallerBytes);
    corrupted[0] = (corrupted[0] ?? 0) ^ 1;
    await writeFile(
      join(runtimeOutDir, runtimeManifest.installerArtifact.file),
      corrupted,
    );
    const corruptResult = await checkRuntimeFeed("mac", "arm64", "stable");
    let corruptRejected = false;
    const corruptDownloadDir = join(base, "runtime-download-corrupt");
    if (corruptResult.status === "runtime-installer-available") {
      try {
        await new Updater().downloadRuntimeInstaller(corruptResult.update, {
          directory: corruptDownloadDir,
        });
      } catch (error) {
        corruptRejected = String(error).includes("integrity check failed");
      }
    }
    check(
      corruptRejected &&
        (await readdir(corruptDownloadDir)).length === 0 &&
        !(await Bun.file(
          join(corruptDownloadDir, runtimeManifest.installerArtifact.file),
        ).exists()),
      "runtime installer: tampering rejected before staging",
    );
    await writeFile(
      join(runtimeOutDir, runtimeManifest.installerArtifact.file),
      runtimeInstallerBytes,
    );
  }
  let skippedRuntimeSelected = false;
  try {
    const skipped = await checkRuntimeFeed("mac", "arm64", "stable", {
      runtimeVersion: "0.0.5",
    });
    skippedRuntimeSelected = skipped.status === "runtime-installer-available";
  } catch {
    skippedRuntimeSelected = false;
  }
  check(
    skippedRuntimeSelected,
    "runtime installer: skipped intermediate runtime remains upgradable",
  );
  let downgradeRefused = false;
  try {
    await checkRuntimeFeed("mac", "arm64", "stable", {
      runtimeVersion: "0.0.8",
      cefVersion: "1513.0.2",
    });
  } catch (error) {
    downgradeRefused = String(error).includes(
      "runtime installer version rollback rejected",
    );
  }
  check(
    downgradeRefused,
    "runtime installer: installed version downgrade refused",
  );
}

// These fixtures validate format routing metadata only; they do not emulate
// native package installation or platform recovery behavior.
{
  const routes: {
    platform: "mac" | "win" | "linux";
    arch: "arm64" | "x64";
    format: RuntimeInstallerFormat;
  }[] = [
    { platform: "mac", arch: "arm64", format: "mac-pkg" },
    { platform: "win", arch: "x64", format: "windows-msi" },
    { platform: "linux", arch: "x64", format: "linux-deb" },
    { platform: "linux", arch: "x64", format: "linux-rpm" },
    { platform: "linux", arch: "x64", format: "linux-appimage" },
  ];
  for (const route of routes) {
    const channel = `runtime-${route.format}`;
    await releaseRuntimeInstaller({
      product: "e2e-app",
      channel,
      platform: route.platform,
      arch: route.arch,
      version: "1.0.2",
      sequence: 3,
      fromRuntimeVersion: "0.0.6",
      fromCefVersion: "1513.0.0",
      runtimeVersion: "0.0.8",
      cefVersion: "1513.0.2",
      minimumBunVersion: "1.4.0",
      minimumOsVersion: "1.0.0",
      installerFormat: route.format,
      installerPath: runtimeInstallerSource,
      outDir: runtimeOutDir,
      keyId,
      signingKeyPem: privateKeyPem,
    });
    const selected = await checkRuntimeFeed(
      route.platform,
      route.arch,
      channel,
    );
    check(
      selected.status === "runtime-installer-available" &&
        selected.update.format === route.format,
      `runtime installer route: ${route.platform}/${route.arch}/${route.format}`,
    );
    if (
      selected.status === "runtime-installer-available" &&
      route.format === "linux-appimage"
    ) {
      if (process.platform !== "linux") {
        // The AppImage executable bit is a Linux-only property; other
        // platforms only verify the route resolves.
        console.log("skip: AppImage executable bit is Linux-only");
      } else {
        const appImagePath = await new Updater().downloadRuntimeInstaller(
          selected.update,
          { directory: join(base, "runtime-appimage-download") },
        );
        const appImageStat = await lstat(appImagePath);
        check(
          (appImageStat.mode & 0o111) !== 0,
          "runtime installer: verified AppImage is executable",
        );
      }
    }
  }
  let wrongPlatformRefused = false;
  try {
    await releaseRuntimeInstaller({
      product: "e2e-app",
      channel: "runtime-invalid-format",
      platform: "mac",
      arch: "arm64",
      version: "1.0.2",
      sequence: 3,
      fromRuntimeVersion: "0.0.6",
      fromCefVersion: "1513.0.0",
      runtimeVersion: "0.0.8",
      cefVersion: "1513.0.2",
      minimumBunVersion: "1.4.0",
      minimumOsVersion: "1.0.0",
      installerFormat: "windows-msi",
      installerPath: runtimeInstallerSource,
      outDir: runtimeOutDir,
      keyId,
      signingKeyPem: privateKeyPem,
    });
  } catch (error) {
    wrongPlatformRefused = String(error).includes(
      "invalid runtime installer metadata",
    );
  }
  check(
    wrongPlatformRefused,
    "runtime installer release: wrong OS format refused",
  );

  const symlinkInstaller = join(base, "runtime-installer-symlink");
  // File symlinks need Developer Mode / SeCreateSymbolicLinkPrivilege on
  // Windows (directory junctions can't stand in for a file). Without it,
  // skip the refusal case with a logged reason instead of failing.
  let symlinkSkipped = false;
  try {
    await symlink(runtimeInstallerSource, symlinkInstaller);
  } catch (error) {
    if (
      process.platform !== "win32" ||
      (error as NodeJS.ErrnoException)?.code !== "EPERM"
    )
      throw error;
    symlinkSkipped = true;
    console.log(
      "skip: runtime installer symlink case needs Developer Mode on Windows",
    );
  }
  let symlinkRefused = false;
  if (!symlinkSkipped) {
    try {
      await releaseRuntimeInstaller({
        product: "e2e-app",
        channel: "runtime-symlink",
        platform: "mac",
        arch: "arm64",
        version: "1.0.2",
        sequence: 3,
        fromRuntimeVersion: "0.0.6",
        fromCefVersion: "1513.0.0",
        runtimeVersion: "0.0.8",
        cefVersion: "1513.0.2",
        minimumBunVersion: "1.4.0",
        minimumOsVersion: "1.0.0",
        installerFormat: "mac-pkg",
        installerPath: symlinkInstaller,
        outDir: runtimeOutDir,
        keyId,
        signingKeyPem: privateKeyPem,
      });
    } catch (error) {
      symlinkRefused = String(error).includes("regular file");
    }
    await rm(symlinkInstaller, { force: true });
    check(symlinkRefused, "runtime installer release: symbolic link refused");
  }
}

function unsignedManifest(
  manifest: ApplicationTreeManifest,
): Omit<ApplicationTreeManifest, "keyId" | "signature"> {
  return {
    schema: manifest.schema,
    product: manifest.product,
    runtimeAbi: manifest.runtimeAbi,
    runtimeVersion: manifest.runtimeVersion,
    cefVersion: manifest.cefVersion,
    minimumBunVersion: manifest.minimumBunVersion,
    minimumOsVersion: manifest.minimumOsVersion,
    payloadKind: manifest.payloadKind,
    sequence: manifest.sequence,
    issuedAt: manifest.issuedAt,
    expiresAt: manifest.expiresAt,
    channel: manifest.channel,
    version: manifest.version,
    fromVersion: manifest.fromVersion,
    fromSha256: manifest.fromSha256,
    patchArtifact: manifest.patchArtifact,
    fullArtifact: manifest.fullArtifact,
    platform: manifest.platform,
    arch: manifest.arch,
    fullSize: manifest.fullSize,
    sha256: manifest.sha256,
  };
}

// Signed-feed gate: reject unsigned manifests, unknown keys and tampering.
{
  try {
    await new Updater().check({
      product: "e2e-app",
      feedUrl,
      currentVersion: "1.0.1",
      runtimeVersion: "0.0.6",
      cefVersion: "1513.0.0",
      currentOsVersion: "14.0.0",
      currentSequence: 1,
      channel: "oversized",
      platform: "mac",
      arch: "arm64",
      trustedKeys,
    });
    check(false, "oversized manifest: rejected");
  } catch (error) {
    check(
      String(error).includes("manifest exceeds size limit"),
      "oversized manifest: rejected before parsing",
    );
  }

  const manifestPath = join(outDir, "stable-mac-arm64-update.json");
  const signedBytes = await readFile(manifestPath);
  const signed = JSON.parse(signedBytes.toString("utf8")) as Record<
    string,
    unknown
  >;
  const checkFeed = (overrides: Partial<UpdateCheckOptions> = {}) =>
    new Updater().check({
      product: "e2e-app",
      feedUrl,
      currentVersion: "1.0.1",
      runtimeVersion: "0.0.6",
      cefVersion: "1513.0.0",
      currentOsVersion: "14.0.0",
      currentSequence: 1,
      channel: "stable",
      platform: "mac",
      arch: "arm64",
      trustedKeys,
      ...overrides,
    });
  const rewriteAndReject = async (
    manifest: unknown,
    reason: string,
    label: string,
  ) => {
    await writeFile(manifestPath, JSON.stringify(manifest));
    try {
      await checkFeed();
      check(false, `${label}: rejected`);
    } catch (error) {
      check(String(error).includes(reason), `${label}: rejected (${reason})`);
    }
  };

  await rewriteAndReject(
    signUpdateManifest(
      { ...unsignedManifest(releasedManifest), minimumBunVersion: "9.0.0" },
      keyId,
      privateKeyPem,
    ),
    "requires a newer Bun",
    "minimum Bun compatibility",
  );
  await rewriteAndReject(
    signUpdateManifest(
      { ...unsignedManifest(releasedManifest), minimumOsVersion: "15.0.0" },
      keyId,
      privateKeyPem,
    ),
    "requires a newer operating system",
    "minimum OS compatibility",
  );
  for (const [field, value, reason] of [
    ["runtimeVersion", "0.0.7", "runtime version mismatch"],
    ["cefVersion", "1514.0.0", "CEF version mismatch"],
  ] as const) {
    await writeFile(manifestPath, signedBytes);
    try {
      await checkFeed({ [field]: value });
      check(false, `${field} compatibility: rejected`);
    } catch (error) {
      check(
        String(error).includes(reason),
        `${field} compatibility: rejected (${reason})`,
      );
    }
  }
  await rewriteAndReject(
    signUpdateManifest(
      {
        ...unsignedManifest(releasedManifest),
        payloadKind: "installer",
      } as unknown as UnsignedUpdateManifest,
      keyId,
      privateKeyPem,
    ),
    "malformed update manifest",
    "payload kind",
  );
  await writeFile(manifestPath, signedBytes);

  const unsigned = { ...signed };
  delete unsigned.signature;
  await writeFile(manifestPath, JSON.stringify(unsigned));
  try {
    await checkFeed();
    check(false, "unsigned: rejected");
  } catch (error) {
    check(
      String(error).includes("unsigned update manifest"),
      "unsigned: rejected before update selection",
    );
  }

  const tampered = { ...signed, version: "9.9.9" };
  await writeFile(manifestPath, JSON.stringify(tampered));
  try {
    await checkFeed();
    check(false, "tampered: rejected");
  } catch (error) {
    check(
      String(error).includes("signature verification failed"),
      "tampered: rejected by signature verification",
    );
  }
  await writeFile(manifestPath, signedBytes);

  const reorderedNestedKeys = {
    ...signed,
    patchArtifact: {
      ...(signed.patchArtifact as Record<string, unknown>),
    },
    fullArtifact: {
      ...(signed.fullArtifact as Record<string, unknown>),
    },
  };
  for (const artifactKey of ["patchArtifact", "fullArtifact"] as const) {
    const artifact = reorderedNestedKeys[artifactKey] as Record<
      string,
      unknown
    >;
    reorderedNestedKeys[artifactKey] = Object.fromEntries(
      Object.entries(artifact).reverse(),
    );
  }
  await writeFile(manifestPath, JSON.stringify(reorderedNestedKeys));
  const reorderedResult = await checkFeed();
  check(
    reorderedResult.status === "update-available",
    "nested object key order: canonical signature accepted",
  );
  await writeFile(manifestPath, signedBytes);

  try {
    await new Updater().check({
      product: "e2e-app",
      feedUrl,
      currentVersion: "1.0.1",
      runtimeVersion: "0.0.6",
      cefVersion: "1513.0.0",
      currentOsVersion: "14.0.0",
      currentSequence: 1,
      channel: "stable",
      platform: "mac",
      arch: "arm64",
      trustedKeys: {},
    });
    check(false, "unknown key: rejected");
  } catch (error) {
    check(
      String(error).includes("untrusted update signing key"),
      "unknown key: rejected before update selection",
    );
  }

  await rewriteAndReject(
    signUpdateManifest(
      { ...unsignedManifest(releasedManifest), product: "different-app" },
      keyId,
      privateKeyPem,
    ),
    "product mismatch",
    "wrong product",
  );
  await rewriteAndReject(
    signUpdateManifest(
      {
        ...unsignedManifest(releasedManifest),
        version: "1.0.1",
        fromVersion: "1.0.2",
      },
      keyId,
      privateKeyPem,
    ),
    "base version exceeds target",
    "invalid delta base",
  );
  await rewriteAndReject(
    signUpdateManifest(
      {
        ...unsignedManifest(releasedManifest),
        issuedAt: new Date(Date.now() - 2 * 86400_000).toISOString(),
        expiresAt: new Date(Date.now() - 86400_000).toISOString(),
      },
      keyId,
      privateKeyPem,
    ),
    "expired or has invalid timestamps",
    "expired manifest",
  );
  await rewriteAndReject(
    signUpdateManifest(
      {
        ...unsignedManifest(releasedManifest),
        runtimeAbi: updateAbiVersion + 1,
      },
      keyId,
      privateKeyPem,
    ),
    "runtime ABI mismatch",
    "ABI mismatch",
  );
  await rewriteAndReject(
    signUpdateManifest(
      {
        ...unsignedManifest(releasedManifest),
        platform: "linux",
        patchArtifact: {
          ...releasedManifest.patchArtifact,
          file: releasedManifest.patchArtifact.file.replace("-mac-", "-linux-"),
        },
        fullArtifact: {
          ...releasedManifest.fullArtifact,
          file: releasedManifest.fullArtifact.file.replace("-mac-", "-linux-"),
        },
      },
      keyId,
      privateKeyPem,
    ),
    "platform/arch/channel mismatch",
    "wrong platform",
  );
  await rewriteAndReject(
    signUpdateManifest(
      {
        ...unsignedManifest(releasedManifest),
        version: "1.0.0",
        fromVersion: "0.9.0",
        sequence: 3,
      },
      keyId,
      privateKeyPem,
    ),
    "version rollback rejected",
    "version rollback",
  );
  await writeFile(manifestPath, signedBytes);
  try {
    await new Updater().check({
      product: "e2e-app",
      feedUrl,
      currentVersion: "1.0.1",
      runtimeVersion: "0.0.6",
      cefVersion: "1513.0.0",
      currentOsVersion: "14.0.0",
      currentSequence: 3,
      channel: "stable",
      platform: "mac",
      arch: "arm64",
      trustedKeys,
    });
    check(false, "replayed sequence: rejected");
  } catch (error) {
    check(
      String(error).includes("sequence rollback rejected"),
      "replayed sequence: rejected before update selection",
    );
  }
  await writeFile(manifestPath, signedBytes);
}

// --- 4a: exactly-one-version-behind -> patch path -------------------------
{
  const installDir = join(base, "install-patch");
  const userDataDir = join(base, "user-data-and-vault");
  await cp(oldTree, installDir, { recursive: true });
  await mkdir(userDataDir);
  await writeFile(join(userDataDir, "projects.sqlite"), "project-data-v1\n");
  await writeFile(join(userDataDir, "vault-ref"), "host-secret-reference\n");

  const updater = new Updater();
  const events: string[] = [];
  updater.on("checking", () => events.push("checking"));
  updater.on("applying", (p) => events.push(`applying:${p.method}`));
  updater.on("ready", (p) => events.push(`ready:${p.version}`));

  const result = await updater.check({
    product: "e2e-app",
    feedUrl,
    currentVersion: "1.0.1",
    runtimeVersion: "0.0.6",
    cefVersion: "1513.0.0",
    currentOsVersion: "14.0.0",
    currentSequence: 1,
    channel: "stable",
    platform: "mac",
    arch: "arm64",
    trustedKeys,
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
  check(
    (await readFile(join(userDataDir, "projects.sqlite"), "utf8")) ===
      "project-data-v1\n" &&
      (await readFile(join(userDataDir, "vault-ref"), "utf8")) ===
        "host-secret-reference\n",
    "install: sibling project data and vault reference preserved",
  );
  // The old tree stays available until the app confirms a healthy relaunch.
  const backup = await stat(`${installDir}.backup`);
  check(backup.isDirectory(), "install: known-good backup retained for health");
  check(
    (await beginUpdateHealthCheck(installDir)) === "pending",
    "install: relaunched candidate begins its health attempt",
  );
  check(
    await acknowledgeUpdateHealthy(installDir),
    "install: health acknowledgment finalizes the update",
  );
  let backupLeft = false;
  try {
    await stat(`${installDir}.backup`);
    backupLeft = true;
  } catch {
    /* expected: acknowledged backup removed */
  }
  check(!backupLeft, "install: acknowledged backup cleaned up");
  check(
    events.includes("applying:patch") && events.includes("ready:1.0.2"),
    "install: patch-path events fired",
  );
  console.log(
    `  patch path: ${events.includes("applying:patch") ? "patch" : "???"} -> ready, install intact`,
  );
}

// A matching version label is insufficient if the installed tree was altered.
{
  const installDir = join(base, "install-wrong-delta-base");
  await cp(oldTree, installDir, { recursive: true });
  await writeFile(join(installDir, "app.js"), "locally modified\n");
  const updater = new Updater();
  const result = await updater.check({
    product: "e2e-app",
    feedUrl,
    currentVersion: "1.0.1",
    runtimeVersion: "0.0.6",
    cefVersion: "1513.0.0",
    currentOsVersion: "14.0.0",
    currentSequence: 1,
    channel: "stable",
    platform: "mac",
    arch: "arm64",
    trustedKeys,
  });
  const before = await readFile(join(installDir, "app.js"), "utf8");
  try {
    if (result.status !== "update-available") throw new Error("update missing");
    await updater.install(result.update, { installDir });
    check(false, "delta base tampered: rejected");
  } catch (error) {
    check(
      String(error).includes("delta base integrity check failed"),
      "delta base tampered: rejected before patch download/application",
    );
  }
  check(
    (await readFile(join(installDir, "app.js"), "utf8")) === before,
    "delta base tampered: installed tree preserved",
  );
}

// --- 4b: further behind -> full fallback ----------------------------------
{
  const installDir = join(base, "install-full");
  await cp(oldTree, installDir, { recursive: true });

  const updater = new Updater();
  const result = await updater.check({
    product: "e2e-app",
    feedUrl,
    currentVersion: "1.0.0", // two versions behind the manifest's fromVersion
    runtimeVersion: "0.0.6",
    cefVersion: "1513.0.0",
    currentOsVersion: "14.0.0",
    currentSequence: 0,
    channel: "stable",
    platform: "mac",
    arch: "arm64",
    trustedKeys,
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
  const result = await updater.check({
    product: "e2e-app",
    feedUrl,
    currentVersion: "1.0.2",
    runtimeVersion: "0.0.6",
    cefVersion: "1513.0.0",
    currentOsVersion: "14.0.0",
    currentSequence: 2,
    trustedKeys,
  });
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
    product: "e2e-app",
    feedUrl,
    currentVersion: "1.0.1",
    runtimeVersion: "0.0.6",
    cefVersion: "1513.0.0",
    currentOsVersion: "14.0.0",
    currentSequence: 1,
    channel: "stable",
    platform: "mac",
    arch: "arm64",
    trustedKeys,
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

// Corrupt full archive must be rejected before replacing the installation.
{
  const installDir = join(base, "install-corrupt-full");
  await cp(oldTree, installDir, { recursive: true });
  const fullPath = join(outDir, "stable-mac-arm64-full.tar.zst");
  const fullBytes = await readFile(fullPath);
  const corrupt = Buffer.from(fullBytes);
  corrupt[Math.floor(corrupt.length / 2)] =
    corrupt[Math.floor(corrupt.length / 2)]! ^ 0xff;
  await writeFile(fullPath, corrupt);
  const before = await readFile(join(installDir, "index.html"), "utf8");
  const updater = new Updater();
  const result = await updater.check({
    product: "e2e-app",
    feedUrl,
    currentVersion: "1.0.0",
    runtimeVersion: "0.0.6",
    cefVersion: "1513.0.0",
    currentOsVersion: "14.0.0",
    currentSequence: 0,
    channel: "stable",
    platform: "mac",
    arch: "arm64",
    trustedKeys,
  });
  check(result.status === "update-available", "corrupt full: update available");
  if (result.status === "update-available") {
    try {
      await updater.install(result.update, { installDir });
      check(false, "corrupt full: install should have thrown");
    } catch (error) {
      const message = String(error).toLowerCase();
      check(
        message.includes("zstd") || message.includes("integrity"),
        `corrupt full: rejected (${message.slice(0, 60)})`,
      );
    }
  }
  check(
    (await readFile(join(installDir, "index.html"), "utf8")) === before,
    "corrupt full: old install untouched",
  );
  await writeFile(fullPath, fullBytes);
}

// A correctly signed and hashed compressed artifact can still expand beyond
// the signed fullSize. The decoder must stop at that size before installation.
{
  const installDir = join(base, "install-oversized-full-output");
  await cp(oldTree, installDir, { recursive: true });
  const manifestPath = join(outDir, "stable-mac-arm64-update.json");
  const fullPath = join(outDir, "stable-mac-arm64-full.tar.zst");
  const manifestBytes = await readFile(manifestPath);
  const fullBytes = await readFile(fullPath);
  const before = await readFile(join(installDir, "index.html"), "utf8");
  const oversizedOutput = Buffer.alloc(4 * 1024 * 1024);
  const compressedOutput = Bun.zstdCompressSync(oversizedOutput);
  const privateKeyPem = signingPair.privateKey
    .export({ type: "pkcs8", format: "pem" })
    .toString();
  const boundedManifest = signUpdateManifest(
    {
      ...unsignedManifest(releasedManifest),
      fullSize: 1024,
      fullArtifact: {
        file: releasedManifest.fullArtifact.file,
        size: compressedOutput.byteLength,
        sha256: createHash("sha256").update(compressedOutput).digest("hex"),
      },
    },
    keyId,
    privateKeyPem,
  );
  await writeFile(fullPath, compressedOutput);
  await writeFile(manifestPath, JSON.stringify(boundedManifest));
  try {
    const result = await new Updater().check({
      product: "e2e-app",
      feedUrl,
      currentVersion: "1.0.0",
      runtimeVersion: "0.0.6",
      cefVersion: "1513.0.0",
      currentOsVersion: "14.0.0",
      currentSequence: 0,
      channel: "stable",
      platform: "mac",
      arch: "arm64",
      trustedKeys,
    });
    if (result.status !== "update-available")
      throw new Error("oversized full output update missing");
    await new Updater().install(result.update, { installDir });
    check(false, "oversized full output: rejected at signed size limit");
  } catch (error) {
    check(
      String(error).includes("larger than 1024 bytes"),
      `oversized full output: bounded decompression rejected (${String(error).slice(0, 80)})`,
    );
  }
  check(
    (await readFile(join(installDir, "index.html"), "utf8")) === before,
    "oversized full output: existing install unchanged",
  );
  await writeFile(fullPath, fullBytes);
  await writeFile(manifestPath, manifestBytes);
}

await server.stop();
await rm(base, { recursive: true, force: true });

if (failures > 0) {
  console.error(`FAILED: ${failures} check(s)`);
  process.exit(1);
}
console.log(
  "PASS: update e2e (signatures, rollback gates, patch/full, corrupt artifacts)",
);
process.exit(0);

// Type-narrowing helper: throws so `install` below gets a real UpdateInfo.
function failType(): never {
  throw new Error("unreachable: update-available branch expected");
}
