// Phase 9: deterministic ustar tar writer + reader for app-layer bundles.
//
// Why hand-rolled instead of Bun.zipSync (unavailable in Bun 1.3.14) or
// shelling out to system tar: the updater needs *reproducible* archives --
// same directory tree in, identical bytes out, across machines and builds --
// so that bsdiff deltas between versions are small and stable. System tar
// embeds ctime/mtime/uid/gid/env-dependent ordering; this writer pins all of
// that: entries sorted by path, mtime=0, uid/gid=0, fixed modes, paths stored
// relative with POSIX separators, and the standard two zero-block terminator.
//
// No filesystem I/O here by default -- callers list a tree and pass
// {path, data} pairs (see collectDirectory for the tree-walking helper).

import { writeSync } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join, normalize } from "node:path";

export interface TarEntry {
  /** Archive-relative POSIX path, e.g. "dist/index.html" (no leading slash). */
  path: string;
  /** Raw bytes. Empty for directory entries. */
  data: Uint8Array;
  /** True for directory entries (typeflag '5'). */
  directory?: boolean;
}

const BLOCK = 512;
const END_BLOCKS = 2;
const MAGIC = "ustar\u000000";
const USTAR_VERSION = "00";

// Deterministic metadata -- every build produces byte-identical archives.
const MTIME = 0;
const UID = 0;
const GID = 0;
const MODE_FILE = 0o644;
const MODE_DIR = 0o755;

const TYPE_REG = 0x30; // '0'
const TYPE_DIR = 0x35; // '5'

// Update archives are untrusted input. Keep extraction bounded even when a
// publisher (or feed) serves a corrupt archive. These limits are deliberately
// generous for application-layer bundles while preventing path and size bombs.
export const TAR_LIMITS = {
  entries: 20_000,
  fileBytes: 256 * 1024 * 1024,
  totalBytes: 1024 * 1024 * 1024,
} as const;

function encodeOctal(value: number, width: number): Uint8Array {
  const body = value.toString(8);
  if (body.length > width - 1) {
    throw new Error(
      `tar: value ${value} does not fit in ${width}-byte octal field`,
    );
  }
  const field = new Uint8Array(width);
  field.set(new TextEncoder().encode(body), 0);
  return field;
}

function encodeAscii(s: string, width: number): Uint8Array {
  const bytes = new TextEncoder().encode(s);
  if (bytes.length > width) {
    throw new Error(`tar: field too long (${bytes.length} > ${width}): ${s}`);
  }
  const field = new Uint8Array(width);
  field.set(bytes, 0);
  return field;
}

// ustar checksum: sum of header bytes with the 8 checksum bytes (offset 148)
// counted as spaces. Stored as 6 octal digits, NUL, space.
function computeChecksum(header: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < header.length; i++) {
    const byte = i >= 148 && i < 156 ? 0x20 : (header[i] ?? 0);
    sum += byte;
  }
  return sum;
}

function buildHeader(entry: TarEntry): Uint8Array {
  const h = new Uint8Array(BLOCK);
  const isDir = entry.directory === true;
  const mode = isDir ? MODE_DIR : MODE_FILE;
  h.set(encodeAscii(entry.path, 100), 0); // name
  h.set(encodeOctal(mode, 8), 100); // mode
  h.set(encodeOctal(UID, 8), 108); // uid
  h.set(encodeOctal(GID, 8), 116); // gid
  h.set(encodeOctal(isDir ? 0 : entry.data.length, 12), 124); // size
  h.set(encodeOctal(MTIME, 12), 136); // mtime
  h[156] = isDir ? TYPE_DIR : TYPE_REG; // typeflag
  h.set(encodeAscii(MAGIC, 8), 257); // magic
  h.set(encodeAscii(USTAR_VERSION, 2), 263); // version
  h.set(encodeAscii("0", 32), 265); // uname "0" (uid text, fixed)
  h.set(encodeAscii("0", 32), 297); // gname "0"
  const checksum = computeChecksum(h).toString(8).padStart(6, "0");
  h.set(encodeAscii(checksum, 6), 148);
  h[154] = 0; // NUL terminator after the 6 octal digits
  h[155] = 0x20; // trailing space (classic layout)
  return h;
}

function isZeroBlock(block: Uint8Array): boolean {
  for (const b of block) if (b !== 0) return false;
  return true;
}

