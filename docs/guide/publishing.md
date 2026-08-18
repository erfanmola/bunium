# Publishing

Phase 11 — the npm package and docs. This site is the docs half. The
runtime-resolution and artifact-staging halves are implemented and verified
locally (2026-08-18); actually publishing still needs a couple of decisions

- credentials, listed at the bottom.

## How a published package finds its native bits

`bunium` is not pure JS. `src/native.ts` `dlopen`s the built shim dylib and
needs CEF's framework, the subprocess binary, and a resources dir at runtime.
Resolution (all in `src/paths.ts`), per artifact, first-match-wins:

1. **Env vars** (`BUNIUM_SHIM_PATH` / `BUNIUM_SUBPROCESS_PATH` /
   `BUNIUM_FRAMEWORK_DIR`) — the Mode 1 packaged-app launcher path, unchanged.
2. **The dev tree** — `native/build/` + `vendor/cef-macosarm64/...` files
   present (this repo).
3. **Platform package** — a sibling `bunium-<platform>-<arch>` package (e.g.
   `bunium-darwin-arm64`) in the consumer's `node_modules`, laid out as:

   ```
   shim/bunium_shim.dylib
   shim/bunium_subprocess
   shim/{libEGL,libGLESv2,libcef_sandbox}.dylib + *.json   # ANGLE, next to
                                                          # the subprocess
   framework/Chromium Embedded Framework.framework/       # CEF, trimmed
   ```

   Shared shim+subprocess CEF install name is `@loader_path/../framework/...`
   (both binaries live in `shim/`), so the package is location-independent —
   no dev-tree absolute paths leak. `BUNIUM_NATIVE_PACKAGE` overrides the
   package name (resolution testing). At publish time the JS package should
   add the platform package as an `optionalDependency` pinned to the same
   version.

## The release pipeline

Locally: `bun run release:artifacts` (`scripts/stage-release-artifacts.sh`)
produces `dist-release/bunium-darwin-arm64/` — the publishable platform
package (trimmed CEF + shim + subprocess + ANGLE, install names re-aimed) —
plus an archive `bunium-darwin-arm64-<version>.tar.gz` for a release host. The
CEF resource trim lives in `packaging/mac/cef-trim.sh`, shared with the app
packager.

**CI (`.github/workflows/release.yml`, tag `v*`):** on a fresh macOS arm64
runner it downloads the same CEF distro (`cef_binary_<version>_macosarm64_minimal.tar.bz2`,
sha1-verified against the pinned `CEF_SHA1` env var), builds the
`libcef_dll_wrapper` cmake target, builds the shim + subprocess, stages the
platform package, runs the installed-consumer verification, and attaches the
archive to a GitHub Release. Note the CDN path: the old
`downloads/cef_binaries/<version>/...` prefix 404s (index.json URLs no longer
resolve); flat `https://cef-builds.spotifycdn.com/cef_binary_<version>_macosarm64_minimal.tar.bz2`
works. Bump `CEF_VERSION`/`CEF_SHA1` (index.json value) together when upgrading
`vendor/`.

**Verification:** `scripts/verify-platform-package.sh` rebuilds a consumer
sandbox (`dist-release/_consumer/`: materialized `bunium` + platform package,
no dev tree) and runs a real window that pixel-verifies a green page —
the installed-consumer path, PASS locally and in CI before the release upload.

## What still blocks a real publish

1. **npm credentials** — publish `bunium`, then `bunium-darwin-arm64`
   (from the staged dir: `npm publish dist-release/bunium-darwin-arm64`),
   then `create-bunium-app` (its templates already reference `bunium`).
   Requires an npm account/token; `"private": true` must come off
   `package.json` (both packages) at that point, and the JS package should
   add the platform package as an `optionalDependency` pinned to the same
   version before publishing. The release workflow only runs on tags, so tag
   `v0.0.1` first to exercise it.
2. **Other platforms** — Linux/Windows artifacts don't exist yet (Phases 6/7).

## Docs

Built with VitePress (this site). API reference is transcribed from the typed
public exports in `src/index.ts`; keep it in sync whenever the public surface
changes. Local dev:

```sh
cd docs && bun install && bun run dev     # http://localhost:5173
bun run --cwd docs build                  # static build
```
