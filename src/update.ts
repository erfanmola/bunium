// Phase 9: client-side auto-update for bunium apps.
//
// Design (see PLAN.md §9):
// - Delta patches via vendored bsdiff (native shim, src/bsdiff.ts), generated
//   against the previous release's deterministic tar archive. Anyone more than
//   one version behind falls back to the full zstd-compressed bundle.
// - The CEF binary is a separate, independently-versioned artifact (whole-file
//   replace on the rare CEF bump) -- this updater never touches it. It patches
//   only the app layer (the `dist/` folder + bunium native dylib), which is
//   exactly the artifact pair bsdiff is good at.
// - Reproducible archives matter: build-side and client-side tars of the same
//   tree must be byte-identical, or a patch built server-side won't apply
//   client-side. src/tar.ts pins mtimes/owners/order to guarantee that.
// - Flat, prefix-based artifact naming on a static host:
//     <feedUrl>/<channel>-<os>-<arch>-update.json
//     <feedUrl>/<channel>-<os>-<arch>-patch.bsdiff   (previous -> current)
//     <feedUrl>/<channel>-<os>-<arch>-full.tar.zst   (fallback)
// - Staged apply: everything lands in a sibling staging directory first (old
//   install untouched), then a single rename swap. A copy of the old tree is
//   kept as backup until the swap succeeds, then removed.
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomUUID,
  sign,
  verify,
} from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { applyPatch, patchExpectedOutputSize } from "./bsdiff";
import { collectDirectory, readTar, TAR_LIMITS, writeTar } from "./tar";

const MAX_MANIFEST_BYTES = 1024 * 1024;
export const MAX_UPDATE_ARTIFACT_BYTES =
  TAR_LIMITS.totalBytes + TAR_LIMITS.entries * 512 + 1024 * 1024;

/** Increment when an updater can no longer safely read/apply earlier manifests. */
export const updateAbiVersion = 2;

export type Platform = "mac" | "linux" | "win";
export type Arch = "arm64" | "x64";

export interface UpdateCheckOptions {
  /** Product identity expected by this app; must match the signed manifest. */
  product: string;
  /** Base URL of the static artifact host (no trailing slash needed). */
  feedUrl: string;
  /** Current installed version. Must match the manifest's `fromVersion` to
   *  use the delta patch instead of the full bundle. */
  currentVersion: string;
  /** Exact Bunium release used by the installed app. */
  runtimeVersion: string;
  /** Exact CEF version bundled with the installed app. */
  cefVersion: string;
  /** OS version in three-component numeric form (for example 14.0.0). */
  currentOsVersion: string;
  /** Persisted sequence for the installed release; prevents feed replay. */
  currentSequence: number;
  channel?: string;
  platform?: Platform;
  arch?: Arch;
  /** Trusted Ed25519 public keys indexed by manifest keyId. Empty means fail closed. */
  trustedKeys?: Readonly<Record<string, string>>;
}

interface UpdateManifestBase {
  schema: 2;
  product: string;
  runtimeAbi: number;
  /** Target runtime/CEF pair required by this payload. */
  runtimeVersion: string;
  cefVersion: string;
  /** Minimum Bun and OS versions required to launch the new app tree. */
  minimumBunVersion: string;
  minimumOsVersion: string;
  sequence: number;
  issuedAt: string;
  expiresAt: string;
  channel: string;
  version: string;
  platform: Platform;
  arch: Arch;
  keyId: string;
  signature: string;
}

/** App-tree updates keep the existing schema-2 wire shape. */
export interface ApplicationTreeManifest extends UpdateManifestBase {
  payloadKind: "application-tree-v1";
  fromVersion: string;
  fromSha256: string;
  patchArtifact: UpdateArtifact;
  fullArtifact: UpdateArtifact;
  /** Full uncompressed tar size, also the patch's expected output size. */
  fullSize: number;
  /** SHA-256 of the full uncompressed tar. */
  sha256: string;
}

export type RuntimeInstallerFormat =
  | "mac-pkg"
  | "windows-msi"
  | "linux-deb"
  | "linux-rpm"
  | "linux-appimage";

/** A separate signed installer artifact. The updater only downloads it; the
 *  caller must present it for an explicit, platform-owned installation. */
export interface RuntimeInstallerManifest extends UpdateManifestBase {
  payloadKind: "runtime-installer-v1";
  fromRuntimeVersion: string;
  fromCefVersion: string;
  installerFormat: RuntimeInstallerFormat;
  installerArtifact: UpdateArtifact;
}

export type UpdateManifest = ApplicationTreeManifest | RuntimeInstallerManifest;

export interface UpdateArtifact {
  file: string;
  size: number;
  sha256: string;
}

const runtimeInstallerExtensions: Record<RuntimeInstallerFormat, string> = {
  "mac-pkg": "pkg",
  "windows-msi": "msi",
  "linux-deb": "deb",
  "linux-rpm": "rpm",
  "linux-appimage": "AppImage",
};

function isRuntimeInstallerFormat(
  value: unknown,
): value is RuntimeInstallerFormat {
  return (
    typeof value === "string" &&
    Object.hasOwn(runtimeInstallerExtensions, value)
  );
}

export function runtimeInstallerFormatMatchesPlatform(
  format: RuntimeInstallerFormat,
  platform: Platform,
): boolean {
  return (
    (platform === "mac" && format === "mac-pkg") ||
    (platform === "win" && format === "windows-msi") ||
    (platform === "linux" && format.startsWith("linux-"))
  );
}

