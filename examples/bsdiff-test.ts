// Phase 9 verification: bsdiff/bspatch round-trip via the native shim.
//
// Builds a delta patch old -> new, applies it back, and byte-compares the
// result against the original. Also exercises the patch-header validator
// (corrupt-magic rejection) so a mangled download fails fast in the updater.
//
// Exit codes: 0 = PASS, 1 = FAIL (assertion printed). Pure FS + ffi, no
// windows/CEF, so it runs headless -- but don't run it concurrently with
// another example script anyway (repo convention).
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyPatch,
  BSDFF_STATUS,
  createPatch,
  patchExpectedOutputSize,
} from "../src/bsdiff";
import { lib } from "../src/native";

const dir = mkdtempSync(join(tmpdir(), "bunium-bsdiff-test-"));
const oldPath = join(dir, "old.bin");
const newPath = join(dir, "new.bin");
const patchPath = join(dir, "out.patch");
const restoredPath = join(dir, "restored.bin");

// Two files that differ modestly (real-ish app-asset shape: shared prefix,
// small edits, appended tail) so the delta is non-trivial.
const oldBytes = Buffer.from(
  "hello world, this is the bunium app bundle. asset-one.js v1\n".repeat(200),
);
const newBytes = Buffer.from(
  "hello world, this is the bunium app bundle. asset-one.js v2\n".repeat(80) +
    "brand-new asset appended after the edits\n".repeat(120),
);
writeFileSync(oldPath, oldBytes);
writeFileSync(newPath, newBytes);

function assertEqual(actual: Buffer, expected: Buffer, label: string): void {
  if (!actual.equals(expected)) {
    console.error(`FAIL: ${label} -- bytes differ`);
    console.error(
      `  actual.len=${actual.length} expected.len=${expected.length}`,
    );
    process.exit(1);
  }
}

createPatch(oldPath, newPath, patchPath);
if (!existsSync(patchPath)) {
  console.error("FAIL: createPatch produced no patch file");
  process.exit(1);
}
const patchBytes = readFileSync(patchPath);
console.log(
  `patch ${patchBytes.length} bytes (old ${oldBytes.length}, new ${newBytes.length})`,
);

// Header validator agrees on the expected output size.
const announced = patchExpectedOutputSize(patchPath);
if (announced !== newBytes.length) {
  console.error(
    `FAIL: patch info announced size ${announced}, expected ${newBytes.length}`,
  );
  process.exit(1);
}

applyPatch(oldPath, patchPath, restoredPath);
assertEqual(readFileSync(restoredPath), newBytes, "round-trip apply");

// Corrupt the magic (bit-flip the 16-byte signature) -- the updater's
// pre-apply sanity check must reject it before it can clobber an install.
const corrupt = join(dir, "corrupt.patch");
writeFileSync(corrupt, Buffer.from(patchBytes));
corruptPatchMagic(corrupt);
try {
  patchExpectedOutputSize(corrupt);
  console.error("FAIL: corrupt patch passed header validation");
  process.exit(1);
} catch (e) {
  console.log(`corrupt patch rejected (expected): ${(e as Error).message}`);
}

// A truncated patch must also be rejected, not crash.
const truncated = join(dir, "truncated.patch");
writeFileSync(truncated, patchBytes.subarray(0, 10));
try {
  patchExpectedOutputSize(truncated);
  console.error("FAIL: truncated patch passed header validation");
  process.exit(1);
} catch (e) {
  console.log(`truncated patch rejected (expected): ${(e as Error).message}`);
}

// Constant sanity check while we're here (status enum matches C side in
// bunium_bsdiff_wrap.mm -- keep in sync if that file's codes change).
if (BSDFF_STATUS.fileError !== -1 || BSDFF_STATUS.badHeader !== -2) {
  console.error("FAIL: status enum drift from native codes");
  process.exit(1);
}
if (!lib.symbols.bunium_bsdiff) {
  console.error("FAIL: bunium_bsdiff symbol missing from shim");
  process.exit(1);
}

rmSync(dir, { recursive: true, force: true });
console.log("PASS: bsdiff round-trip + header validation");
process.exit(0);

function corruptPatchMagic(path: string): void {
  const b = readFileSync(path);
  b[5] = b[5]! ^ 0xff;
  writeFileSync(path, b);
}
