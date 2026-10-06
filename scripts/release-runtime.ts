#!/usr/bin/env bun
import { readFile } from "node:fs/promises";
import type { Arch, Platform, RuntimeInstallerFormat } from "../src/update";
import { releaseRuntimeInstaller } from "./release";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const get = (flag: string): string => {
    const index = args.indexOf(flag);
    return index >= 0 ? (args[index + 1] ?? "") : "";
  };
  const keyPath = get("--signing-key");
  const required = {
    product: get("--product"),
    channel: get("--channel") || "stable",
    platform: get("--platform") as Platform,
    arch: get("--arch") as Arch,
    version: get("--version"),
    sequence: Number(get("--sequence")),
    fromRuntimeVersion: get("--from-runtime-version"),
    fromCefVersion: get("--from-cef-version"),
    runtimeVersion: get("--runtime-version"),
    cefVersion: get("--cef-version"),
    minimumBunVersion: get("--minimum-bun-version"),
    minimumOsVersion: get("--minimum-os-version"),
    installerFormat: get("--installer-format") as RuntimeInstallerFormat,
    installerPath: get("--installer"),
    outDir: get("--out"),
    keyId: get("--key-id"),
    signingKeyPem: keyPath ? await readFile(keyPath, "utf8") : "",
  };
  for (const [name, value] of Object.entries(required)) {
    if (typeof value === "string" && !value) {
      throw new Error(`release: missing value for ${name}`);
    }
  }
  const manifest = await releaseRuntimeInstaller(required);
  console.log(
    `release: wrote ${required.channel}-${required.platform}-${required.arch}-update.json and ${manifest.installerArtifact.file}`,
  );
  console.log(
    `release: runtime ${required.fromRuntimeVersion} -> ${required.runtimeVersion}, CEF ${required.fromCefVersion} -> ${required.cefVersion}, key=${manifest.keyId}`,
  );
}

if (import.meta.main) await main();
