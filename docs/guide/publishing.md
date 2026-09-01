# Publishing

> Maintainer reference for bunium's own release pipeline — not needed to build or
> ship an app made with bunium. See [Packaging](/guide/packaging) for that.

How `bunium`, its three platform packages, and `create-bunium-app` get built and
published to npm.

## How a published package finds its native bits

`bunium` is not pure JS. `src/native.ts` `dlopen`s the built shim dylib and
needs CEF's framework, the subprocess binary, and a resources dir at runtime.
Resolution (all in `src/paths.ts`), per artifact, first-match-wins:

1. **Env vars** (`BUNIUM_SHIM_PATH` / `BUNIUM_SUBPROCESS_PATH` /
   `BUNIUM_FRAMEWORK_DIR`) — the Mode 1 packaged-app launcher path, unchanged.
2. **The dev tree** — `native/build/` (or `native/build-linux/` on Linux) +
   the vendored CEF distro present (this repo).
3. **Platform package** — a sibling `bunium-<platform>-<arch>` package (e.g.
   `bunium-darwin-arm64`, `bunium-linux-x64`, `bunium-win32-x64`) in the
   consumer's `node_modules`. Layout differs slightly by platform (mirroring
   each platform's own CEF distro shape):

   **macOS** (`bunium-darwin-arm64`):

   ```
   shim/bunium_shim.dylib
   shim/bunium_subprocess
   shim/{libEGL,libGLESv2,libcef_sandbox}.dylib + *.json   # ANGLE, next to
                                                          # the subprocess
   framework/Chromium Embedded Framework.framework/       # CEF, trimmed
   ```

   Shared shim+subprocess CEF install name is `@loader_path/../framework/...`
   (both binaries live in `shim/`), so the package is location-independent —
   no dev-tree absolute paths leak.

   **Linux** (`bunium-linux-x64`/`bunium-linux-arm64`):

   ```
   shim/bunium_shim.so
   shim/bunium_subprocess
   framework/   libcef.so + icudtl.dat + v8_context_snapshot.bin +
                chrome_*.pak/resources.pak + locales/ -- merged into one dir
   ```

   `bunium_shim.so`/`bunium_subprocess` carry an `$ORIGIN`-relative rpath
   baked in at build time, so no install-name rewrite step is needed — pure
   file copies are location-independent already.

   **Windows** (`bunium-win32-x64`):

   ```
   shim/bunium_shim.dll
   shim/bunium_subprocess.exe
   framework/   libcef.dll + chrome_elf.dll + ANGLE/d3dcompiler DLLs +
                icudtl.dat + v8_context_snapshot.bin + chrome_*.pak/
                resources.pak + locales/ -- merged into one dir (locales/
                MUST sit directly under framework/, since bunium_shim.cpp
                derives locales_dir_path as "<resourcesDir>/locales")
   ```

   Windows resolves `bunium_shim.dll`'s `libcef.dll` import via the normal
   DLL search order, so no rewrite step is needed there either.

   All three: `BUNIUM_NATIVE_PACKAGE` overrides the package name (resolution
   testing). The JS package's `optionalDependencies` list all three platform
   packages, pinned to the same version — npm's `os`/`cpu` gating on each
   platform package's own `package.json` means only the matching one ever
   actually installs.

## The release pipeline

Locally, one staging script per platform (each needs that platform's own
built native artifacts + vendored CEF distro present -- there is no
cross-build path):

- **macOS**: `bun run release:artifacts` (`scripts/stage-release-artifacts.sh`)
  produces `dist-release/bunium-darwin-arm64/` (trimmed CEF + shim +
  subprocess + ANGLE, install names re-aimed) + an archive
  `bunium-darwin-arm64-<version>.tar.gz`. Trim lives in
  `packaging/mac/cef-trim.sh`, shared with the app packager.
- **Linux**: `bun run release:artifacts:linux`
  (`scripts/stage-release-artifacts-linux.sh`) produces
  `dist-release/bunium-linux-<arch>/` (arch auto-detected via `uname -m`) +
  its archive. No install-name rewrite needed (`$ORIGIN`-relative rpath
  already makes the binaries location-independent).
- **Windows** (run on a Windows box, Git Bash): `bun run release:artifacts:win`
  (`scripts/stage-release-artifacts-win.sh`) produces
  `dist-release/bunium-win32-x64/` + its archive. No rewrite needed either
  (DLL search order resolves `libcef.dll` from the same directory).

**CI (`.github/workflows/release.yml`, tag `v*`):** three parallel jobs, one
per platform, each on its native runner (`macos-14`, `ubuntu-latest`,
`windows-latest`):

- **darwin-arm64**: downloads the pinned CEF distro
  (`cef_binary_<version>_macosarm64_minimal.tar.bz2`, sha1-verified against
  `CEF_SHA1`), builds the `libcef_dll_wrapper` cmake target, builds the shim
   - subprocess, stages the platform package, verifies the installed-consumer
     path, attaches the archive to the release. Note the CDN path: the old
     `downloads/cef_binaries/<version>/...` prefix 404s (index.json URLs no
     longer resolve); flat
     `https://cef-builds.spotifycdn.com/cef_binary_<version>_macosarm64_minimal.tar.bz2`
     works. Bump `CEF_VERSION`/`CEF_SHA1` together when upgrading `vendor/`.
- **linux-x64**: installs the same apt package list `linux-smoke.yml`/
  `docker/linux/Dockerfile` use, fetches CEF via `docker/linux/fetch-cef.sh`
  (its own pinned version/sha1, reused as-is rather than duplicated in the
  workflow), builds via `native/linux/build.sh`, stages, verifies, attaches.
- **win32-x64**: installs clang-cl via chocolatey (skipped if already
  present), fetches the Windows CEF distro (repo variable `CEF_ZIP_URL`
  overrides the fallback URL, same convention as `win-smoke.yml`), builds via
  `native/win/build.sh`, stages, verifies, attaches.

**Verification:** `scripts/verify-platform-package.sh` /
`scripts/verify-platform-package-linux.sh` /
`scripts/verify-platform-package-win.sh` each rebuild a consumer sandbox
(materialized `bunium` + the staged platform package as a sibling, no dev
tree reachable) and run a real window that pixel-verifies a green page —
the installed-consumer path, PASS locally and in CI before the release
upload.

## Publishing a release

Tag `v<version>` (matching `package.json`'s version on all packages) and
push it — `release.yml` does the rest: each platform job builds its native
artifacts on its own OS-native runner, stages the platform package, verifies
the installed-consumer path, attaches the archive to a GitHub Release, then
publishes that platform package to npm. A final job waits on all three and
publishes `bunium` + `create-bunium-app` once every platform package they
depend on (via `optionalDependencies`, pinned to the same version) is live.

Requires an `NPM_TOKEN` repository secret — an npm
[automation token](https://docs.npmjs.com/creating-and-viewing-access-tokens)
with publish rights on `bunium`, `bunium-darwin-arm64`, `bunium-linux-x64`,
`bunium-win32-x64`, and `create-bunium-app`.

`npm publish --dry-run` (run locally) validates a tarball without
credentials — useful for checking package contents before tagging (root:
src/ + LICENSE only, ~35 kB; each platform package: 100-300 MB,
os/cpu-guarded).

## Docs

Built with VitePress (this site). API reference is transcribed from the typed
public exports in `src/index.ts`; keep it in sync whenever the public surface
changes. Local dev:

```sh
cd docs && bun install && bun run dev     # http://localhost:5173
bun run --cwd docs build                  # static build
```
