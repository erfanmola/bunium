// Resolution of native artifact paths (shim library, subprocess binary, CEF
// runtime dir) across the three run modes bunium supports:
//
//   1. Packaged apps (Phase 8): the app launcher exports
//      BUNIUM_SHIM_PATH/BUNIUM_SUBPROCESS_PATH/BUNIUM_FRAMEWORK_DIR pointing
//      into the bundle's native dirs, then execs bun. Env wins.
//   2. The dev tree (this repo): native/build/ + vendor/<platform cef>/...
//      exist, used as the default fallback.
//   3. Installed npm consumers (Phase 11): the JS package ships no native
//      artifacts; they come from a platform-scoped sibling package
//      `bunium-<platform>-<arch>` (e.g. bunium-darwin-arm64 or
//      bunium-win32-x64) declared as an optionalDependency, laid out as:
//        shim/bunium_shim.{dylib,dll}, shim/bunium_subprocess[.exe]
//        framework/  (CEF runtime: macOS framework bundle, or the Windows
//                     resources dir + libcef.dll)
//
// Per platform, CEF's layout differs -- macOS ships a framework bundle whose
// resources live in <fw>/Resources and libraries inside the bundle; Windows
// ships a flat dist split into Release/ (libcef.dll) and Resources/ (paks,
// icudtl.dat, locales/). frameworkDir carries the platform's CEF root and
// resourcesDir the exact dir passed to bunium_init's resources_dir_path.
//
// Each key resolves independently (env -> dev tree -> platform package), so
// a packaged app that sets only BUNIUM_SHIM_PATH still gets its framework
// from a platform package if one is installed. BUNIUM_NATIVE_PACKAGE
// overrides the platform-package name (used to test resolution against a
// staged copy without publishing).
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const isWin = process.platform === "win32";
const isLinux = process.platform === "linux";
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

interface NativePaths {
  shim: string;
  subprocess: string;
  frameworkDir: string;
  resourcesDir: string;
}

// Linux CEF distro dir name follows native/linux/build.sh's own
// BUNIUM_LINUX_ARCH convention (cef-linuxarm64 / cef-linux64) -- mirrored
// here so the dev-tree path matches whatever the build script produced.
const linuxCefDir =
  process.arch === "arm64" ? "cef-linuxarm64" : "cef-linux64";

const DEV_PATHS: NativePaths = isWin
  ? {
      shim: `${repoRoot}native/build/bunium_shim.dll`,
      subprocess: `${repoRoot}native/build/bunium_subprocess.exe`,
      // Windows CEF has no framework bundle: Release/ is the DLL dir, and
      // resources_dir_path (Resources/) is what bunium_init needs -- see
      // the locales_dir_path derivation in bunium_shim.cpp.
      frameworkDir: `${repoRoot}vendor/cef-windows-x64/Release`,
      resourcesDir: `${repoRoot}vendor/cef-windows-x64/Resources`,
    }
  : isLinux
    ? {
        shim: `${repoRoot}native/build/bunium_shim.so`,
        subprocess: `${repoRoot}native/build/bunium_subprocess`,
        // Same flat Release/Resources split as Windows -- no framework
        // bundle on Linux either. native/linux/build.sh copies libcef.so +
        // icudtl.dat + v8_context_snapshot.bin next to the built artifacts
        // (native/build/) so an $ORIGIN-relative rpath resolves them
        // without needing this dir at runtime for the .so itself, but
        // resources_dir_path still needs the real Resources/ tree (locales
        // etc).
        frameworkDir: `${repoRoot}vendor/${linuxCefDir}/Release`,
        resourcesDir: `${repoRoot}vendor/${linuxCefDir}/Resources`,
      }
    : {
        shim: `${repoRoot}native/build/bunium_shim.dylib`,
        subprocess: `${repoRoot}native/build/bunium_subprocess`,
        frameworkDir: `${repoRoot}vendor/cef-macosarm64/Release/Chromium Embedded Framework.framework`,
        resourcesDir: `${repoRoot}vendor/cef-macosarm64/Release/Chromium Embedded Framework.framework/Resources`,
      };

function devTreePresent(): boolean {
  return (
    existsSync(DEV_PATHS.shim) &&
    existsSync(DEV_PATHS.subprocess) &&
    existsSync(DEV_PATHS.resourcesDir)
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
      cachedPkgBase = pkgJson.replace(/[\\/]package\.json$/, "");
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
  if (isWin) {
    return {
      shim: `${base}/shim/bunium_shim.dll`,
      subprocess: `${base}/shim/bunium_subprocess.exe`,
      frameworkDir: `${base}/framework`,
      resourcesDir: `${base}/framework`,
    };
  }
  if (isLinux) {
    return {
      shim: `${base}/shim/bunium_shim.so`,
      subprocess: `${base}/shim/bunium_subprocess`,
      frameworkDir: `${base}/framework`,
      resourcesDir: `${base}/framework`,
    };
  }
  return {
    shim: `${base}/shim/bunium_shim.dylib`,
    subprocess: `${base}/shim/bunium_subprocess`,
    frameworkDir: `${base}/framework/Chromium Embedded Framework.framework`,
    resourcesDir: `${base}/framework/Chromium Embedded Framework.framework/Resources`,
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
    case "resourcesDir":
      return "RESOURCES_DIR";
  }
}

export const paths = {
  shim: resolve("shim"),
  subprocess: resolve("subprocess"),
  frameworkDir: resolve("frameworkDir"),
  resourcesDir: resolve("resourcesDir"),
};