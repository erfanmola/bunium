import type { Pointer } from "bun:ffi";
import { ptr } from "bun:ffi";
import { cstr, lib, paths, rootCachePath } from "./native";
import { systemEvents } from "./system/events";

export interface TrackedWindow {
  readonly windowHandle: Pointer;
  onNativeResize(width: number, height: number): void;
  onUserClosed(): void;
  /** Drain and dispatch any pending window.__bunium.send() messages. */
  pollMessages(): void;
}

// Bun has no equivalent of Electron's `app.whenReady()` message-loop
// integration -- CEF needs CefDoMessageLoopWork() pumped from *some* timer,
// and on macOS the Cocoa event pump needs the same treatment. This class
// owns that pump loop. One process = one BuniumApp, ever (matches CEF's own
// singleton process model).
//
// It also polls each open window's native size every tick and forwards
// changes to BuniumWindow -- there's no NSWindowDelegate-to-JS callback
// bridge, resize detection is just "did the number change since last tick,"
// polled from here alongside the CEF/Cocoa pumps that already run every
// tick anyway.
// Idle floor for the adaptive pump loop (see startPumpLoop): how long to
// wait before the next tick when CEF has no scheduled work
// (bunium_get_next_pump_delay_ms() returns -1). CEF-driven activity
// (animation, scrolling, an in-flight IPC reply) self-drives the delay
// toward 0 via its own OnScheduleMessagePumpWork requests, same as it
// would under Electron's native run-loop integration -- this floor only
// bounds the truly-idle case. Kept at 8 (the old fixed interval's value,
// not raised) deliberately: profiling found bunium's actual idle-CPU cost
// is dominated by CEF's own continuous windowless-OSR compositing (tied to
// windowless_frame_rate, independent of how often we poll), not by pump
// scheduling overhead -- so a larger floor bought no CPU win and measurably
// hurt IPC latency (drained on the same tick cadence). See
// benchmark/RESULTS.md's "beat Electron" section for the full writeup and
// why closing the CPU gap needs a different, OSR-repaint-focused fix.
const PUMP_IDLE_FLOOR_MS = 8;

class BuniumApp {
  private initialized = false;
  private pumpTimer: ReturnType<typeof setTimeout> | null = null;
  private windows = new Set<TrackedWindow>();
  private lastSizes = new Map<
    TrackedWindow,
    { width: number; height: number }
  >();
  private widthBuf = new Int32Array(1);
  private heightBuf = new Int32Array(1);
  private diagTickCount?: number;

  init(): void {
    if (this.initialized) return;
    const ok = lib.symbols.bunium_init(
      cstr(paths.subprocess),
      cstr(paths.frameworkDir),
      cstr(paths.resourcesDir),
      cstr(rootCachePath),
    );
    if (!ok) throw new Error("bunium: CefInitialize failed");
    this.initialized = true;
    this.startPumpLoop();
  }

  // Guards against forwarding a spurious OS-level resize as if it were
  // real user intent. Observed in this dev environment: a freshly created,
  // resizable+titled NSWindow can get resized by something outside bunium
  // (external window manager/Stage Manager-style tiling, confirmed via a
  // bare Cocoa window with zero CEF involvement -- not a bunium bug, but
  // bunium still needs to not blindly propagate it) roughly 150-250ms
  // after creation, with no resize call from us. A real user can't resize
  // a window they just saw appear that fast, so ignore native-resize
  // reports in this window and just resync lastSizes without forwarding.
  private static readonly RESIZE_SETTLE_MS = 1000;
  private windowCreatedAt = new Map<TrackedWindow, number>();

  registerWindow(win: TrackedWindow): void {
    this.windows.add(win);
    this.windowCreatedAt.set(win, performance.now());
  }

  unregisterWindow(win: TrackedWindow): void {
    this.windows.delete(win);
    this.lastSizes.delete(win);
    this.windowCreatedAt.delete(win);
  }

  // Adaptive, not a fixed interval: CEF's external_message_pump mode
  // (native/mac/bunium_shim.cpp) means CEF tells us exactly when it next
  // needs CefDoMessageLoopWork() via OnScheduleMessagePumpWork
  // (native/mac/bunium_common.h), instead of us blind-polling forever.
  // Each tick still does exactly what the old fixed-interval loop did, in
  // the same order -- only the *scheduling* changed.
  private tick = (): void => {
    lib.symbols.bunium_do_message_loop_work();
    lib.symbols.bunium_pump_native_events();
    this.pollWindows();
    systemEvents.drain();

    const requested = lib.symbols.bunium_get_next_pump_delay_ms();
    const delay =
      requested >= 0
        ? Math.min(requested, PUMP_IDLE_FLOOR_MS)
        : PUMP_IDLE_FLOOR_MS;
    if (process.env.BUNIUM_PUMP_DIAG) {
      this.diagTickCount = (this.diagTickCount ?? 0) + 1;
      console.error(
        `[pump-diag-js] tick #${this.diagTickCount} requested=${requested} delay=${delay}`,
      );
    }
    this.pumpTimer = setTimeout(this.tick, delay);
  };

  private startPumpLoop(): void {
    this.pumpTimer = setTimeout(this.tick, 0);
  }

  private pollWindows(): void {
    // Copy to an array first -- onUserClosed() calls back into
    // unregisterWindow(), which would mutate `this.windows` mid-iteration.
    for (const win of [...this.windows]) {
      if (lib.symbols.bunium_is_native_window_closed(win.windowHandle)) {
        win.onUserClosed();
        continue;
      }

      lib.symbols.bunium_get_native_window_size(
        win.windowHandle,
        ptr(this.widthBuf),
        ptr(this.heightBuf),
      );
      const width = this.widthBuf[0]!;
      const height = this.heightBuf[0]!;
      const last = this.lastSizes.get(win);
      if (!last || last.width !== width || last.height !== height) {
        this.lastSizes.set(win, { width, height });
        const createdAt = this.windowCreatedAt.get(win) ?? 0;
        const settled =
          performance.now() - createdAt >= BuniumApp.RESIZE_SETTLE_MS;
        if (last && settled) win.onNativeResize(width, height);
      }

      win.pollMessages();
    }
  }

  // Sets the single global root directory that "bunium://app/<path>" URLs
  // resolve against (native/mac/bunium_common.h -- BuniumSchemeHandlerFactory).
  // Prod builds should call this once, before any window loadURL()s a
  // "bunium://" URL, pointing it at the built static output directory
  // (e.g. Vite's `dist/`). Not required for dev, where windows instead
  // loadURL() a running Vite dev server directly over http://.
  setAppRoot(rootDirPath: string): void {
    lib.symbols.bunium_set_app_root(cstr(rootDirPath));
  }

  shutdown(): void {
    if (!this.initialized) return;
    if (this.pumpTimer) clearTimeout(this.pumpTimer);
    lib.symbols.bunium_shutdown();
    this.initialized = false;
  }
}

export const app = new BuniumApp();
