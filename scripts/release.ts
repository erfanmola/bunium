#!/usr/bin/env bun
// Phase 9 release tooling: produce the flat artifact set a static host
// serves for the auto-updater (src/update.ts), from two app-layer trees.
//
// Usage (from repo root):
//   bun scripts/release.ts \
//     --name myapp --channel stable --platform mac --arch arm64 \
//     --version 1.0.2 --from-version 1.0.1 \
//     --old path/to/previous/dist --new path/to/current/dist --out out/
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
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPatch } from "../src/bsdiff";
import { collectDirectory, writeTar } from "../src/tar";
import type { Arch, Platform, UpdateManifest } from "../src/update";

export interface ReleaseOptions {
  name: string;
  channel: string;
  platform: Platform;
  arch: Arch;
  version: string;
  fromVersion: string;
  oldTreeDir: string;
  newTreeDir: string;
  outDir: string;
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
): Promise<UpdateManifest> {
  const { name, channel, platform, arch, version, fromVersion, outDir } =
    options;
  const prefix = `${channel}-${platform}-${arch}`;

  const prev = await buildFullBundle(options.oldTreeDir);
  const curr = await buildFullBundle(options.newTreeDir);
  const patch = await buildPatch(prev.tar, curr.tar);

  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, `${prefix}-patch.bsdiff`), patch);
  await writeFile(join(outDir, `${prefix}-full.tar.zst`), curr.zst);

  const manifest: UpdateManifest = {
    name,
    channel,
    version,
    fromVersion,
    platform,
    arch,
    fullSize: curr.tar.length,
    sha256: curr.sha256,
  };
  await writeFile(
    join(outDir, `${prefix}-update.json`),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const get = (flag: string): string => {
    const i = args.indexOf(flag);
    return i !== -1 && args[i + 1] ? args[i + 1]! : "";
  };
  const required: ReleaseOptions = {
    name: get("--name"),
    channel: get("--channel") || "stable",
    platform: get("--platform") as Platform,
    arch: get("--arch") as Arch,
    version: get("--version"),
    fromVersion: get("--from-version"),
    oldTreeDir: get("--old"),
    newTreeDir: get("--new"),
    outDir: get("--out"),
  };
  for (const [key, value] of Object.entries(required)) {
    if (!value) {
      console.error(
        `release: missing --${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`,
      );
      process.exit(1);
    }
  }
  const manifest = await releaseArtifacts(required);
  console.log(
    `release: wrote ${required.channel}-${required.platform}-${required.arch}-{update.json,patch.bsdiff,full.tar.zst}`,
  );
  console.log(
    `release: ${required.version} (from ${required.fromVersion}), full=${manifest.fullSize} bytes`,
  );
}

if (import.meta.main) {
  await main();
}
