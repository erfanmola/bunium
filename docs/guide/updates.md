# Auto-update

Ships app-code updates as small binary-delta patches instead of re-downloading
everything. A separate signed runtime-installer route is available when the
Bunium/CEF pair changes; the updater downloads but never executes that OS
installer.

The updater requires Bun 1.4.0 or newer. Full-bundle decompression uses
`node:zlib.zstdDecompressSync` with `maxOutputLength` set from the signed
uncompressed-size declaration, so an unexpectedly large output fails before
the installer stages or replaces any files.

## Wiring

```ts
import {
  acknowledgeUpdateHealthy,
  beginUpdateHealthCheck,
  relaunchApp,
  updater,
} from "bunium";

// At process startup, before creating windows, start the pending candidate's
// one allowed health attempt. If its previous attempt crashed, restore and
// immediately relaunch the known-good app tree.
const installDir = process.env.BUNIUM_UPDATE_INSTALL_DIR;
const health = installDir
  ? await beginUpdateHealthCheck(installDir)
  : "none";
if (health === "rolled-back" && installDir) relaunchApp({ installDir });

// After creating the app and passing its own startup checks:
if (health === "pending" && installDir) {
  await acknowledgeUpdateHealthy(installDir);
}

// On update completion, pass the new tree path to the relaunch helper:
updater.on("ready", ({ dir }) =>
  updater.relaunch(() => relaunchApp({ installDir: dir })),
);
```

The app chooses when its own health criteria have passed; Bunium does not
assume that CEF initialization alone means the product is healthy. The update
keeps the previous app tree until `acknowledgeUpdateHealthy` succeeds. If the
first launch is not acknowledged before the process exits, the next startup
restores the previous tree. Call `beginUpdateHealthCheck` before creating
windows so that rollback happens before the candidate opens UI.

## API

```ts
export type Platform = "mac" | "linux" | "win";
export type Arch = "arm64" | "x64";

updater.check({ product, feedUrl, currentVersion, runtimeVersion, cefVersion, currentOsVersion, currentSequence, channel?, platform?, arch?, trustedKeys });
// → { status: "up-to-date" } | { status: "update-available", update: { method: "patch"|"full", ... } }

updater.isUpToDate; // last check result
updater.install(update, { installDir }); // update came from check()
updater.relaunch((dir) => relaunchApp({ installDir: dir }));

// events: checking / downloadStarted / progress / applying / ready / relaunching / error
```

An update is served as a small JSON manifest plus either a patch or a full
archive, hosted anywhere static (S3, R2, GitHub Releases — no update server
needed). If the running version is more than one release behind, the updater
falls back to a full download rather than chaining patches. Every manifest is
Ed25519-signed. `trustedKeys` maps the manifest `keyId` to a trusted public-key
PEM; missing or unknown keys and invalid signatures fail closed. Keep signing
private keys in the release system and distribute public keys with the app.
Schema 2 is signed as compact UTF-8 JSON with object keys recursively sorted
lexicographically and the top-level `signature` field excluded. The app must
persist the installed release sequence and pass it as `currentSequence`;
replays, expired manifests, version rollback and runtime ABI mismatches fail.
`updateAbiVersion` identifies the manifest/apply format supported by this
runtime and must be incremented when compatibility breaks. The signed
compatibility envelope binds each artifact set to an exact Bunium and CEF
version, requires minimum Bun and OS versions, and declares
`payloadKind: "application-tree-v1"`. The client checks those constraints
before selecting an artifact. `currentOsVersion` must be supplied by the host
using the platform's three-component numeric version; do not substitute a
kernel version for the OS version.
The signature also covers the exact patch/full artifact filenames, byte sizes,
and SHA-256 digests. The client verifies the downloaded artifact before
applying a patch or decompressing the full bundle.

## Runtime installer route

Runtime manifests use the same signed update endpoint and sequence, but declare
`payloadKind: "runtime-installer-v1"`, the previous Bunium/CEF pair, the target
pair, a platform-specific installer format, and one exact-size/SHA-256
artifact. Its target cannot downgrade either currently installed version, so a
full runtime installer can move a client across skipped intermediate releases.
The selected OS/architecture must match the manifest. Existing app-tree
manifests keep their schema-2 shape; older clients
reject the new payload kind before downloading it.

`check()` returns `runtime-installer-available`. Pass its `update` to
`downloadRuntimeInstaller(update, { directory })` after the user chooses where
to save it. The method verifies the signed size/hash, refuses to overwrite an
existing file, and emits `runtimeInstallerReady`. It does not replace app files,
launch the installer, request elevation, or acknowledge app-tree health. The
caller must show the file and let the user use the OS's installation flow.
`updater.install()` explicitly rejects runtime-installer updates.

Accepted routing formats are `.pkg` on macOS, `.msi` on Windows, and `.deb`,
`.rpm`, or `.AppImage` on Linux. Linux output is a download for the user to apply
through their chosen package-manager/manual policy. Manifest signing and
artifact hashing do not replace platform package signing; production packages
still need the relevant OS signature. No installer is executed by this API.

The runtime release helper is `bun run release:update:runtime`; it stages a
single installer and signed manifest from an existing platform package. Its
fixtures use dummy bytes and do not establish native install/recovery behavior.

```sh
bun run release:update:runtime --product <app-id> --channel stable \
  --platform mac --arch arm64 --version <app-version> --sequence <sequence> \
  --from-runtime-version <old-bunium> --from-cef-version <old-cef> \
  --runtime-version <new-bunium> --cef-version <new-cef> \
  --minimum-bun-version <version> --minimum-os-version <version> \
  --installer-format mac-pkg --installer <signed-package.pkg> --out <dir> \
  --key-id <key-id> --signing-key <private-ed25519-pem>
```

Formats are `mac-pkg`, `windows-msi`, `linux-deb`, `linux-rpm`, and
`linux-appimage`; each is accepted only for its matching platform. The release
helper signs the manifest and records the installer hash. It does not create,
OS-sign, install, or publish a package.

## Releasing an update

```sh
bun run release:update --product <app-id> --channel stable \
  --platform mac --arch arm64 --version <new-version> \
  --from-version <previous-version> --sequence <monotonic-number> \
  --old <prev-dist> --new <cur-dist> --out <dir> \
  --runtime-version <bunium-version> --cef-version <cef-version> \
  --minimum-bun-version <version> --minimum-os-version <version> \
  --key-id <key-id> \
  --signing-key <private-ed25519-pem>
```

Emits a signed manifest + patch + full archive for your static host. Publishing
them is up to you (no feed CI built in). Do not place private keys in source
control or pass them through logged command arguments in production.

Related: [Packaging](/guide/packaging).
