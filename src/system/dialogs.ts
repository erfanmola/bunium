import { cstr, lib } from "../native";
import { systemEvents } from "./events";

// Phase 5: native dialogs -- open/save file panels and message boxes. Each
// call kicks off a native (NSOpenPanel/NSSavePanel/NSAlert) interaction and
// returns a promise that resolves when the user acts; the result arrives as a
// bunium-dialog-result {"requestId":N, "result":{...}} event on the shared
// system event bus (the native side never blocks the JS pump -- completion
// handlers push onto the same inbox app.ts drains every tick).
//
// The promises only resolve while the app pump is draining, so this requires
// app.init()'d/enum-open state like every other bunium API.

const DIALOG_RESULT_EVENT = "bunium-dialog-result";

let nextRequestId = 1;

function waitForDialogResult<T>(requestId: number): Promise<T> {
  return new Promise((resolve) => {
    // The drain loop dispatches synchronously, so resolving inside the
    // listener is safe. Duplicate requestIds would be ambiguous, hence the
    // shared counter.
    const off = systemEvents.on(DIALOG_RESULT_EVENT, (payload) => {
      const { requestId: id, result } = payload as {
        requestId: number;
        result: T;
      };
      if (id !== requestId) return;
      off();
      resolve(result);
    });
  });
}

export interface OpenDialogOptions {
  title?: string;
  /** Selects directories in addition to files. */
  canChooseDirectories?: boolean;
  /** Lets the user pick more than one item. */
  allowMultiple?: boolean;
  /** Create-directory affordance inside the panel (macOS specific). */
  canCreateDirectories?: boolean;
  /** Label for the confirm button; empty/omitted = platform default. */
  okLabel?: string;
}

export interface OpenDialogResult {
  canceled: boolean;
  /** Absolute paths of the selected items; [] when canceled. */
  paths: string[];
}

export interface SaveDialogOptions {
  title?: string;
  /** Prefilled filename in the save field. */
  defaultName?: string;
  okLabel?: string;
}

export interface SaveDialogResult {
  canceled: boolean;
  /** Absolute destination path; null when canceled. */
  path: string | null;
}

export interface MessageBoxOptions {
  /** Primary text (bold line of the alert). */
  message: string;
  /** Secondary explanatory text. */
  detail?: string;
  okLabel?: string;
  cancelLabel?: string;
}

export interface MessageBoxResult {
  /** Index of the button the user clicked: 0 = ok, 1 = cancel. */
  response: number;
}

export async function showOpenDialog(
  options: OpenDialogOptions = {},
): Promise<OpenDialogResult> {
  const requestId = nextRequestId++;
  lib.symbols.bunium_system_dialog_open(
    cstr(options.title ?? "Open"),
    options.allowMultiple ? 1 : 0,
    options.canChooseDirectories ? 1 : 0,
    options.canCreateDirectories ? 1 : 0,
    cstr(options.okLabel ?? ""),
    requestId,
  );
  const r = await waitForDialogResult<{ canceled: boolean; paths?: string[] }>(
    requestId,
  );
  return { canceled: r.canceled, paths: r.paths ?? [] };
}

export async function showSaveDialog(
  options: SaveDialogOptions = {},
): Promise<SaveDialogResult> {
  const requestId = nextRequestId++;
  lib.symbols.bunium_system_dialog_save(
    cstr(options.title ?? "Save"),
    cstr(options.defaultName ?? ""),
    cstr(options.okLabel ?? ""),
    requestId,
  );
  return waitForDialogResult<SaveDialogResult>(requestId);
}

export async function showMessageBox(
  options: MessageBoxOptions,
): Promise<MessageBoxResult> {
  const requestId = nextRequestId++;
  lib.symbols.bunium_system_dialog_message(
    cstr(options.message),
    cstr(options.detail ?? ""),
    cstr(options.okLabel ?? "OK"),
    cstr(options.cancelLabel ?? ""),
    requestId,
  );
  return waitForDialogResult<MessageBoxResult>(requestId);
}