export function runtimeInstallerFileName(
  channel: string,
  platform: Platform,
  arch: Arch,
  runtimeVersion: string,
  format: RuntimeInstallerFormat,
): string {
  return `${channel}-${platform}-${arch}-runtime-${runtimeVersion}.${runtimeInstallerExtensions[format]}`;
}

type Unsigned<T> = Omit<T, "keyId" | "signature">;
export type UnsignedUpdateManifest =
  | Unsigned<ApplicationTreeManifest>
  | Unsigned<RuntimeInstallerManifest>;

function canonicalManifestBytes(manifest: Record<string, unknown>): Buffer {
  // Signed manifests use compact UTF-8 JSON with recursively sorted object keys;
  // arrays retain order and the top-level signature field is excluded.
  const sortKeys = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sortKeys);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((key) => [
            key,
            sortKeys((value as Record<string, unknown>)[key]),
          ]),
      );
    }
    return value;
  };
  const unsigned = Object.fromEntries(
    Object.keys(manifest)
      .filter((key) => key !== "signature")
      .map((key) => [key, manifest[key]]),
  );
  return Buffer.from(JSON.stringify(sortKeys(unsigned)), "utf8");
}

/** Creates an Ed25519-signed manifest. Keep private keys in the release system. */
export function signUpdateManifest(
  manifest: Unsigned<ApplicationTreeManifest>,
  keyId: string,
  privateKeyPem: string,
): ApplicationTreeManifest;
export function signUpdateManifest(
  manifest: Unsigned<RuntimeInstallerManifest>,
  keyId: string,
  privateKeyPem: string,
): RuntimeInstallerManifest;
export function signUpdateManifest(
  manifest: UnsignedUpdateManifest,
  keyId: string,
  privateKeyPem: string,
): UpdateManifest;
export function signUpdateManifest(
  manifest: UnsignedUpdateManifest,
  keyId: string,
  privateKeyPem: string,
): UpdateManifest {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(keyId)) {
    throw new Error("bunium: invalid update signing key id");
  }
  const payload = { ...manifest, keyId };
  const signature = sign(
    null,
    canonicalManifestBytes(payload),
    createPrivateKey(privateKeyPem),
  ).toString("base64");
  return { ...payload, signature };
}

function verifySignedManifest(
  input: unknown,
  trustedKeys: Readonly<Record<string, string>> | undefined,
): UpdateManifest {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("bunium: update manifest must be an object");
  }
  const raw = input as Record<string, unknown>;
  const keyId = raw.keyId;
  const signature = raw.signature;
  if (
    typeof keyId !== "string" ||
    !/^[A-Za-z0-9._-]{1,64}$/.test(keyId) ||
    typeof signature !== "string" ||
    signature.length !== 88
  ) {
    throw new Error("bunium: unsigned update manifest rejected");
  }
  const publicKeyPem = trustedKeys?.[keyId];
  if (
    !trustedKeys ||
    !Object.hasOwn(trustedKeys, keyId) ||
    typeof publicKeyPem !== "string" ||
    publicKeyPem.length === 0
  ) {
    throw new Error(`bunium: untrusted update signing key: ${keyId}`);
  }
  const signatureBytes = Buffer.from(signature, "base64");
  if (
    signatureBytes.length !== 64 ||
    signatureBytes.toString("base64") !== signature ||
    !verify(
      null,
      canonicalManifestBytes(raw),
      createPublicKey(publicKeyPem),
      signatureBytes,
    )
  ) {
    throw new Error("bunium: update manifest signature verification failed");
  }
  const commonFields = [
    "schema",
    "product",
    "runtimeAbi",
    "runtimeVersion",
    "cefVersion",
    "minimumBunVersion",
    "minimumOsVersion",
    "sequence",
    "issuedAt",
    "expiresAt",
    "channel",
    "version",
    "platform",
    "arch",
    "keyId",
    "signature",
  ];
  const manifest = raw as unknown as UpdateManifest;
  if (manifest.runtimeAbi !== updateAbiVersion) {
    throw new Error(
      `bunium: update runtime ABI mismatch (${String(manifest.runtimeAbi)} != ${updateAbiVersion})`,
    );
  }
  const variantFields =
    manifest.payloadKind === "application-tree-v1"
      ? [
          "payloadKind",
          "fromVersion",
          "fromSha256",
          "patchArtifact",
          "fullArtifact",
          "fullSize",
          "sha256",
        ]
      : manifest.payloadKind === "runtime-installer-v1"
        ? [
            "payloadKind",
            "fromRuntimeVersion",
            "fromCefVersion",
            "installerFormat",
            "installerArtifact",
          ]
        : [];
  const allowedFields = new Set([...commonFields, ...variantFields]);
  if (
    variantFields.length === 0 ||
    Object.keys(raw).some((key) => !allowedFields.has(key)) ||
    manifest.schema !== 2 ||
    typeof manifest.runtimeVersion !== "string" ||
    typeof manifest.cefVersion !== "string" ||
    typeof manifest.minimumBunVersion !== "string" ||
    typeof manifest.minimumOsVersion !== "string" ||
    !Number.isSafeInteger(manifest.sequence) ||
    manifest.sequence < 1 ||
    typeof manifest.issuedAt !== "string" ||
    typeof manifest.expiresAt !== "string" ||
    typeof manifest.product !== "string" ||
    manifest.product.length < 1 ||
    manifest.product.length > 128 ||
    typeof manifest.channel !== "string" ||
    !/^[A-Za-z0-9._-]{1,64}$/.test(manifest.channel) ||
    typeof manifest.version !== "string" ||
    !["mac", "linux", "win"].includes(manifest.platform) ||
    !["arm64", "x64"].includes(manifest.arch) ||
    (manifest.payloadKind === "application-tree-v1" &&
      (typeof manifest.fromVersion !== "string" ||
        typeof manifest.fromSha256 !== "string" ||
        !/^[a-f0-9]{64}$/i.test(manifest.fromSha256) ||
        !validArtifact(
          manifest.patchArtifact,
          `${manifest.channel}-${manifest.platform}-${manifest.arch}-patch.bsdiff`,
        ) ||
        !validArtifact(
          manifest.fullArtifact,
          `${manifest.channel}-${manifest.platform}-${manifest.arch}-full.tar.zst`,
        ) ||
        typeof manifest.fullSize !== "number" ||
        !Number.isSafeInteger(manifest.fullSize) ||
        manifest.fullSize <= 0 ||
        manifest.fullSize > MAX_UPDATE_ARTIFACT_BYTES ||
        typeof manifest.sha256 !== "string" ||
        !/^[a-f0-9]{64}$/i.test(manifest.sha256))) ||
    (manifest.payloadKind === "runtime-installer-v1" &&
      (typeof manifest.fromRuntimeVersion !== "string" ||
        typeof manifest.fromCefVersion !== "string" ||
        !isRuntimeInstallerFormat(manifest.installerFormat) ||
        !runtimeInstallerFormatMatchesPlatform(
          manifest.installerFormat,
          manifest.platform,
        ) ||
        !validArtifact(
          manifest.installerArtifact,
          runtimeInstallerFileName(
            manifest.channel,
            manifest.platform,
            manifest.arch,
            manifest.runtimeVersion,
            manifest.installerFormat,
          ),
        )))
  ) {
    throw new Error("bunium: malformed update manifest");
  }
  const issuedAt = Date.parse(manifest.issuedAt);
  const expiresAt = Date.parse(manifest.expiresAt);
  const now = Date.now();
  if (
    !Number.isFinite(issuedAt) ||
    !Number.isFinite(expiresAt) ||
    new Date(issuedAt).toISOString() !== manifest.issuedAt ||
    new Date(expiresAt).toISOString() !== manifest.expiresAt ||
    issuedAt > now + 5 * 60 * 1000 ||
    expiresAt <= now ||
    expiresAt <= issuedAt ||
    expiresAt - issuedAt > 365 * 24 * 60 * 60 * 1000
  ) {
    throw new Error(
      "bunium: update manifest is expired or has invalid timestamps",
    );
  }
  parseVersion(manifest.version);
  parseVersion(manifest.runtimeVersion);
  parseVersion(manifest.cefVersion);
  parseVersion(manifest.minimumBunVersion);
  parseVersion(manifest.minimumOsVersion);
  if (manifest.payloadKind === "application-tree-v1") {
    parseVersion(manifest.fromVersion);
    if (compareVersions(manifest.fromVersion, manifest.version) > 0) {
      throw new Error("bunium: update manifest base version exceeds target");
    }
  } else {
    parseVersion(manifest.fromRuntimeVersion);
    parseVersion(manifest.fromCefVersion);
    if (
      compareVersions(manifest.fromRuntimeVersion, manifest.runtimeVersion) >
        0 ||
      compareVersions(manifest.fromCefVersion, manifest.cefVersion) > 0
    ) {
      throw new Error("bunium: runtime installer base version exceeds target");
    }
  }
  return manifest;
}

