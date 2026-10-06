import type { Pointer } from "bun:ffi";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { app } from "./app";
import { asPointer, cstr, lib } from "./native";

/** Host-side capability handshake for consumers that require partitions. */
export const sessionApiVersion = 1;

// Partition keys are opaque identifiers chosen by the app (for example a
// hash of a trusted registry record ID) -- never paths. The native side
// re-validates the same shape before touching the filesystem.
const KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const PROFILE_PATTERN = /^bp\.([a-z0-9][a-z0-9_-]{0,63})\.g([1-9][0-9]{0,8})$/;
const GENERATION_PATTERN = /^g([1-9][0-9]{0,8})$/;
// Chrome-style CEF only persists profiles that are direct children of the
// CEF root, so profile directories are flat (`bp.<key>.g<N>`) and the
// per-key "current generation" records live in one metadata directory.
const METADATA_DIRECTORY = "BuniumPartitions";

export interface PartitionClearResult {
  /** Generation new sessions for this key will use. */
  generation: number;
  /**
   * True when the previous generation's files were deleted now. False when
   * this process opened them (CEF may still be closing that profile), in
   * which case they are deleted by the sweep on the next launch.
   */
  removedNow: boolean;
}

export class PartitionInUseError extends Error {
  constructor(key: string) {
    super(`bunium: partition "${key}" is in use`);
    this.name = "PartitionInUseError";
  }
}

function assertKey(key: string): void {
  if (typeof key !== "string" || !KEY_PATTERN.test(key)) {
    throw new TypeError(
      "bunium: partition key must match [a-z0-9][a-z0-9_-]{0,63}",
    );
  }
}

let swept = false;
const live = new Map<string, BuniumSession>();
// Generation directories this process has bound to a CEF context. They may
// still be held by a profile that is shutting down, so they are only
// deleted by a later process's sweep.
const openedThisProcess = new Set<string>();

function partitionRoot(): string {
  app.init();
  // cstring returns arrive as a CString wrapper; stringify for the value.
  const root = String(lib.symbols.bunium_partition_root() ?? "");
  if (!root) throw new Error("bunium: partition root is unavailable");
  return root;
}

function profileDirectory(key: string, generation: number): string {
  return join(partitionRoot(), `bp.${key}.g${generation}`);
}

function metadataFile(key: string): string {
  return join(partitionRoot(), METADATA_DIRECTORY, key);
}

function readGeneration(key: string): number | null {
  try {
    const match = GENERATION_PATTERN.exec(
      readFileSync(metadataFile(key), "utf8").trim(),
    );
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

function writeGeneration(key: string, generation: number): void {
  const file = metadataFile(key);
  mkdirSync(join(partitionRoot(), METADATA_DIRECTORY), { recursive: true });
  writeFileSync(`${file}.tmp`, `g${generation}\n`);
  renameSync(`${file}.tmp`, file);
}

function removeIfClosed(path: string): boolean {
  if (openedThisProcess.has(path)) return false;
  rmSync(path, { force: true, recursive: true });
  return true;
}

/** Deletes cleared generations and removed partitions left by earlier runs. */
function sweep(): void {
  if (swept) return;
  swept = true;
  const root = partitionRoot();
  if (!existsSync(root)) return;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const match = entry.isDirectory() ? PROFILE_PATTERN.exec(entry.name) : null;
    if (!match?.[1]) continue;
    if (readGeneration(match[1]) !== Number(match[2])) {
      removeIfClosed(join(root, entry.name));
    }
  }
}

/**
 * An isolated CEF request context. Persistent sessions keep cookies,
 * localStorage, IndexedDB, Cache Storage and service workers on disk in a
 * per-key, per-generation profile directory and are shared by every holder of the same key in
 * this process (reference counted). Ephemeral sessions are in-memory only.
 */
export class BuniumSession {
  private handle: Pointer | null;
  private references = 1;

  private constructor(
    /** Partition key, or null for an ephemeral session. */
    readonly key: string | null,
    /** On-disk generation, or 0 for an ephemeral session. */
    readonly generation: number,
    handle: Pointer,
  ) {
    this.handle = handle;
  }

  /** Acquires (and retains) the persistent session for a partition key. */
  static fromPartition(key: string): BuniumSession {
    assertKey(key);
    const existing = live.get(key);
    if (existing) return existing.retain();
    sweep();
    let generation = readGeneration(key);
    if (generation === null) {
      generation = 1;
      writeGeneration(key, generation);
    }
    const pointer = lib.symbols.bunium_session_create(
      cstr(`${key}/g${generation}`),
    );
    if (!pointer) {
      throw new Error(`bunium: could not create partition "${key}"`);
    }
    openedThisProcess.add(profileDirectory(key, generation));
    const session = new BuniumSession(key, generation, asPointer(pointer));
    live.set(key, session);
    return session;
  }

  /** Creates a new in-memory session that is discarded when released. */
  static ephemeral(): BuniumSession {
    app.init();
    const pointer = lib.symbols.bunium_session_create(cstr(""));
    if (!pointer) throw new Error("bunium: could not create ephemeral session");
    return new BuniumSession(null, 0, asPointer(pointer));
  }

  /** CEF root directory that holds persistent partitions as `bp.<key>.g<N>`. */
  static get storageRoot(): string {
    return partitionRoot();
  }

  /** Whether any holder (including open windows) retains this key. */
  static isInUse(key: string): boolean {
    assertKey(key);
    return live.has(key);
  }

  /**
   * Discards all stored data for a key. New sessions start empty at once;
   * the old files are deleted now or, if this process had them open, on the
   * next launch. Refuses while the partition is in use.
   */
  static clearPartition(key: string): PartitionClearResult {
    assertKey(key);
    if (live.has(key)) throw new PartitionInUseError(key);
    sweep();
    const previous = readGeneration(key);
    const generation = (previous ?? 0) + 1;
    writeGeneration(key, generation);
    const removedNow =
      previous === null || removeIfClosed(profileDirectory(key, previous));
    return { generation, removedNow };
  }

  /** Deletes a partition entirely (same deferral rules as clearPartition). */
  static removePartition(key: string): { removedNow: boolean } {
    assertKey(key);
    if (live.has(key)) throw new PartitionInUseError(key);
    sweep();
    const generation = readGeneration(key);
    rmSync(metadataFile(key), { force: true });
    return {
      removedNow:
        generation === null ||
        removeIfClosed(profileDirectory(key, generation)),
    };
  }

  /** Number of live references (for diagnostics and tests). */
  get referenceCount(): number {
    return this.references;
  }

  get released(): boolean {
    return this.handle === null;
  }

  /** @internal Native request-context handle for view creation. */
  get nativeHandle(): Pointer {
    if (!this.handle) throw new Error("bunium: session was released");
    return this.handle;
  }

  retain(): this {
    if (!this.handle) throw new Error("bunium: session was released");
    this.references += 1;
    return this;
  }

  release(): void {
    if (!this.handle) return;
    this.references -= 1;
    if (this.references > 0) return;
    lib.symbols.bunium_session_release(this.handle);
    this.handle = null;
    if (this.key !== null && live.get(this.key) === this) live.delete(this.key);
  }
}