/** Scans a 512-byte block for the first NUL; decodes the preceding ASCII. */
function parseAsciiField(
  block: Uint8Array,
  start: number,
  width: number,
): string {
  const end = block.indexOf(0, start);
  const limit = end === -1 ? start + width : end;
  const slice = block.subarray(start, limit);
  return new TextDecoder("utf-8", { fatal: true }).decode(slice);
}

function parseOctal(block: Uint8Array, start: number, width: number): number {
  const end = block.indexOf(0, start);
  const limit = end === -1 ? start + width : end;
  let value = 0;
  for (let i = start; i < limit; i++) {
    const byte = block[i] ?? 0;
    if (byte < 0x30 || byte > 0x37) break; // space or garbage terminates
    value = value * 8 + (byte - 0x30);
  }
  return value;
}

/**
 * Serializes entries into a deterministic ustar archive. Entries are sorted
 * by path with parent directories before their own contents (so extraction
 * can create directories first); tiebreak uses typeflag then path. This makes
 * output independent of caller entry order.
 */
export function writeTar(entries: readonly TarEntry[]): Uint8Array {
  const sorted = [...entries].map((e) => ({ ...e })).sort(compareEntries);
  if (sorted.length > TAR_LIMITS.entries) {
    throw new Error(`tar: entry limit exceeded (${TAR_LIMITS.entries})`);
  }
  const seen = new Set<string>();
  let totalBytes = 0;
  for (const entry of sorted) {
    const path = validateArchivePath(entry.path, entry.directory === true);
    if (seen.has(path)) throw new Error(`tar: duplicate path ${path}`);
    seen.add(path);
    if (!(entry.data instanceof Uint8Array)) {
      throw new Error(`tar: file data must be a Uint8Array: ${path}`);
    }
    if (entry.directory === true && entry.data.length !== 0) {
      throw new Error(`tar: directory has payload: ${path}`);
    }
    if (entry.directory !== true) {
      if (entry.data.length > TAR_LIMITS.fileBytes) {
        throw new Error(`tar: file limit exceeded for ${path}`);
      }
      totalBytes += entry.data.length;
      if (totalBytes > TAR_LIMITS.totalBytes) {
        throw new Error(
          `tar: total file limit exceeded (${TAR_LIMITS.totalBytes})`,
        );
      }
    }
  }
  const blocks: Uint8Array[] = [];
  for (const entry of sorted) {
    blocks.push(buildHeader(entry));
    if (entry.directory !== true && entry.data.length > 0) {
      blocks.push(entry.data);
      const pad = (BLOCK - (entry.data.length % BLOCK)) % BLOCK;
      if (pad > 0) blocks.push(new Uint8Array(pad));
    }
  }
  const total = blocks.reduce((n, b) => n + b.length, 0) + BLOCK * END_BLOCKS;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const b of blocks) {
    out.set(b, offset);
    offset += b.length;
  }
  return out; // trailing zero blocks are already zero-filled
}

function compareEntries(a: TarEntry, b: TarEntry): number {
  const aKey = (a.directory === true ? "0" : "1") + a.path;
  const bKey = (b.directory === true ? "0" : "1") + b.path;
  return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
}

/**
 * Parses a ustar archive. Returns path -> bytes for regular files and the set
 * of directory paths. Throws on malformed archives (bad magic/checksum,
 * truncated payloads, unsupported typeflags).
 */
export interface TarContents {
  files: Map<string, Uint8Array>;
  directories: Set<string>;
}

