# Publishing

Phase 11 — the npm package and docs. This site is the docs half. The npm half is
**not yet publishable**; this page records exactly why and what's needed, so the
work doesn't have to be re-derived.

## Blocker: native artifacts

`bunium` is not pure JS. `src/native.ts` `dlopen`s the built shim dylib
(`native/build/bunium_shim.dylib`) and needs CEF's framework, the subprocess
binary, and a resources dir at runtime, resolved from `BUNIUM_SHIM_PATH` /
`BUNIUM_SUBPROCESS_PATH` / `BUNIUM_FRAMEWORK_DIR` (dev defaults point into this
repo's tree).

A published package must ship (or fetch at install time) these artifacts:

- the native shim dylib per platform/arch (macOS arm64 today; Linux/Windows
  when Phases 6/7 land), built by `native/mac/build.sh` — currently
  git-ignored (`native/build/`); and
- the trimmed CEF distribution (see [Packaging](/guide/packaging) — ~335MB
  packaged app, ~130MB compressed CEF per platform), which cannot go in the npm
  tarball or the repo.

This is an artifact-pipeline problem (a per-platform build/release CI that emits
the dylib + CEF bundle alongside versioned JS), not a packaging-metadata problem.
Options to evaluate when that work starts: platform-scoped npm packages
(`bunium-macos-arm64`-style) resolved at runtime, or a postinstall fetch of the
CEF bundle from a release host.

## What the repo has today

- `package.json` is `"private": true`, `"main": "src/index.ts"` — source is
  shipped as-is and run by Bun directly (no build step for consumers).
- `create-bunium-app` templates consume via a `file:` dependency and typecheck
  clean — the import path `bunium` works.
- `vendor/` (388M CEF distro) is git-ignored; a `files` whitelist must be added
  to `package.json` before any publish so the tarball never includes it.

## Docs

Built with VitePress (this site). API reference is transcribed from the typed
public exports in `src/index.ts`; keep it in sync whenever the public surface
changes. Local dev:

```sh
cd docs && bun install && bun run dev     # http://localhost:5173
bun run --cwd docs build                  # static build
```

## Remaining, in rough order

1. Release pipeline: build shim + trim CEF per platform, publish artifacts to a
   static host.
2. `package.json` publish metadata: `files`/`.npmignore`, `exports`, remove
   `private`.
3. Publish `bunium` to npm; publish `create-bunium-app` (its templates already
   reference `bunium` by package name).
4. CI per OS (can't cross-build a signed DMG from Linux CI).
5. License + repo hosting decisions (still open in PLAN.md).
