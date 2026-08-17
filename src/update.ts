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
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { applyPatch, patchExpectedOutputSize } from "./bsdiff";
import { collectDirectory, readTar, writeTar } from "./tar";

export type Platform = "mac" | "linux" | "win";
export type Arch = "arm64" | "x64";

export interface UpdateCheckOptions {
  /** Base URL of the static artifact host (no trailing slash needed). */
  feedUrl: string;
  /** Current installed version. Must match the manifest's `fromVersion` to
   *  use the delta patch instead of the full bundle. */
  currentVersion: string;
  channel?: string;
  platform?: Platform;
  arch?: Arch;
}

export interface UpdateManifest {
  name: string;
  channel: string;
  version: string;
  fromVersion: string;
  platform: Platform;
  arch: Arch;
  /** Size of the full (uncompressed) tar, bytes. The patch's expected output
   *  size is validated against this and the archive header. */
  fullSize: number;
  /** Optional sha256 of the full tar for end-to-end integrity. */
  sha256?: string;
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
  const parts = v.split(".").map((p) => parseInt(p, 10));
  while (parts.length < 3) parts.push(0);
  const [major = 0, minor = 0, patch = 0] = parts;
  if (Number.isNaN(major) || Number.isNaN(minor) || Number.isNaN(patch)) {
    throw new Error(`bunium: invalid version string "${v}"`);
  }
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
    const manifest = (await res.json()) as UpdateManifest;
    if (
      manifest.platform !== platform ||
      manifest.arch !== arch ||
      manifest.channel !== channel
    ) {
      throw new Error("bunium: manifest platform/arch/channel mismatch");
    }

    const cmp = compareVersions(manifest.version, options.currentVersion);
    if (cmp <= 0) {
      this.lastCheck = { version: options.currentVersion, upToDate: true };
      return { status: "up-to-date", manifest };
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
        artifactUrl: manifestArtifactUrl(manifest, options.feedUrl, canPatch),
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
    update: UpdateInfo,
    options: { installDir: string },
  ): Promise<string> {
    try {
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
      const oldTar = writeTar(await collectDirectory(oldTreeDir));
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
    return new Uint8Array(Bun.zstdDecompressSync(zstd));
  }

  private async downloadWithProgress(update: UpdateInfo): Promise<Uint8Array> {
    const res = await fetch(update.artifactUrl);
    if (!res.ok) {
      throw new Error(`bunium: artifact download failed (${res.status})`);
    }
    const total = Number(
      res.headers.get("content-length") ?? update.manifest.fullSize,
    );
    this.emit("downloadStarted", { url: update.artifactUrl, bytes: total });
    if (!res.body) return new Uint8Array(await res.arrayBuffer());

    const chunks: Uint8Array[] = [];
    const reader = res.body.getReader();
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
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
    return out;
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
    await rm(backup, { recursive: true, force: true });
    await writeFile(journal, `${JSON.stringify({ staging })}\n`);
    await rename(installDir, backup);
    try {
      await rename(staging, installDir);
    } catch (err) {
      // Staged rename failed -- restore the original install.
      await rm(staging, { recursive: true, force: true });
      await rename(backup, installDir);
      await rm(journal, { force: true });
      throw err;
    }
    await rm(backup, { recursive: true, force: true });
    await rm(journal, { force: true });
    return installDir;
  }
}

export type UpdateRepairResult = "repaired" | "rolled-back" | "none";

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
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

  let staging = "";
  try {
    const data = JSON.parse(await readFile(journal, "utf8")) as {
      staging?: unknown;
    };
    if (typeof data.staging === "string") staging = data.staging;
  } catch {
    // Missing or unreadable journal: nothing to repair, or no staging to roll
    // forward to — fall through to backup-based handling if a backup exists.
  }

  const stagingExists = staging !== "" && (await pathExists(staging));
  const backupExists = await pathExists(backup);
  const installExists = await pathExists(resolved);

  let result: UpdateRepairResult = "none";
  if (stagingExists) {
    await rm(resolved, { recursive: true, force: true });
    await rename(staging, resolved);
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

function manifestArtifactUrl(
  manifest: UpdateManifest,
  feedUrl: string,
  canPatch: boolean,
): string {
  const base = `${stripSlash(feedUrl)}/${manifest.channel}-${manifest.platform}-${manifest.arch}`;
  return `${base}-${canPatch ? "patch.bsdiff" : "full.tar.zst"}`;
}

// Module-level default instance (matches the app/systemEvents singleton
// pattern used across the rest of bunium).
export const updater = new Updater();

export interface UpdateInfo {
  method: "patch" | "full";
  manifest: UpdateManifest;
  artifactUrl: string;
}

export type UpdateCheckResult =
  | { status: "up-to-date"; manifest: UpdateManifest | null }
  | {
      status: "update-available";
      manifest: UpdateManifest;
      update: UpdateInfo;
    };
