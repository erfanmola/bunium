// Resolution of native artifact paths (shim dylib, subprocess binary, CEF
// framework dir) across the three run modes bunium supports:
//
//   1. Packaged apps (Phase 8): the .app launcher exports
//      BUNIUM_SHIM_PATH/BUNIUM_SUBPROCESS_PATH/BUNIUM_FRAMEWORK_DIR pointing
//      into the bundle's Contents/Frameworks, then execs bun. Env wins.
//   2. The dev tree (this repo): native/build/ + vendor/cef-macosarm64/...
//      exist, used as the default fallback.
//   3. Installed npm consumers (Phase 11): the JS package ships no native
//      artifacts; they come from a platform-scoped sibling package
//      `bunium-<platform>-<arch>` (e.g. bunium-darwin-arm64) declared as an
//      optionalDependency, laid out as:
//        shim/bunium_shim.dylib, shim/bunium_subprocess, shim/*.dylib|json
//        framework/Chromium Embedded Framework.framework/(Resources/...)
//
// Each key resolves independently (env -> dev tree -> platform package), so
// a packaged app that sets only BUNIUM_SHIM_PATH still gets its framework
// from a platform package if one is installed. BUNIUM_NATIVE_PACKAGE
// overrides the platform-package name (used to test resolution against a
// staged copy without publishing).
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repoRoot = new URL("..", import.meta.url).pathname;

interface NativePaths {
  shim: string;
  subprocess: string;
  frameworkDir: string;
}

const DEV_PATHS: NativePaths = {
  shim: `${repoRoot}native/build/bunium_shim.dylib`,
  subprocess: `${repoRoot}native/build/bunium_subprocess`,
  frameworkDir: `${repoRoot}vendor/cef-macosarm64/Release/Chromium Embedded Framework.framework`,
};

function devTreePresent(): boolean {
  return (
    existsSync(DEV_PATHS.shim) &&
    existsSync(DEV_PATHS.subprocess) &&
    existsSync(DEV_PATHS.frameworkDir)
  );
}

// Locate the platform package bunium-<platform>-<arch> in the node_modules
// tree this file was resolved from (i.e. the consumer's install, which may
// be inside a packaged app's materialized node_modules). Returns its
// directory, or null when not installed.
let cachedPkgBase: string | null | undefined;
function platformPackageBase(): string | null {
  if (cachedPkgBase !== undefined) return cachedPkgBase;

  const platform = process.platform; // darwin | linux | win32
  const arch = process.arch; // arm64 | x64 | ...
  const name =
    process.env.BUNIUM_NATIVE_PACKAGE ?? `bunium-${platform}-${arch}`;
  try {
    const resolved = import.meta.resolve(`${name}/package.json`);
    if (resolved.startsWith("file:")) {
      const pkgJson = fileURLToPath(resolved);
      cachedPkgBase = pkgJson.replace(/\/package\.json$/, "");
    } else {
      cachedPkgBase = null;
    }
  } catch {
    cachedPkgBase = null;
  }
  return cachedPkgBase;
}

function platformPackagePaths(): NativePaths | null {
  const base = platformPackageBase();
  if (!base) return null;
  return {
    shim: `${base}/shim/bunium_shim.dylib`,
    subprocess: `${base}/shim/bunium_subprocess`,
    frameworkDir: `${base}/framework/Chromium Embedded Framework.framework`,
  };
}

/** Resolve one artifact path: env override -> dev tree -> platform package. */
function resolve(key: keyof NativePaths): string {
  const envValue = process.env[`BUNIUM_${keyToEnvSuffix(key)}`];
  if (envValue) return envValue;
  if (devTreePresent()) return DEV_PATHS[key];
  return platformPackagePaths()?.[key] ?? DEV_PATHS[key];
}

function keyToEnvSuffix(key: keyof NativePaths): string {
  switch (key) {
    case "shim":
      return "SHIM_PATH";
    case "subprocess":
      return "SUBPROCESS_PATH";
    case "frameworkDir":
      return "FRAMEWORK_DIR";
  }
}

export const paths = {
  shim: resolve("shim"),
  subprocess: resolve("subprocess"),
  frameworkDir: resolve("frameworkDir"),
  get resourcesDir() {
    return `${this.frameworkDir}/Resources`;
  },
};
