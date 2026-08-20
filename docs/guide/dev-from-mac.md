# Developing the Windows port from macOS

Windows CEF can't run on macOS directly — and there's no Docker escape hatch:
Docker Desktop on macOS only runs Linux containers, and MS Windows containers
only ever run on Windows hosts. Apple-silicon `Parallels`/`UTM` Windows-on-ARM
VMs emulate x64 apps but CEF's GPU/child-process stack is flaky under that
emulation, so treat those as a "sometimes useful, never primary" option.

The workable model is a **remote Windows runner** with two tiers.

## Tier 1 — per-PR smoke on GitHub Actions (primary)

`.github/workflows/win-smoke.yml` builds the native stack on `windows-latest`
and runs `examples/basic-window.ts` as the smoke test. It needs no Visual
Studio — clang-cl + the CEF distro only (see `docs/guide/windows.md`). Since
Windows packaging landed, the same job also runs `packaging/win/package.sh`
on the fixture app and **verifies the packaged EXE end-to-end** (opens a
real window, pixel-checks the page, requires `PACKAGED_APP_VERIFY:PASS`) —
so a mac dev gets Windows packaging CI coverage on every PR, not just the
dev-tree build.

- Runs on every PR touching `native/**` / `src/**` and on `main`.
- The CEF distro is git-ignored (388 MB), so the workflow downloads the
  pinned distro. Set a repo **variable** `CEF_ZIP_URL` (Actions → Settings →
  Variables) to the exact `cef_binary_*_windows64_minimal.zip` URL matching
  the vendored `vendor/cef-windows-x64/include/cef_version.h`; otherwise the
  job falls back to the same URL hardcoded in the workflow and fails early
  with instructions if it drifts. Find the URL at
  https://cef-builds.spotifycdn.com/ (Windows 64-bit, Minimal Distribution).
- Native artifacts and CEF logs are uploaded as workflow artifacts so a mac
  dev can download and inspect them without a Windows box.

## Tier 2 — SSH remote runner (ad-hoc iteration)

For times when a PR won't cut it (iterating on a Windows-only crash, watching
live logs), run a Windows machine — a cloud VM or an old laptop — and use
`scripts/win-remote.sh`:

```sh
# one-time: push the tree incl. the CEF distro and build remotely
scripts/win-remote.sh push hostname@windows-host
# iterate: sync + build + run the smoke, streaming logs back to your mac
scripts/win-remote.sh smoke hostname@windows-host
# packaging: sync + build + package + verify the packaged app end-to-end
scripts/win-remote.sh pack hostname@windows-host
```

The script assumes Git Bash + LLVM's clang-cl are on the remote host
(`PATH`-reachable), rsync over ssh, and that `vendor/cef-windows-x64` is in
the pushed tree (CEF is git-ignored — this is the one thing `push` carries
explicitly). Run `win-remote.sh --help` for details.

## Always reproduce locally first

Whatever the remote story, a Windows dev box remains the source of truth. The
escape hatches that worked during bring-up (`--single-process`, GPU feature
flags) were diagnostics only — multi-process works now; don't paper over
child-process issues with single-process hacks (bun + in-process CEF SEGVs).

## Quick checklist when a child misbehaves

1. Rebuild once (`bash native/win/build.sh`) — stale wrapper/dll copies hide
   under `native/build/`.
2. Grab a minidump + cdb stack: `docs/guide/windows.md` → "Debugging children".
3. Verify the wrapper in use is `native/build/wrapclang/libcef_dll_wrapper.lib`
   (non-bootstrap, per the `CEF_USE_BOOTSTRAP` note).