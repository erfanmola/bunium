import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectDirectory, readTar, writeTar } from "./tar";

function archiveWithPath(path: string): Uint8Array {
  const archive = writeTar([{ path: "safe", data: new Uint8Array([1]) }]);
  const header = archive.subarray(0, 512);
  header.fill(0, 0, 100);
  header.set(new TextEncoder().encode(path), 0);
  header.fill(0x20, 148, 156);
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.set(
    new TextEncoder().encode(`${checksum.toString(8).padStart(6, "0")}\0 `),
    148,
  );
  return archive;
}

describe("update tar safety", () => {
  test("reads a normal archive including the writer's root directory entry", () => {
    const archive = writeTar([
      { path: ".", data: new Uint8Array(), directory: true },
      { path: "dist/index.html", data: new TextEncoder().encode("ok") },
    ]);
    const result = readTar(archive);
    expect(result.directories.has(".")).toBe(true);
    expect(new TextDecoder().decode(result.files.get("dist/index.html"))).toBe(
      "ok",
    );
  });

  test.each([
    "../escape",
    "/absolute",
    "C:/drive",
    "dist/file:stream",
    "dist\\escape",
    "a//b",
  ])("rejects unsafe path %s", (path) => {
    expect(() => writeTar([{ path, data: new Uint8Array() }])).toThrow(
      "unsafe archive path",
    );
    expect(() => readTar(archiveWithPath(path))).toThrow("unsafe archive path");
  });

  test("round-trips UTF-8 file names", () => {
    const archive = writeTar([
      { path: "dist/שלום.txt", data: new TextEncoder().encode("ok") },
    ]);
    expect(readTar(archive).files.has("dist/שלום.txt")).toBe(true);
  });

  test("requires complete zero end markers and no trailing payload", () => {
    const archive = writeTar([{ path: "file", data: new Uint8Array([1]) }]);
    expect(() => readTar(archive.slice(0, -512))).toThrow(
      "two-block end marker",
    );
    const trailing = archive.slice();
    trailing[trailing.length - 1] = 1;
    expect(() => readTar(trailing)).toThrow("non-zero data after end marker");
    expect(() => readTar(archive.slice(0, -1))).toThrow("block aligned");
  });

  test("rejects a symbolic link instead of following it into the release tree", async () => {
    const root = await mkdtemp(join(tmpdir(), "bunium-tar-symlink-"));
    const outside = join(root, "outside.txt");
    const release = join(root, "release");
    await writeFile(outside, "must not enter release archive");
    await mkdir(release);
    await symlink(outside, join(release, "linked.txt"));
    try {
      await expect(collectDirectory(release)).rejects.toThrow(
        "symbolic links are not supported",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects duplicate paths instead of silently replacing earlier files", () => {
    expect(() =>
      writeTar([
        { path: "dist/index.html", data: new Uint8Array([1]) },
        { path: "dist/index.html", data: new Uint8Array([2]) },
      ]),
    ).toThrow("duplicate path");
    const single = writeTar([
      { path: "dist/index.html", data: new Uint8Array([1]) },
    ]);
    const record = single.subarray(0, single.length - 1024);
    const archive = new Uint8Array(record.length * 2 + 1024);
    archive.set(record, 0);
    archive.set(record, record.length);
    expect(() => readTar(archive)).toThrow("duplicate path");
  });

  test("rejects an oversized declared file before reading its payload", () => {
    const archive = writeTar([{ path: "payload.bin", data: new Uint8Array() }]);
    const header = archive.slice(0, 512);
    const sizeField = new TextEncoder().encode("3000000000\0");
    header.fill(0, 124, 136);
    header.set(sizeField, 124);
    header.fill(0x20, 148, 156);
    let checksum = 0;
    for (const byte of header) checksum += byte;
    const checksumField = new TextEncoder().encode(
      `${checksum.toString(8).padStart(6, "0")}\0 `,
    );
    header.set(checksumField, 148);
    expect(() => readTar(header)).toThrow("file limit exceeded");
  });

  test("rejects archives over the entry-count limit", () => {
    const entries = Array.from({ length: 20_001 }, (_, index) => ({
      path: `f${index}`,
      data: new Uint8Array(),
    }));
    expect(() => readTar(writeTar(entries))).toThrow("entry limit exceeded");
  });
});
