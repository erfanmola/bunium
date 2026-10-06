#!/usr/bin/env bun
// Phase 9 release tooling: produce the flat artifact set a static host
// serves for the auto-updater (src/update.ts), from two app-layer trees.
//
// Usage (from repo root):
//   bun scripts/release.ts \
//     --product myapp --channel stable --platform mac --arch arm64 \
//     --version 1.0.2 --from-version 1.0.1 \
//     --runtime-version 0.0.7 --cef-version 1513.0.16 \
//     --minimum-bun-version 1.4.0 --minimum-os-version 14.0.0 \
//     --old path/to/previous/dist --new path/to/current/dist --out out/ \
//     --key-id release-2026 --signing-key /secure/path/update-ed25519.pem
//
// Output, named per the <channel>-<os>-<arch>-{...} convention:
//   stable-mac-arm64-update.json     -- manifest the client fetches first
//   stable-mac-arm64-patch.bsdiff    -- bsdiff(previous tar, current tar)
//   stable-mac-arm64-full.tar.zst    -- zstd(current tar), fallback path
//
// Both tars are built with src/tar.ts's deterministic writer, so a client
// re-tarring its installed tree (srcdirs identical to what was shipped)
// byte-matches and the patch applies. The bsdiff patch is created natively
// (bunium_bsdiff via the shim).
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  constants,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPatch } from "../src/bsdiff";
import { collectDirectory, writeTar } from "../src/tar";
import {
  type ApplicationTreeManifest,
  type Arch,
  MAX_UPDATE_ARTIFACT_BYTES,
  type Platform,
  type RuntimeInstallerFormat,
  type RuntimeInstallerManifest,
  runtimeInstallerFileName,
  runtimeInstallerFormatMatchesPlatform,
  signUpdateManifest,
  updateAbiVersion,
} from "../src/update";

export interface ReleaseOptions {
  product: string;
  channel: string;
  platform: Platform;
  arch: Arch;
  version: string;
  fromVersion: string;
  oldTreeDir: string;
  newTreeDir: string;
  outDir: string;
  sequence: number;
  runtimeVersion: string;
  cefVersion: string;
  minimumBunVersion: string;
  minimumOsVersion: string;
  signingKeyPem: string;
  keyId: string;
}

export interface RuntimeInstallerReleaseOptions {
  product: string;
  channel: string;
  platform: Platform;
  arch: Arch;
  /** Product version associated with this release sequence. */
  version: string;
  sequence: number;
  fromRuntimeVersion: string;
  fromCefVersion: string;
  runtimeVersion: string;
  cefVersion: string;
  minimumBunVersion: string;
  minimumOsVersion: string;
  installerFormat: RuntimeInstallerFormat;
  installerPath: string;
  outDir: string;
  signingKeyPem: string;
  keyId: string;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Builds the full tar + zstd bundle for `treeDir`. */
async function buildFullBundle(
  treeDir: string,
): Promise<{ tar: Uint8Array; zst: Uint8Array; sha256: string }> {
  const tar = writeTar(await collectDirectory(treeDir));
  const zst = new Uint8Array(Bun.zstdCompressSync(tar));
  return { tar, zst, sha256: sha256Hex(tar) };
}

/** Computes the single-previous-version bsdiff patch between two tars. */
async function buildPatch(
  oldTar: Uint8Array,
  newTar: Uint8Array,
): Promise<Uint8Array> {
  const tmp = await mkdtemp(join(tmpdir(), "bunium-release-"));
  try {
    const oldPath = join(tmp, "old.tar");
    const newPath = join(tmp, "new.tar");
    const patchPath = join(tmp, "delta.patch");
    await writeFile(oldPath, oldTar);
    await writeFile(newPath, newTar);
    createPatch(oldPath, newPath, patchPath);
    const data = await Bun.file(patchPath).arrayBuffer();
    return new Uint8Array(data);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/**
 * Generates the full release artifact set from two app-layer trees. Returns
 * the manifest written (also useful for tests to construct feeds).
 */
export async function releaseArtifacts(
  options: ReleaseOptions,
): Promise<ApplicationTreeManifest> {
  const { product, channel, platform, arch, version, fromVersion, outDir } =
    options;
  for (const [label, value] of [
    ["runtime version", options.runtimeVersion],
    ["CEF version", options.cefVersion],
    ["minimum Bun version", options.minimumBunVersion],
    ["minimum OS version", options.minimumOsVersion],
  ] as const) {
    if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) {
      throw new Error(`release: invalid ${label}: ${value}`);
    }
  }
  const prefix = `${channel}-${platform}-${arch}`;

  const prev = await buildFullBundle(options.oldTreeDir);
  const curr = await buildFullBundle(options.newTreeDir);
  const patch = await buildPatch(prev.tar, curr.tar);

  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, `${prefix}-patch.bsdiff`), patch);
  await writeFile(join(outDir, `${prefix}-full.tar.zst`), curr.zst);

