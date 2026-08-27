# Packaging

Produces a distributable app for macOS, Windows, or Linux from your built app
directory (`electron/main.ts` + your built static output — see
[Minimum app shape](#minimum-app-shape)).

## macOS

```sh
bun run pack:mac -a <app-dir> [-n Name] [-i com.example.name] [-o out] \
  [-v ver] [-c icon.icns] [--no-dmg]
```

Produces `dist-app/Name.app`, ad-hoc codesigned, plus a `.dmg` unless
`--no-dmg`. CEF resources are trimmed by default (smaller app, English-only
browser chrome); pass `--no-trim` to keep everything, or
`--locales en,de,fr` to keep specific locales.

## Linux

```sh
bun run pack:linux -a <app-dir> [-n Name] [-o out] [--locales en[,de,...]] [--no-trim]
```

Produces a flat `dist-app/Name/` runnable directory. Real distribution formats
build from that output:

```sh
bun run pack:linux:deb -p dist-app/Name [-o out] [-m "Maintainer <email>"]
bun run pack:linux:rpm -p dist-app/Name [-o out]
bun run pack:linux:appimage -p dist-app/Name [-o out]
```

No package signing on Linux (no distro-wide convention the way macOS/Windows
have one).

## Windows

```sh
bun run pack:win -a <app-dir> [-n Name] [-o out] [--locales en[,de,...]] [--no-trim]
```

Produces a flat `dist-app/Name/` directory with `Name.exe`. Must run on Windows
(or from macOS via [the remote runner](/guide/dev-from-mac)). No code signing
applied — sign the output yourself if you need SmartScreen-clean distribution.

## Minimum app shape

The `-a` app dir must contain `electron/main.ts` (or `.js`) plus the built static
output the main process serves via `app.setAppRoot()` + `loadURL("bunium://app/")`.
A scaffolded [`create-bunium-app`](/guide/getting-started) project already has
this shape — `bun run build` produces it.

## Known gaps

- macOS: notarization/Developer ID signing needs your own Apple credentials —
  ad-hoc signing works for local use.
- Linux: `Menu.setAsApplicationMenu()` is a no-op (no cross-desktop convention);
  use `tray.setMenu()` for a real menu — see [System features](/guide/system).
- Linux/Windows sign-off is manual; there's no built-in signing step.

Related: [Auto-update](/guide/updates), [System features](/guide/system).
