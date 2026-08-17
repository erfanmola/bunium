// Phase 9: bsdiff/bspatch delta-patch helpers for the auto-updater.
//
// Thin TS wrapper over the flat-C-ABI exports in native/mac/bunium_bsdiff_wrap.mm
// (bound in native.ts). All three functions work on file paths; the wrapper
// reads/validates/writes whole files on the native side. Status codes mirror
// the C side: 0 = OK, negatives are error kinds (see bunium_bsdiff_wrap.mm).
import { ptr } from "bun:ffi";
import { cstr, lib } from "./native";

export const BSDFF_STATUS = {
  ok: 0,
  fileError: -1,
  badHeader: -2,
  patchError: -3,
  memory: -4,
} as const;

export type BsdiffStatus = (typeof BSDFF_STATUS)[keyof typeof BSDFF_STATUS];

function throwForStatus(status: number, what: string): void {
  if (status === BSDFF_STATUS.ok) return;
  const message =
    status === BSDFF_STATUS.fileError
      ? "file open/read/write failed"
      : status === BSDFF_STATUS.badHeader
        ? "corrupt patch (bad magic or size)"
        : status === BSDFF_STATUS.patchError
          ? "bsdiff/bspatch algorithm failed"
          : status === BSDFF_STATUS.memory
            ? "out of memory"
            : `unknown status ${status}`;
  throw new Error(`bunium: ${what}: ${message}`);
}

/** Builds `patchPath` as a delta from `oldPath` to `newPath`. */
export function createPatch(
  oldPath: string,
  newPath: string,
  patchPath: string,
): void {
  const status = lib.symbols.bunium_bsdiff(
    cstr(oldPath),
    cstr(newPath),
    cstr(patchPath),
  ) as number;
  throwForStatus(status, `createPatch(${oldPath} -> ${newPath})`);
}

/** Applies `patchPath` (built against `oldPath`) to produce `newPath`. */
export function applyPatch(
  oldPath: string,
  patchPath: string,
  newPath: string,
): void {
  const status = lib.symbols.bunium_bspatch(
    cstr(oldPath),
    cstr(patchPath),
    cstr(newPath),
  ) as number;
  throwForStatus(status, `applyPatch(${oldPath} <- ${patchPath})`);
}

/**
 * Reads + validates a patch header. Returns the expected size of the patched
 * file, or throws when the patch is corrupt/mismatched. Lets the updater
 * sanity-check a downloaded patch before touching the install.
 */
export function patchExpectedOutputSize(patchPath: string): number {
  const sizeBuf = new BigInt64Array(1);
  const status = lib.symbols.bunium_bsdiff_patch_info(
    cstr(patchPath),
    ptr(sizeBuf),
  ) as number;
  throwForStatus(status, `patchExpectedOutputSize(${patchPath})`);
  return Number(sizeBuf[0]);
}