function validArtifact(
  value: unknown,
  expectedFile: string,
): value is UpdateArtifact {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const artifact = value as Record<string, unknown>;
  return (
    Object.keys(artifact).length === 3 &&
    artifact.file === expectedFile &&
    typeof artifact.size === "number" &&
    Number.isSafeInteger(artifact.size) &&
    artifact.size > 0 &&
    artifact.size <= MAX_UPDATE_ARTIFACT_BYTES &&
    typeof artifact.sha256 === "string" &&
    /^[a-f0-9]{64}$/i.test(artifact.sha256)
  );
}

async function readBoundedBody(
  response: Response,
  limit: number,
  label: string,
): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    throw new Error(`bunium: ${label} exceeds size limit (${limit} bytes)`);
  }
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > limit) {
      throw new Error(`bunium: ${label} exceeds size limit (${limit} bytes)`);
    }
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    if (received + value.length > limit) {
      await reader.cancel();
      throw new Error(`bunium: ${label} exceeds size limit (${limit} bytes)`);
    }
    chunks.push(value);
    received += value.length;
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

// Discriminated-union event payloads, one per event name. `progress.phase`
// distinguishes download vs apply; `error` carries a recoverable flag so the
// caller can retry the fallback path without message-string matching.
export interface UpdaterEvents {
  checking: { url: string };
  downloadStarted: { url: string; bytes: number };
  progress: { phase: "download" | "apply"; ratio: number };
  applying: { method: "patch" | "full" };
  ready: { version: string; dir: string };
  runtimeInstallerReady: {
    runtimeVersion: string;
    format: RuntimeInstallerFormat;
    file: string;
  };
  relaunching: { dir: string };
  error: { message: string; recoverable: boolean };
}

export type UpdaterEvent = {
  [K in keyof UpdaterEvents]: { type: K } & UpdaterEvents[K];
}[keyof UpdaterEvents];

type ListenerMap = {
  [K in keyof UpdaterEvents]: Set<(payload: UpdaterEvents[K]) => void>;
};

type SemVer = [number, number, number];

function parseVersion(v: string): SemVer {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(v);
  if (!match) {
    throw new Error(`bunium: invalid version string "${v}"`);
  }
  const parts = match.slice(1).map(Number);
  if (!parts.every(Number.isSafeInteger)) {
    throw new Error(`bunium: invalid version string "${v}"`);
  }
  const [major = 0, minor = 0, patch = 0] = parts;
  return [major, minor, patch];
}

