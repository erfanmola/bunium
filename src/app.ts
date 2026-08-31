import type { Pointer } from "bun:ffi";
import { ptr } from "bun:ffi";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
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
  private wakeServer: ReturnType<typeof Bun.listen> | null = null;
  private wakeSocketPath: string | null = null;

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
    this.startWakeSocket();
  }

  // Lets native code wake the pump loop the instant it has work ready,
  // instead of JS finding out only on its next setTimeout-scheduled tick
  // (previously up to PUMP_IDLE_FLOOR_MS late). Bun *listens* here and
  // native connects out as a plain client (bunium_set_wake_socket_path,
  // native/mac/bunium_shim.cpp) -- the reverse of the first attempt at
  // this (a bare socketpair() self-pipe with node:net wrapping the raw fd
  // on the JS side), which measured as a real win in a full benchmark run
  // but turned out to be a dead no-op: node:net's `new net.Socket({fd})`
  // never delivers 'data' for an externally-created fd in Bun 1.4.0
  // (confirmed via a minimal standalone repro, not specific to this
  // codebase) -- see bunium_set_wake_socket_path's comment for the full
  // story and the corrected benchmark number. `Bun.listen()` is Bun's own
  // socket implementation and was verified (separate repro) to deliver
  // `data` in ~30-40us median, comfortably under the target.
  private startWakeSocket(): void {
    const path = `${tmpdir()}/bunium-wake-${process.pid}-${Math.random().toString(36).slice(2)}.sock`;
    try {
      unlinkSync(path);
    } catch {
      // Expected in the overwhelmingly common case (fresh random path) --
      // only matters if a previous run crashed without cleaning up, which
      // Bun.listen would otherwise fail to bind against.
    }
    let server: ReturnType<typeof Bun.listen>;
    try {
      server = Bun.listen({
        unix: path,
        socket: {
          data: () => {
            // Content is irrelevant (each write is just a "something
            // happened" ping) -- what matters is running the pump tick
            // now instead of waiting for pumpTimer's already-scheduled
            // delay to elapse.
            if (process.env.BUNIUM_IPC_DIAG) {
              lib.symbols.bunium_ipc_diag_log(cstr("js_wake_socket_data"));
            }
            if (this.pumpTimer) clearTimeout(this.pumpTimer);
            this.tick();
          },
          open: () => {},
          error: () => {
            // Never let a wake-socket problem take down the app -- worst
            // case this degrades back to the timer-only pump behavior
            // that predates this optimization.
          },
        },
      });
    } catch {
      return; // Platform/sandbox can't bind a unix socket -- fall back silently.
    }
    this.wakeServer = server;
    this.wakeSocketPath = path;
    lib.symbols.bunium_set_wake_socket_path(cstr(path));
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
    if (this.wakeServer) {
      this.wakeServer.stop(true);
      this.wakeServer = null;
    }
    if (this.wakeSocketPath) {
      try {
        unlinkSync(this.wakeSocketPath);
      } catch {
        // Best-effort cleanup only.
      }
      this.wakeSocketPath = null;
    }
    lib.symbols.bunium_shutdown();
    this.initialized = false;
  }
}

export const app = new BuniumApp();
