import { CString, type Pointer, ptr } from "bun:ffi";
import {
  type DeviceEmulationDescriptor,
  encodeInputEmulation,
  validateDeviceEmulation,
} from "./emulation";
import { asPointer, cstr, lib } from "./native";
import type { BuniumSession } from "./session";

/** Host-side capability handshake for consumers that require guest views. */
export const guestApiVersion = 1;

const GUEST_EVENT_NAME = "__bunium_guest_event";
const MAX_BRIDGE_BYTES = 256 * 1024;
const MAX_MESSAGE_BYTES = 1024 * 1024;

export interface GuestBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Rounded clipping geometry in host-window CSS pixels. */
export interface GuestClip {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Uniform circular corner radius. Elliptical/asymmetric CSS radii are not represented. */
  cornerRadius?: number;
}

export interface BuniumGuestOptions extends GuestBounds {
  url: string;
  /**
   * Script run in every main-frame document before any page script, as the
   * body of `function (post) { ... }`. `post(string)` is its only native
   * capability; returning a function makes it the receiver for
   * {@link BuniumGuest.post}. Subframes never get it.
   */
  bridgeScript: string;
  /** Storage partition; defaults to the shared global context. */
  session?: BuniumSession;
  /**
   * Optional screen, raster, touch, and pointer traits, independent of the
   * host display. Capabilities reflect the native CEF backend.
   */
  emulation?: DeviceEmulationDescriptor;
}

/** Lifecycle of the guest's current main-frame document. */
export type GuestEvent =
  | { type: "document"; generation: number; url: string }
  | { type: "load"; generation: number; status: number; url: string }
  | { type: "load-error"; generation: number; code: number; url: string }
  | { type: "crashed"; generation: number; status: number; code: number }
  | { type: "disposed"; generation: number };

export interface GuestMessage {
  generation: number;
  data: string;
}

export interface GuestGeolocation {
  latitude: number;
  longitude: number;
  /** Horizontal accuracy in meters. */
  accuracy: number;
}

type Parent = {
  readonly windowHandle: Pointer;
};

/**
 * An untrusted page (e.g. a Mini App) composited into a window. It never
 * receives Bunium's host bridge; the host talks to it only through the
 * document-start bridge script. Every message is tagged with the document
 * generation natively, so traffic from or to a previous document (after a
 * navigation, redirect, reload or crash) is dropped rather than misrouted.
 */
export class BuniumGuest {
  private view: Pointer | null;
  private sublayer: Pointer | null;
  private readonly session: BuniumSession | undefined;
  private readonly eventListeners = new Set<(event: GuestEvent) => void>();
  private readonly messageListeners = new Set<
    (message: GuestMessage) => void
  >();
  private currentGeneration = 0;

  /** @internal Use BuniumWindow.createGuest. */
  constructor(
    parent: Parent,
    options: BuniumGuestOptions,
    private readonly onDispose: (guest: BuniumGuest) => void,
    private readonly onLayerOrderChanged: () => void = () => {},
  ) {
    if (Buffer.byteLength(options.bridgeScript) > MAX_BRIDGE_BYTES) {
      throw new RangeError("bunium: guest bridge script is too large");
    }
    const emulation = options.emulation
      ? validateDeviceEmulation(options.emulation)
      : undefined;
    const { x, y, width, height } = options;
    this.session = options.session?.retain();
    this.sublayer = asPointer(
      lib.symbols.bunium_create_native_sublayer(
        parent.windowHandle,
        x,
        y,
        width,
        height,
      )!,
    );
    const view = lib.symbols.bunium_create_guest_view(
      cstr(options.url),
      width,
      height,
      this.session ? this.session.nativeHandle : null,
      cstr(options.bridgeScript),
      cstr(
        emulation
          ? JSON.stringify({
              screenWidth: emulation.screen.width,
              screenHeight: emulation.screen.height,
              scale: emulation.deviceScaleFactor,
              ...encodeInputEmulation(emulation),
            })
          : "",
      ),
    );
    if (!view) {
      lib.symbols.bunium_close_native_sublayer(this.sublayer);
      this.session?.release();
      throw new Error("bunium: could not create guest view");
    }
    this.view = asPointer(view);
    lib.symbols.bunium_attach_window(this.view, this.sublayer);
  }

  get disposed(): boolean {
    return this.view === null;
  }

  /** Generation of the current document (0 before the first one). */
  get generation(): number {
    return this.currentGeneration;
  }

  /** Messages from stale documents that the native layer dropped. */
  get staleDropped(): number {
    if (!this.view) return 0;
    const generation = new Int32Array(1);
    const stale = new Int32Array(1);
    lib.symbols.bunium_guest_stats(this.view, ptr(generation), ptr(stale));
    return stale[0] ?? 0;
  }

  /** Physical dimensions of the latest guest paint, useful for qualification. */
  get renderedSize(): { width: number; height: number } {
    if (!this.view) return { width: 0, height: 0 };
    const width = new Int32Array(1);
    const height = new Int32Array(1);
    lib.symbols.bunium_view_get_frame_size(this.view, ptr(width), ptr(height));
    return { width: width[0] ?? 0, height: height[0] ?? 0 };
  }