function compareVersions(a: string, b: string): number {
  const [am, ai, ap] = parseVersion(a);
  const [bm, bi, bp] = parseVersion(b);
  for (const [x, y] of [
    [am, bm],
    [ai, bi],
    [ap, bp],
  ] as const) {
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

function stripSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

export function defaultPlatform(): Platform {
  switch (process.platform) {
    case "darwin":
      return "mac";
    case "linux":
      return "linux";
    case "win32":
      return "win";
    default:
      return "mac";
  }
}

export function defaultArch(): Arch {
  return process.arch === "x64" ? "x64" : "arm64";
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return createHash("sha256").update(bytes).digest("hex");
}

/** A minimal typed event emitter (discriminated-union payloads per name). */
export class Updater {
  private listeners: ListenerMap = {
    checking: new Set(),
    downloadStarted: new Set(),
    progress: new Set(),
    applying: new Set(),
    ready: new Set(),
    runtimeInstallerReady: new Set(),
    relaunching: new Set(),
    error: new Set(),
  };
  private lastCheck: { version: string; upToDate: boolean } | null = null;
  private lastReadyDir = "";

  on<K extends keyof UpdaterEvents>(
    name: K,
    listener: (payload: UpdaterEvents[K]) => void,
  ): () => void {
    this.listeners[name].add(listener as never);
    return () => this.listeners[name].delete(listener as never);
  }

  off<K extends keyof UpdaterEvents>(
    name: K,
    listener: (payload: UpdaterEvents[K]) => void,
  ): void {
    this.listeners[name].delete(listener as never);
  }

  private emit<K extends keyof UpdaterEvents>(
    name: K,
    payload: UpdaterEvents[K],
  ): void {
    for (const listener of this.listeners[name]) {
      (listener as (p: UpdaterEvents[K]) => void)(payload);
    }
  }

  get isUpToDate(): boolean {
    return this.lastCheck?.upToDate ?? false;
  }

  /**
   * Queries the feed manifest and decides patch vs full. Doesn't download
   * anything itself beyond the small JSON manifest.
   */
  async check(options: UpdateCheckOptions): Promise<UpdateCheckResult> {
    if (
      !Number.isSafeInteger(options.currentSequence) ||
      options.currentSequence < 0
    ) {
      throw new Error("bunium: invalid installed update sequence");
    }
    const channel = options.channel ?? "stable";
    const platform = options.platform ?? defaultPlatform();
    const arch = options.arch ?? defaultArch();
    const manifestUrl = `${stripSlash(options.feedUrl)}/${channel}-${platform}-${arch}-update.json`;
    this.emit("checking", { url: manifestUrl });

    const res = await fetch(manifestUrl);
    if (!res.ok) {
      if (res.status === 404) {
        // No manifest for this channel/platform/arch yet.
        this.lastCheck = {
          version: options.currentVersion,
          upToDate: true,
        };
        return { status: "up-to-date", manifest: null };
      }
      throw new Error(`bunium: update manifest fetch failed (${res.status})`);
    }
    let manifestInput: unknown;
    try {
      const bytes = await readBoundedBody(res, MAX_MANIFEST_BYTES, "manifest");
      manifestInput = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
    } catch (error) {
      if (error instanceof Error && error.message.includes("size limit")) {
        throw error;
      }
      throw new Error("bunium: invalid update manifest JSON");
    }
    const manifest = verifySignedManifest(manifestInput, options.trustedKeys);
    if (manifest.product !== options.product) {
      throw new Error("bunium: update manifest product mismatch");
    }
    if (manifest.payloadKind === "application-tree-v1") {
      if (manifest.runtimeVersion !== options.runtimeVersion) {
        throw new Error("bunium: update runtime version mismatch");
      }
      if (manifest.cefVersion !== options.cefVersion) {
        throw new Error("bunium: update CEF version mismatch");
      }
    } else {
      if (
        compareVersions(manifest.runtimeVersion, options.runtimeVersion) < 0 ||
        compareVersions(manifest.cefVersion, options.cefVersion) < 0
      ) {
        throw new Error("bunium: runtime installer version rollback rejected");
      }
      if (
        manifest.runtimeVersion === options.runtimeVersion &&
        manifest.cefVersion === options.cefVersion
      ) {
        throw new Error(
          "bunium: runtime installer does not change the runtime",
        );
      }
    }
    if (compareVersions(Bun.version, manifest.minimumBunVersion) < 0) {
      throw new Error("bunium: update requires a newer Bun version");
    }
    parseVersion(options.currentOsVersion);
    if (
      compareVersions(options.currentOsVersion, manifest.minimumOsVersion) < 0
    ) {
      throw new Error("bunium: update requires a newer operating system");
    }
    if (
      manifest.platform !== platform ||
      manifest.arch !== arch ||
      manifest.channel !== channel
    ) {
      throw new Error("bunium: manifest platform/arch/channel mismatch");
    }

    const cmp = compareVersions(manifest.version, options.currentVersion);
    if (manifest.sequence < options.currentSequence) {
      throw new Error("bunium: update sequence rollback rejected");
    }
    if (cmp < 0) {
      throw new Error("bunium: update version rollback rejected");
    }
    if (manifest.sequence === options.currentSequence) {
      if (
        cmp !== 0 ||
        (manifest.payloadKind === "runtime-installer-v1" &&
          (manifest.runtimeVersion !== options.runtimeVersion ||
            manifest.cefVersion !== options.cefVersion))
      ) {
        throw new Error("bunium: update version/sequence mismatch");
      }
      this.lastCheck = { version: options.currentVersion, upToDate: true };
      return { status: "up-to-date", manifest };
    }

    if (manifest.payloadKind === "runtime-installer-v1") {
      this.lastCheck = { version: manifest.version, upToDate: false };
      return {
        status: "runtime-installer-available",
        manifest,
        update: {
          method: "runtime-installer",
          manifest,
          artifact: manifest.installerArtifact,
          artifactUrl: manifestArtifactUrl(
            manifest.installerArtifact,
            options.feedUrl,
          ),
          format: manifest.installerFormat,
        },
      };
    }

    // Delta only when we have exactly the previous version the patch was
    // built against. Anyone else (including a version *ahead* of fromVersion
    // but behind the target) gets the full bundle -- matches Electrobun's
    // single-previous-version design.
    const canPatch =
      compareVersions(manifest.fromVersion, options.currentVersion) === 0;
    this.lastCheck = { version: manifest.version, upToDate: false };
    return {
      status: "update-available",
      manifest,
      update: {
        method: canPatch ? "patch" : "full",
        manifest,
        artifact: canPatch ? manifest.patchArtifact : manifest.fullArtifact,
        artifactUrl: manifestArtifactUrl(
          canPatch ? manifest.patchArtifact : manifest.fullArtifact,
          options.feedUrl,
        ),
      },
    };
  }

  /**
   * Downloads + applies an available update into `installDir`. Writes into a
   * staging sibling dir; on success the old install is renamed to a backup
   * and the staged tree renamed into place. Old install stays untouched until
   * the swap (recoverable errors leave it in place; the swap restores from
   * backup if the staged rename fails).
   */
  async install(
    update: UpdateInfo | RuntimeInstallerUpdate,
    options: { installDir: string },
  ): Promise<string> {
    try {
      if (update.method === "runtime-installer") {
        throw new Error(
          "bunium: runtime installers must be downloaded and applied by the operating system",
        );
      }
      return await this.installInner(update, options);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Failures before the swap leave the old install untouched; the swap
      // itself restores from backup. Both are recoverable: the caller can
      // retry with the full bundle.
      this.emit("error", { message, recoverable: true });
      throw err;
    }
  }

  /**
   * Downloads and verifies a signed runtime installer without executing it or
   * modifying the running installation. The caller must present the returned
   * path for an explicit OS-owned install action.
   */
  async downloadRuntimeInstaller(
    update: RuntimeInstallerUpdate,
    options: { directory: string },
  ): Promise<string> {
    const manifest = update.manifest;
    const expectedFile = runtimeInstallerFileName(
      manifest.channel,
      manifest.platform,
      manifest.arch,
      manifest.runtimeVersion,
      manifest.installerFormat,
    );
    if (
      update.method !== "runtime-installer" ||
      manifest.payloadKind !== "runtime-installer-v1" ||
      update.format !== manifest.installerFormat ||
      !runtimeInstallerFormatMatchesPlatform(
        manifest.installerFormat,
        manifest.platform,
      ) ||
      manifest.installerArtifact.file !== expectedFile ||
      update.artifact.file !== expectedFile ||
      !Number.isSafeInteger(update.artifact.size) ||
      update.artifact.size !== manifest.installerArtifact.size ||
      update.artifact.size > MAX_UPDATE_ARTIFACT_BYTES ||
      update.artifact.sha256 !== manifest.installerArtifact.sha256 ||
      !/^[a-f0-9]{64}$/i.test(update.artifact.sha256)
    ) {
      throw new Error("bunium: invalid runtime installer update");
    }
    const directory = resolve(options.directory);
    await mkdir(directory, { recursive: true });
    const file = join(directory, expectedFile);
    const temporaryFile = join(
      directory,
      `.${expectedFile}.${randomUUID()}.part`,
    );
    const handle = await open(temporaryFile, "wx");
    try {
      await this.downloadRuntimeInstallerTo(update, handle);
      if (manifest.installerFormat === "linux-appimage") {
        await handle.chmod(0o755);
      }
      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => undefined);
      await rm(temporaryFile, { force: true });
      this.emit("error", {
        message: error instanceof Error ? error.message : String(error),
        recoverable: true,
      });
      throw error;
    }
    await handle.close();
    try {
      // Linking is an atomic, no-overwrite commit because both paths are in
      // the same directory/filesystem. In particular, never replace an
      // existing installer at the destination.
      await link(temporaryFile, file);
    } catch (error) {
      await rm(temporaryFile, { force: true });
      throw error;
    }
    await rm(temporaryFile, { force: true });
    this.emit("runtimeInstallerReady", {
      runtimeVersion: manifest.runtimeVersion,
      format: manifest.installerFormat,
      file,
    });
    return file;
  }

  private async downloadRuntimeInstallerTo(
    update: RuntimeInstallerUpdate,
    handle: FileHandle,
  ): Promise<void> {
    const response = await fetch(update.artifactUrl);
    if (!response.ok) {
      throw new Error(`bunium: artifact download failed (${response.status})`);
    }
    const declared = response.headers.get("content-length");
    const total = declared === null ? update.artifact.size : Number(declared);
    if (
      (Number.isFinite(total) && total !== update.artifact.size) ||
      update.artifact.size <= 0
    ) {
      throw new Error(
        `bunium: update artifact size ${String(total)} != manifest size ${update.artifact.size}`,
      );
    }
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error("bunium: runtime installer response has no body");
    }
    this.emit("downloadStarted", {
      url: update.artifactUrl,
      bytes: update.artifact.size,
    });
    const digest = createHash("sha256");
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      if (received + value.byteLength > update.artifact.size) {
        await reader.cancel();
        throw new Error(
          `bunium: update artifact exceeds signed size (${update.artifact.size} bytes)`,
        );
      }
      let offset = 0;
      while (offset < value.byteLength) {
        const { bytesWritten } = await handle.write(
          value,
          offset,
          value.byteLength - offset,
        );
        if (bytesWritten < 1) {
          throw new Error("bunium: runtime installer write made no progress");
        }
        offset += bytesWritten;
      }
      digest.update(value);
      received += value.byteLength;
      this.emit("progress", {
        phase: "download",
        ratio: received / update.artifact.size,
      });
    }
    if (received !== update.artifact.size) {
      throw new Error(
        `bunium: update artifact size ${received} != manifest size ${update.artifact.size}`,
      );
    }
    const actual = digest.digest("hex");
    if (actual !== update.artifact.sha256.toLowerCase()) {
      throw new Error(
        `bunium: update artifact integrity check failed (${update.artifact.file})`,
      );
    }
  }

  private async installInner(
    update: UpdateInfo,
    options: { installDir: string },
  ): Promise<string> {
    const installDir = resolve(options.installDir);
    // A prior run may have died mid-swap (journal left behind); self-repair
    // first so a retry never sees a missing/half-swapped install dir.
    await repairInterruptedUpdate(installDir);
    const manifest = update.manifest;
    this.emit("applying", { method: update.method });

    let tar: Uint8Array;
    if (update.method === "patch") {
      tar = await this.applyPatchArtifact(update, installDir);
    } else {
      tar = await this.applyFullArtifact(update);
    }

    // Integrity check against the manifest, if provided: hashes the exact
    // archive bytes that will be extracted.
    if (manifest.sha256) {
      const actual = await sha256Hex(tar);
      if (actual !== manifest.sha256.toLowerCase()) {
        throw new Error(
          `bunium: update integrity check failed (sha256 ${actual.slice(0, 12)}...)`,
        );
      }
    }

    const newTree = readTar(tar).files;
    const staged = await this.stageTree(installDir, newTree);
    const newDir = await this.swap(installDir, staged);
    this.lastReadyDir = newDir;
    this.emit("ready", { version: manifest.version, dir: newDir });
    return newDir;
  }

  /**
   * Signals the app should restart to finish the update. Emits `relaunching`
   * (carrying the dir the update was installed into) and invokes the provided
   * handler with that dir -- the app's launcher typically quits and re-execs
   * itself, e.g. via `relaunchApp` from `src/relaunch.ts`:
   *
   *     updater.on("ready", () => updater.relaunch(relaunchApp));
   *
   * Without a handler this is a no-op for the caller to hook up.
   */
  relaunch(relaunchHandler?: (dir: string) => void): void {
    this.emit("relaunching", { dir: this.lastReadyDir });
    relaunchHandler?.(this.lastReadyDir);
  }

  // --- internals ---------------------------------------------------------

  /**
   * Patch path: download the bsdiff delta, verify its header (expected output
   * size must equal manifest.fullSize), rebuild the previous full archive
   * from the *current* installed tree (deterministic writeTar, byte-identical
   * to what the publisher tarred), then apply. Returns the new full tar.
   */
  private async applyPatchArtifact(
    update: UpdateInfo,
    oldTreeDir: string,
  ): Promise<Uint8Array> {
    const oldTar = writeTar(await collectDirectory(oldTreeDir));
    const oldHash = await sha256Hex(oldTar);
    if (oldHash !== update.manifest.fromSha256.toLowerCase()) {
      throw new Error("bunium: delta base integrity check failed");
    }

    const patch = await this.downloadWithProgress(update);
    const dir = await mkdtemp(join(tmpdir(), "bunium-update-"));
    try {
      const patchPath = join(dir, "update.patch");
      await writeFile(patchPath, patch);
      const expected = patchExpectedOutputSize(patchPath);
      if (expected !== update.manifest.fullSize) {
        throw new Error(
          `bunium: patch header size ${expected} != manifest fullSize ${update.manifest.fullSize}`,
        );
      }

      this.emit("progress", { phase: "apply", ratio: 0.1 });
      const oldTarPath = join(dir, "old.tar");
      const newTarPath = join(dir, "new.tar");
      await writeFile(oldTarPath, oldTar);
      applyPatch(oldTarPath, patchPath, newTarPath);
      const newTar = new Uint8Array(
        (await Bun.file(newTarPath).arrayBuffer()).slice(0, expected),
      );
      this.emit("progress", { phase: "apply", ratio: 0.7 });
      return newTar;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /** Full path: download the zstd bundle and decompress to the full tar. */
  private async applyFullArtifact(update: UpdateInfo): Promise<Uint8Array> {
    const zstd = await this.downloadWithProgress(update);
    this.emit("progress", { phase: "apply", ratio: 0.3 });
    const tar = new Uint8Array(
      zstdDecompressSync(zstd, {
        maxOutputLength: update.manifest.fullSize,
      }),
    );
    if (tar.length !== update.manifest.fullSize) {
      throw new Error(
        `bunium: decompressed tar size ${tar.length} != manifest fullSize ${update.manifest.fullSize}`,
      );
    }
    return tar;
  }

  private async downloadWithProgress(
    update: Pick<UpdateInfo, "artifact" | "artifactUrl">,
  ): Promise<Uint8Array> {
    const res = await fetch(update.artifactUrl);
    if (!res.ok) {
      throw new Error(`bunium: artifact download failed (${res.status})`);
    }
    const total = Number(
      res.headers.get("content-length") ?? update.artifact.size,
    );
    if (Number.isFinite(total) && total !== update.artifact.size) {
      throw new Error(
        `bunium: update artifact size ${total} != manifest size ${update.artifact.size}`,
      );
    }
    this.emit("downloadStarted", { url: update.artifactUrl, bytes: total });
    if (!res.body) {
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.length !== update.artifact.size) {
        throw new Error(
          `bunium: update artifact size ${bytes.length} != manifest size ${update.artifact.size}`,
        );
      }
      return this.verifyArtifactBytes(bytes, update.artifact);
    }

    const chunks: Uint8Array[] = [];
    const reader = res.body.getReader();
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        if (received + value.length > update.artifact.size) {
          await reader.cancel();
          throw new Error(
            `bunium: update artifact exceeds signed size (${update.artifact.size} bytes)`,
          );
        }
        chunks.push(value);
        received += value.length;
        this.emit("progress", {
          phase: "download",
          ratio: total > 0 ? received / total : 0,
        });
      }
    }
    const out = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return this.verifyArtifactBytes(out, update.artifact);
  }

  private async verifyArtifactBytes(
    bytes: Uint8Array,
    artifact: UpdateArtifact,
  ): Promise<Uint8Array> {
    if (bytes.length !== artifact.size) {
      throw new Error(
        `bunium: update artifact size ${bytes.length} != manifest size ${artifact.size}`,
      );
    }
    const actual = await sha256Hex(bytes);
    if (actual !== artifact.sha256.toLowerCase()) {
      throw new Error(
        `bunium: update artifact integrity check failed (${artifact.file})`,
      );
    }
    return bytes;
  }

  /** Writes the new tree to a sibling staging dir (install untouched). */
  private async stageTree(
    installDir: string,
    tree: Map<string, Uint8Array>,
  ): Promise<string> {
    const parent = dirname(installDir);
    const staging = await mkdtemp(
      join(parent, `.${basename(installDir)}-staging-`),
    );
    try {
      for (const [path, data] of tree) {
        const dest = join(staging, path);
        await mkdir(dirname(dest), { recursive: true });
        await writeFile(dest, data);
      }
      return staging;
    } catch (err) {
      await rm(staging, { recursive: true, force: true });
      throw err;
    }
  }

  /**
   * Replaces `installDir` with the staged tree; restores backup on failure.
   *
   * The swap is journaled (`<installDir>.updating`) so a crash between the two
   * renames is detectable and repairable on next launch — the install dir
   * briefly doesn't exist, and without the journal the next launch would see a
   * missing install with no way to know a backup and/or a complete staged tree
   * exist. `repairInterruptedUpdate` (below) resolves every intermediate state.
   */
  private async swap(installDir: string, staging: string): Promise<string> {
    const backup = `${installDir}.backup`;
    const journal = `${installDir}.updating`;
    const attemptMarker = `${journal}.attempted`;
    await rm(backup, { recursive: true, force: true });
    await rm(attemptMarker, { force: true });
    await writeFile(
      journal,
      `${JSON.stringify({ phase: "swapping", staging })}\n`,
    );
    await rename(installDir, backup);
    try {
      await rename(staging, installDir);
      // Keep the previous payload until the relaunched app explicitly
      // acknowledges health. If this write fails, restore the old payload.
      await writeFile(
        journal,
        `${JSON.stringify({ phase: "awaiting-health", attempted: false })}\n`,
      );
    } catch (err) {
      // The swap or health journal failed -- restore the original install.
      await rm(staging, { recursive: true, force: true });
      await rm(installDir, { recursive: true, force: true });
      await rename(backup, installDir);
      await rm(journal, { force: true });
      throw err;
    }
    return installDir;
  }
}

