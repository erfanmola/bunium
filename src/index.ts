export { app } from "./app";
export type { DeviceEmulationDescriptor } from "./emulation";
export {
  deviceEmulationCapabilities,
  validateDeviceEmulation,
} from "./emulation";
export type {
  BuniumGuestOptions,
  GuestBounds,
  GuestClip,
  GuestEvent,
  GuestGeolocation,
  GuestMessage,
} from "./guest";
export { BuniumGuest, debugLiveCounts, guestApiVersion } from "./guest";
export type { RelaunchOptions } from "./relaunch";
// Phase 9: auto-update + packaged-app restart. The updater is exported so a
// packaged app can do `import { updater } from "bunium"` rather than reaching
// into the package internals (the same standing-requirement pattern as all
// other public API: fully typed, no `any`).
export { buildRelaunchCommand, relaunchApp } from "./relaunch";
export type { PartitionClearResult } from "./session";
export {
  BuniumSession,
  PartitionInUseError,
  sessionApiVersion,
} from "./session";
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
  ApplicationTreeManifest,
  Arch,
  Platform,
  RuntimeInstallerFormat,
  RuntimeInstallerManifest,
  RuntimeInstallerUpdate,
  UpdateCheckOptions,
  UpdateCheckResult,
  UpdateHealthCheckResult,
  UpdateInfo,
  UpdateManifest,
  UpdateRepairResult,
  UpdaterEvent,
  UpdaterEvents,
} from "./update";
export {
  acknowledgeUpdateHealthy,
  beginUpdateHealthCheck,
  defaultArch,
  defaultPlatform,
  repairInterruptedUpdate,
  Updater,
  updateAbiVersion,
  updater,
} from "./update";
export type {
  BuniumOverlayOptions,
  BuniumWindowOptions,
  OverlayBounds,
  WindowControl,
  WindowControlCapabilities,
} from "./window";
export {
  BuniumOverlay,
  BuniumWindow,
  trustedOriginsApiVersion,
  WindowControlError,
} from "./window";