  onEvent(listener: (event: GuestEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onMessage(listener: (message: GuestMessage) => void): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  navigate(url: string): void {
    if (this.view) lib.symbols.bunium_navigate(this.view, cstr(url));
  }

  reload(ignoreCache = false): void {
    if (this.view) lib.symbols.bunium_reload(this.view, ignoreCache ? 1 : 0);
  }

  /**
   * Sets a mock coordinate on this CEF Guest via its DevTools Protocol. This
   * does not request or alter host operating-system location permission.
   * Reapply from the current document's `load` event after renderer recovery.
   */
  setGeolocationOverride(location: GuestGeolocation): void {
    const { latitude, longitude, accuracy } = location;
    if (
      !Number.isFinite(latitude) ||
      latitude < -90 ||
      latitude > 90 ||
      !Number.isFinite(longitude) ||
      longitude < -180 ||
      longitude > 180 ||
      !Number.isFinite(accuracy) ||
      accuracy < 0 ||
      accuracy > 100_000
    ) {
      throw new RangeError("bunium: invalid guest geolocation override");
    }
    if (
      !this.view ||
      lib.symbols.bunium_guest_set_geolocation(
        this.view,
        0,
        latitude,
        longitude,
        accuracy,
      ) !== 1
    ) {
      throw new Error("bunium: guest geolocation override could not be queued");
    }
  }

  /** Clears a mock coordinate from this guest without opening an OS prompt. */
  clearGeolocationOverride(): void {
    if (
      !this.view ||
      lib.symbols.bunium_guest_set_geolocation(this.view, 1, 0, 0, 0) !== 1
    ) {
      throw new Error("bunium: guest geolocation clear could not be queued");
    }
  }

  setBounds(bounds: GuestBounds): void {
    if (!this.view || !this.sublayer) return;
    lib.symbols.bunium_set_native_sublayer_frame(
      this.sublayer,
      bounds.x,
      bounds.y,
      bounds.width,
      bounds.height,
    );
    lib.symbols.bunium_resize(this.view, bounds.width, bounds.height);
  }

  /**
   * Applies a native rectangular or uniform rounded clip in host-window
   * coordinates. Set `null` to remove it. Rounded clipping is macOS-only.
   */
  setClip(clip: GuestClip | null): void {
    if (!this.sublayer) return;
    if (clip === null) {
      lib.symbols.bunium_clear_native_sublayer_clip(this.sublayer);
      this.onLayerOrderChanged();
      return;
    }
    const { x, y, width, height } = clip;
    const radius = clip.cornerRadius ?? 0;
    if (
      ![x, y, width, height].every(Number.isSafeInteger) ||
      width < 1 ||
      height < 1 ||
      width > 16384 ||
      height > 16384 ||
      !Number.isFinite(radius) ||
      radius < 0 ||
      radius > Math.min(width, height) / 2
    ) {
      throw new RangeError("bunium: invalid native guest clip geometry");
    }
    const result = lib.symbols.bunium_set_native_sublayer_clip_shape(
      this.sublayer,
      x,
      y,
      width,
      height,
      radius,
    );
    if (result !== 1) {
      throw new Error(
        "bunium: this runtime cannot apply the requested guest clip shape",
      );
    }
    this.onLayerOrderChanged();
  }

  /**
   * Sends `data` to the document of `generation`. Returns false without
   * sending if that document is gone.
   */
  post(generation: number, data: string): boolean {
    if (!this.view || Buffer.byteLength(data) > MAX_MESSAGE_BYTES) return false;
    return (
      lib.symbols.bunium_guest_post(this.view, generation, cstr(data)) === 1
    );
  }

  /** Closes the guest and drops every subscription. Safe to call twice. */
  dispose(): void {
    if (!this.view || !this.sublayer) return;
    lib.symbols.bunium_close_view(this.view);
    lib.symbols.bunium_close_native_sublayer(this.sublayer);
    this.view = null;
    this.sublayer = null;
    this.session?.release();
    const event: GuestEvent = {
      generation: this.currentGeneration,
      type: "disposed",
    };
    for (const listener of this.eventListeners) listener(event);
    this.eventListeners.clear();
    this.messageListeners.clear();
    this.onDispose(this);
  }

  /** @internal Drained by the owning window's pump tick. */
  pollMessages(): void {
    while (this.view) {
      const envelopePointer = lib.symbols.bunium_poll_message(this.view);
      if (envelopePointer === null) break;
      let event: {
        type: string;
        generation: number;
        data?: string;
        [key: string]: unknown;
      };
      try {
        const envelope = JSON.parse(new CString(envelopePointer).toString());
        if (envelope.name !== GUEST_EVENT_NAME) continue;
        event = JSON.parse(envelope.payload);
      } catch {
        continue;
      }
      if (event.type === "document") this.currentGeneration = event.generation;
      if (event.type === "message") {
        const message = {
          data: event.data ?? "",
          generation: event.generation,
        };
        for (const listener of this.messageListeners) listener(message);
        continue;
      }
      for (const listener of this.eventListeners) {
        listener(event as unknown as GuestEvent);
      }
    }
  }
}

/** Native object counts for leak tests. */
export function debugLiveCounts(): { views: number; clients: number } {
  const views = new Int32Array(1);
  const clients = new Int32Array(1);
  lib.symbols.bunium_debug_live_counts(ptr(views), ptr(clients));
  return { clients: clients[0] ?? 0, views: views[0] ?? 0 };
}