export type UpdateRepairResult = "repaired" | "rolled-back" | "none";
export type UpdateHealthCheckResult = "pending" | "rolled-back" | "none";
const activeHealthChecks = new Set<string>();

async function pathExists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
}

async function isRealDirectory(p: string): Promise<boolean> {
  try {
    const info = await lstat(p);
    return info.isDirectory() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Self-repair after a swap crash. Called at the start of every `install()` and
 * exported for apps to call once at startup (before their first `check()`).
 * Resolves every state a journal-bearing directory can be in:
 *
 * - staged tree present  → roll forward (rename staging → install; the old
 *   install, if still present, is the pre-swap tree and safely discarded)
 * - staging lost + backup present + install missing → roll back (restore the
 *   original install from backup)
 * - staging lost + backup present + install present → the second rename already
 *   succeeded; the new tree is live, just finish cleanup
 * - no journal → "none" (nothing to do)
 *
 * Always removes the journal. Outcomes: "repaired" (new tree live, incl. the
 * already-committed case), "rolled-back" (old tree restored), "none".
 */
export async function repairInterruptedUpdate(
  installDir: string,
): Promise<UpdateRepairResult> {
  const resolved = resolve(installDir);
  const journal = `${resolved}.updating`;
  const backup = `${resolved}.backup`;
  const attemptMarker = `${journal}.attempted`;

  let staging = "";
  let phase = "";
  try {
    const data = JSON.parse(await readFile(journal, "utf8")) as {
      staging?: unknown;
      phase?: unknown;
    };
    if (typeof data.staging === "string") staging = data.staging;
    if (typeof data.phase === "string") phase = data.phase;
  } catch (error) {
    // A missing journal means an untouched install. Damaged journal contents
    // are ambiguous if a backup exists, so fail closed and restore it.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") phase = "invalid";
  }

  const stagingPath = staging === "" ? "" : resolve(staging);
  const stagingPrefix = `.${basename(resolved)}-staging-`;
  const stagingPathIsOwned =
    stagingPath !== "" &&
    dirname(stagingPath) === dirname(resolved) &&
    basename(stagingPath).startsWith(stagingPrefix) &&
    basename(stagingPath).length > stagingPrefix.length;
  const stagingExists =
    stagingPathIsOwned && (await isRealDirectory(stagingPath));
  const backupExists = await isRealDirectory(backup);
  const installExists = await pathExists(resolved);

  let result: UpdateRepairResult = "none";
  if (
    phase === "awaiting-health" ||
    phase === "swapping" ||
    phase === "invalid"
  ) {
    // A pending candidate has not proved it can boot. A swap interrupted
    // before the health phase is equally ambiguous, so prefer the old tree.
    if (backupExists) {
      await rm(resolved, { recursive: true, force: true });
      await rename(backup, resolved);
      result = "rolled-back";
    } else if (stagingExists && !installExists) {
      // First install has no previous payload to restore.
      await rename(stagingPath, resolved);
      result = "repaired";
    } else if (installExists) {
      result = "repaired";
    }
    if (stagingExists) await rm(stagingPath, { recursive: true, force: true });
    await rm(attemptMarker, { force: true });
    activeHealthChecks.delete(resolved);
  } else if (stagingExists) {
    await rm(resolved, { recursive: true, force: true });
    await rename(stagingPath, resolved);
    // The old tree (if the crash happened after the first rename) is now
    // redundant — drop it so a repair leaves a clean state.
    await rm(backup, { recursive: true, force: true });
    result = "repaired";
  } else if (backupExists && !installExists) {
    await rename(backup, resolved);
    result = "rolled-back";
  } else if (backupExists) {
    // Install dir already holds the new tree (crash during backup cleanup).
    await rm(backup, { recursive: true, force: true });
    result = "repaired";
  }

  await rm(journal, { force: true });
  return result;
}

/**
 * Marks the first launch after an update as the health-check attempt. Call
 * before creating windows. If a prior attempt was never acknowledged, restore
 * the retained known-good tree instead of starting the candidate again.
 */
export async function beginUpdateHealthCheck(
  installDir: string,
): Promise<UpdateHealthCheckResult> {
  const resolved = resolve(installDir);
  const journal = `${resolved}.updating`;
  const backup = `${resolved}.backup`;
  const attemptMarker = `${journal}.attempted`;
  let data: { phase?: unknown };
  try {
    data = JSON.parse(await readFile(journal, "utf8")) as typeof data;
  } catch {
    const repaired = await repairInterruptedUpdate(resolved);
    return repaired === "rolled-back" ? "rolled-back" : "none";
  }
  if (data.phase !== "awaiting-health") {
    const repaired = await repairInterruptedUpdate(resolved);
    return repaired === "rolled-back" ? "rolled-back" : "none";
  }

  if (!(await isRealDirectory(backup))) {
    // The candidate is already the only usable tree. Keep it bootable and
    // remove stale metadata instead of deleting the running payload.
    await rm(journal, { force: true });
    await rm(attemptMarker, { force: true });
    activeHealthChecks.delete(resolved);
    return "none";
  }
  if (await pathExists(attemptMarker)) {
    if (activeHealthChecks.has(resolved)) return "pending";
    await rm(resolved, { recursive: true, force: true });
    await rename(backup, resolved);
    await rm(journal, { force: true });
    await rm(attemptMarker, { force: true });
    return "rolled-back";
  }

  // A separate marker makes interrupted writes fail closed: its existence on
  // the next launch means the previous health attempt never completed.
  await writeFile(attemptMarker, "attempted\n", { flag: "wx" });
  activeHealthChecks.add(resolved);
  return "pending";
}

/** Finalizes a successful health check and removes the retained old payload. */
export async function acknowledgeUpdateHealthy(
  installDir: string,
): Promise<boolean> {
  const resolved = resolve(installDir);
  const journal = `${resolved}.updating`;
  const backup = `${resolved}.backup`;
  const attemptMarker = `${journal}.attempted`;
  try {
    const data = JSON.parse(await readFile(journal, "utf8")) as {
      phase?: unknown;
    };
    if (data.phase !== "awaiting-health") return false;
  } catch {
    return false;
  }
  if (!(await pathExists(attemptMarker))) return false;
  if (!(await isRealDirectory(resolved))) return false;
  await rm(backup, { recursive: true, force: true });
  await rm(journal, { force: true });
  await rm(attemptMarker, { force: true });
  activeHealthChecks.delete(resolved);
  return true;
}

function manifestArtifactUrl(
  artifact: UpdateArtifact,
  feedUrl: string,
): string {
  return `${stripSlash(feedUrl)}/${artifact.file}`;
}

// Module-level default instance (matches the app/systemEvents singleton
// pattern used across the rest of bunium).
export const updater = new Updater();

export interface UpdateInfo {
  method: "patch" | "full";
  manifest: ApplicationTreeManifest;
  artifact: UpdateArtifact;
  artifactUrl: string;
}

export interface RuntimeInstallerUpdate {
  method: "runtime-installer";
  manifest: RuntimeInstallerManifest;
  artifact: UpdateArtifact;
  artifactUrl: string;
  format: RuntimeInstallerFormat;
}

export type UpdateCheckResult =
  | { status: "up-to-date"; manifest: UpdateManifest | null }
  | {
      status: "update-available";
      manifest: UpdateManifest;
      update: UpdateInfo;
    }
  | {
      status: "runtime-installer-available";
      manifest: RuntimeInstallerManifest;
      update: RuntimeInstallerUpdate;
    };
