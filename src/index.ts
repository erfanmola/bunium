export { app } from "./app";
export type { RelaunchOptions } from "./relaunch";
// Phase 9: auto-update + packaged-app restart. The updater is exported so a
// packaged app can do `import { updater } from "bunium"` rather than reaching
// into the package internals (the same standing-requirement pattern as all
// other public API: fully typed, no `any`).
export { buildRelaunchCommand, relaunchApp } from "./relaunch";
export type {
  MenuItemSpec,
  MessageBoxOptions,
  MessageBoxResult,
  NotificationOptions,
  OpenDialogOptions,
  OpenDialogResult,
  SaveDialogOptions,
  SaveDialogResult,
} from "./system";
// Phase 5 system surface: native menu bar, tray, notifications, dialogs.
export {
  Menu,
  Notification,
  showMessageBox,
  showOpenDialog,
  showSaveDialog,
  systemEvents,
  Tray,
} from "./system";
export type {
  Arch,
  Platform,
  UpdateCheckOptions,
  UpdateCheckResult,
  UpdateInfo,
  UpdateManifest,
  UpdateRepairResult,
  UpdaterEvent,
  UpdaterEvents,
} from "./update";
export {
  defaultArch,
  defaultPlatform,
  repairInterruptedUpdate,
  Updater,
  updater,
} from "./update";
export type { BuniumWindowOptions } from "./window";
export { BuniumWindow } from "./window";