  const manifest = signUpdateManifest(
    {
      product,
      schema: 2,
      runtimeAbi: updateAbiVersion,
      runtimeVersion: options.runtimeVersion,
      cefVersion: options.cefVersion,
      minimumBunVersion: options.minimumBunVersion,
      minimumOsVersion: options.minimumOsVersion,
      payloadKind: "application-tree-v1",
      sequence: options.sequence,
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      channel,
      version,
      fromVersion,
      fromSha256: prev.sha256,
      patchArtifact: {
        file: `${prefix}-patch.bsdiff`,
        size: patch.length,
        sha256: sha256Hex(patch),
      },
      fullArtifact: {
        file: `${prefix}-full.tar.zst`,
        size: curr.zst.length,
        sha256: sha256Hex(curr.zst),
      },
      platform,
      arch,
      fullSize: curr.tar.length,
      sha256: curr.sha256,
    },
    options.keyId,
    options.signingKeyPem,
  );
  await writeFile(
    join(outDir, `${prefix}-update.json`),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
}

/**
 * Stages one platform-owned installer under a signed runtime-installer
 * manifest. It never executes or installs the package.
 */
export async function releaseRuntimeInstaller(
  options: RuntimeInstallerReleaseOptions,
): Promise<RuntimeInstallerManifest> {
  const versions = [
    options.version,
    options.fromRuntimeVersion,
    options.fromCefVersion,
    options.runtimeVersion,
    options.cefVersion,
    options.minimumBunVersion,
    options.minimumOsVersion,
  ];
  if (
    versions.some(
      (value) => !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value),
    )
  ) {
    throw new Error("release: invalid runtime installer version metadata");
  }
  if (
    !Number.isSafeInteger(options.sequence) ||
    options.sequence < 1 ||
    !/^[A-Za-z0-9._-]{1,64}$/.test(options.channel) ||
    !options.product ||
    options.product.length > 128 ||
    !["mac", "linux", "win"].includes(options.platform) ||
    !["arm64", "x64"].includes(options.arch) ||
    !runtimeInstallerFormatMatchesPlatform(
      options.installerFormat,
      options.platform,
    )
  ) {
    throw new Error("release: invalid runtime installer metadata");
  }
  const runtimeChanged = options.runtimeVersion !== options.fromRuntimeVersion;
  const cefChanged = options.cefVersion !== options.fromCefVersion;
  if (!runtimeChanged && !cefChanged) {
    throw new Error(
      "release: runtime installer must change the runtime or CEF",
    );
  }
  const compare = (left: string, right: string): number => {
    const leftParts = left.split(".").map(Number);
    const rightParts = right.split(".").map(Number);
    for (let index = 0; index < 3; index++) {
      if (leftParts[index] !== rightParts[index]) {
        return (leftParts[index] ?? 0) > (rightParts[index] ?? 0) ? 1 : -1;
      }
    }
    return 0;
  };
  if (
    compare(options.runtimeVersion, options.fromRuntimeVersion) < 0 ||
    compare(options.cefVersion, options.fromCefVersion) < 0
  ) {
    throw new Error(
      "release: runtime installer cannot downgrade runtime or CEF",
    );
  }
  const source = await lstat(options.installerPath);
  if (
    !source.isFile() ||
    source.isSymbolicLink() ||
    source.size <= 0 ||
    source.size > MAX_UPDATE_ARTIFACT_BYTES
  ) {
    throw new Error(
      "release: installer must be a regular file within size limits",
    );
  }
  const prefix = `${options.channel}-${options.platform}-${options.arch}`;
  const file = runtimeInstallerFileName(
    options.channel,
    options.platform,
    options.arch,
    options.runtimeVersion,
    options.installerFormat,
  );
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(options.installerPath)) {
    hash.update(chunk);
  }
  await mkdir(options.outDir, { recursive: true });
  const stagedInstaller = join(options.outDir, file);
  const manifest = signUpdateManifest(
    {
      schema: 2,
      product: options.product,
      runtimeAbi: updateAbiVersion,
      runtimeVersion: options.runtimeVersion,
      cefVersion: options.cefVersion,
      minimumBunVersion: options.minimumBunVersion,
      minimumOsVersion: options.minimumOsVersion,
      payloadKind: "runtime-installer-v1",
      sequence: options.sequence,
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      channel: options.channel,
      version: options.version,
      platform: options.platform,
      arch: options.arch,
      fromRuntimeVersion: options.fromRuntimeVersion,
      fromCefVersion: options.fromCefVersion,
      installerFormat: options.installerFormat,
      installerArtifact: {
        file,
        size: source.size,
        sha256: hash.digest("hex"),
      },
    },
    options.keyId,
    options.signingKeyPem,
  );
  const manifestPath = join(options.outDir, `${prefix}-update.json`);
  await copyFile(
    options.installerPath,
    stagedInstaller,
    constants.COPYFILE_EXCL,
  );
  try {
    const staged = await lstat(stagedInstaller);
    const stagedHash = createHash("sha256");
    for await (const chunk of createReadStream(stagedInstaller)) {
      stagedHash.update(chunk);
    }
    if (
      !staged.isFile() ||
      staged.isSymbolicLink() ||
      staged.size !== source.size ||
      stagedHash.digest("hex") !== manifest.installerArtifact.sha256
    ) {
      throw new Error(
        "release: staged runtime installer changed while copying",
      );
    }
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      flag: "wx",
    });
  } catch (error) {
    await rm(stagedInstaller, { force: true });
    throw error;
  }
  return manifest;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const get = (flag: string): string => {
    const i = args.indexOf(flag);
    return i !== -1 && args[i + 1] ? args[i + 1]! : "";
  };
  const required: ReleaseOptions = {
    product: get("--product") || get("--name"),
    channel: get("--channel") || "stable",
    platform: get("--platform") as Platform,
    arch: get("--arch") as Arch,
    version: get("--version"),
    fromVersion: get("--from-version"),
    oldTreeDir: get("--old"),
    newTreeDir: get("--new"),
    outDir: get("--out"),
    sequence: Number(get("--sequence")),
    runtimeVersion: get("--runtime-version"),
    cefVersion: get("--cef-version"),
    minimumBunVersion: get("--minimum-bun-version"),
    minimumOsVersion: get("--minimum-os-version"),
    signingKeyPem: await Bun.file(get("--signing-key"))
      .text()
      .catch(() => ""),
    keyId: get("--key-id"),
  };
  for (const [key, value] of Object.entries(required)) {
    if (typeof value === "string" && !value) {
      console.error(`release: missing value for ${key}`);
      process.exit(1);
    }
  }
  if (!Number.isSafeInteger(required.sequence) || required.sequence < 1) {
    console.error("release: --sequence must be a positive safe integer");
    process.exit(1);
  }
  const manifest = await releaseArtifacts(required);
  console.log(
    `release: wrote ${required.channel}-${required.platform}-${required.arch}-{update.json,patch.bsdiff,full.tar.zst}`,
  );
  console.log(
    `release: ${required.version} (from ${required.fromVersion}), full=${manifest.fullSize} bytes, key=${manifest.keyId}`,
  );
}

if (import.meta.main) {
  await main();
}