export function readTar(archive: Uint8Array): TarContents {
  if (archive.length === 0 || archive.length % BLOCK !== 0) {
    throw new Error("tar: archive length is not block aligned");
  }
  const files = new Map<string, Uint8Array>();
  const directories = new Set<string>();
  let offset = 0;
  let entries = 0;
  let totalBytes = 0;
  const seen = new Set<string>();
  let terminated = false;
  while (offset + BLOCK <= archive.length) {
    const block = archive.subarray(offset, offset + BLOCK);
    if (isZeroBlock(block)) {
      if (offset + BLOCK * END_BLOCKS > archive.length) {
        throw new Error("tar: missing two-block end marker");
      }
      if (!isZeroBlock(archive.subarray(offset + BLOCK))) {
        throw new Error("tar: non-zero data after end marker");
      }
      for (
        let trailing = offset + BLOCK * END_BLOCKS;
        trailing < archive.length;
        trailing += BLOCK
      ) {
        if (!isZeroBlock(archive.subarray(trailing, trailing + BLOCK))) {
          throw new Error("tar: non-zero data after end marker");
        }
      }
      terminated = true;
      break;
    }
    const magic = parseAsciiField(block, 257, 8);
    if (!magic.startsWith("ustar")) {
      throw new Error(`tar: not a ustar archive at offset ${offset}`);
    }
    const storedChecksum = parseOctal(block, 148, 8);
    const computed = computeChecksum(block);
    if (storedChecksum !== computed) {
      throw new Error(
        `tar: checksum mismatch at offset ${offset} (stored ${storedChecksum}, computed ${computed})`,
      );
    }
    const name = parseAsciiField(block, 0, 100);
    const prefix = parseAsciiField(block, 345, 155);
    const fullPath = prefix ? `${prefix}/${name}` : name;
    const size = parseOctal(block, 124, 12);
    const typeflag = block[156] ?? TYPE_REG;
    const path = validateArchivePath(fullPath, typeflag === TYPE_DIR);
    entries++;
    if (entries > TAR_LIMITS.entries) {
      throw new Error(`tar: entry limit exceeded (${TAR_LIMITS.entries})`);
    }
    if (seen.has(path)) throw new Error(`tar: duplicate path ${path}`);
    seen.add(path);
    offset += BLOCK;
    if (typeflag === TYPE_DIR) {
      if (size !== 0) throw new Error(`tar: directory has payload: ${path}`);
      directories.add(path);
      continue;
    }
    if (typeflag !== TYPE_REG) {
      throw new Error(
        `tar: unsupported typeflag ${String(typeflag)} for ${path}`,
      );
    }
    if (size > TAR_LIMITS.fileBytes) {
      throw new Error(`tar: file limit exceeded for ${path}`);
    }
    totalBytes += size;
    if (totalBytes > TAR_LIMITS.totalBytes) {
      throw new Error(
        `tar: total file limit exceeded (${TAR_LIMITS.totalBytes})`,
      );
    }
    const paddedSize = size + ((BLOCK - (size % BLOCK)) % BLOCK);
    if (offset + paddedSize > archive.length) {
      throw new Error(`tar: truncated payload for ${path}`);
    }
    files.set(path, archive.subarray(offset, offset + size));
    offset += paddedSize;
  }
  if (!terminated) throw new Error("tar: missing end marker");
  return { files, directories };
}

function validateArchivePath(path: string, directory: boolean): string {
  if (path === "." && directory) return path;
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes(":") ||
    path.includes("\0")
  ) {
    throw new Error(`tar: unsafe archive path ${JSON.stringify(path)}`);
  }
  const parts = path.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`tar: unsafe archive path ${JSON.stringify(path)}`);
  }
  return path;
}

/** Normalizes a native path for archive use: POSIX separators, no "." parts. */
export function toPosixPath(p: string): string {
  return normalize(p).split("\\").join("/").replace(/^\.\//, "");
}

/**
 * Walks a directory tree, returning entries ready for writeTar. Paths are
 * relative to `root` (POSIX separators, no leading "./"); directories are
 * included as entries. Deterministic: sorted by path.
 */
export async function collectDirectory(root: string): Promise<TarEntry[]> {
  const entries: TarEntry[] = [];
  const walk = async (rel: string): Promise<void> => {
    const abs = rel === "" ? root : join(root, rel);
    const info = await lstat(abs);
    if (info.isSymbolicLink()) {
      throw new Error(`tar: symbolic links are not supported: ${abs}`);
    }
    if (info.isDirectory()) {
      entries.push({
        path: rel === "" ? "." : toPosixPath(rel),
        data: new Uint8Array(0),
        directory: true,
      });
      const children = (await readdir(abs, { withFileTypes: true }))
        .map((c) => c.name)
        .sort();
      for (const name of children) {
        await walk(rel === "" ? name : toPosixPath(`${rel}/${name}`));
      }
    } else if (info.isFile()) {
      const file = Bun.file(abs);
      const data = new Uint8Array(await file.arrayBuffer());
      const path = rel.startsWith("./") ? rel.slice(2) : rel;
      entries.push({ path: toPosixPath(path), data });
    } else {
      throw new Error(`tar: unsupported file type at ${abs}`);
    }
  };
  await walk("");
  entries.sort(compareEntries);
  return entries;
}

/** Driver: bun src/tar.ts <directory> > out.tar */
if (import.meta.main) {
  const root = process.argv[2];
  if (!root) {
    console.error("usage: bun ./src/tar.ts <directory>");
    process.exit(1);
  }
  const archive = writeTar(await collectDirectory(root));
  writeSync(1, archive);
}
