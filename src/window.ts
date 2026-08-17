import { CString, type Pointer, ptr, toArrayBuffer } from "bun:ffi";
import type { TrackedWindow } from "./app";
import { app } from "./app";
import { cstr, lib } from "./native";

export interface BuniumWindowOptions {
  url: string;
  width?: number;
  height?: number;
  title?: string;
  /** Clear background instead of opaque -- lets the desktop/other windows show through wherever the page paints transparent pixels. Default false. */
  transparent?: boolean;
  /** Set false to hide native window chrome (title bar, traffic-light buttons) -- Electron's `frame: false` equivalent. The window is still resizable programmatically even without a title bar to grab; to actually move a frameless window, mark a page element with CSS `-webkit-app-region: drag` (same convention as Electron) -- bunium scans for it automatically. Default true. */
  frame?: boolean;
  /** Set false to prevent the user from resizing the window at all (drag-to-resize disabled). Default true. */
  resizable?: boolean;
  /** Minimum window content size the user can resize down to. Unset = no minimum (beyond the OS's own floor). */
  minWidth?: number;
  minHeight?: number;
  /** Maximum window content size the user can resize up to. Unset = no maximum. */
  maxWidth?: number;
  maxHeight?: number;
}

// Reserved message name for the automatic draggable-region scanner injected
// into every page (see BuniumApp::OnContextCreated, bunium_common.h) --
// not something app code should listen for via .on().
const DRAG_REGIONS_MESSAGE_NAME = "__bunium_drag_regions";

// Reserved message names the injected <bunium-webview> custom element uses
// (see WEBVIEW_ELEMENT_JS, bunium_common.h) -- like DRAG_REGIONS_MESSAGE_NAME
// above, these are intercepted before the typed .on() dispatch, not exposed
// to app code.
const WEBVIEW_CREATE_MESSAGE_NAME = "__bunium_webview_create";
const WEBVIEW_BOUNDS_MESSAGE_NAME = "__bunium_webview_bounds";
const WEBVIEW_NAVIGATE_MESSAGE_NAME = "__bunium_webview_navigate";
const WEBVIEW_DESTROY_MESSAGE_NAME = "__bunium_webview_destroy";
// Ancestor overflow:hidden clipping (see _syncClip in WEBVIEW_ELEMENT_JS) --
// sent alongside/independently of WEBVIEW_BOUNDS_MESSAGE_NAME, whenever the
// element's effective clip rect (intersection of every clipping ancestor up
// to <body>) changes.
const WEBVIEW_CLIP_MESSAGE_NAME = "__bunium_webview_clip";
// Stacking/z-order sync, see _syncOrder in WEBVIEW_ELEMENT_JS. Sent
// whenever the full ascending stacking order of every connected
// bunium-webview element changes (added, removed, z-index changed, or
// DOM-reordered within the same stacking level).
const WEBVIEW_ORDER_MESSAGE_NAME = "__bunium_webview_order";

interface WebviewCreatePayload {
  id: string;
  src: string;
  x: number;
  y: number;
  width: number;
  height: number;
}
interface WebviewBoundsPayload {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}
interface WebviewNavigatePayload {
  id: string;
  src: string;
}
interface WebviewDestroyPayload {
  id: string;
}
// `clipped: false` means "no clipping ancestor currently applies, remove any
// existing clip" -- x/y/width/height are omitted in that case (see
// _syncClip's payload construction, bunium_common.h).
type WebviewClipPayload =
  | {
      id: string;
      clipped: true;
      x: number;
      y: number;
      width: number;
      height: number;
    }
  | { id: string; clipped: false };
interface WebviewOrderPayload {
  order: string[];
}

interface TrackedWebview {
  sublayerHandle: Pointer;
  viewHandle: Pointer;
}

// Owns the native side of every <bunium-webview> element live in a given
// window's page: one CAMetalLayer sublayer + one CEF view per element,
// keyed by the per-element id the injected custom element generates
// (WEBVIEW_ELEMENT_JS). Driven entirely by the reserved __bunium_webview_*
// messages the element sends over the existing generic IPC channel --
// mirrors the sublayer/view pairing already proven manually in
// examples/sublayer-hit-test.ts and examples/ipc-bounds-test.ts, just
// automated per-DOM-element instead of hand-wired in a test script.
class WebviewManager {
  private webviews = new Map<string, TrackedWebview>();

  constructor(private readonly windowHandle: Pointer) {}

  create(payload: WebviewCreatePayload): void {
    if (this.webviews.has(payload.id)) return; // shouldn't happen, defensive
    const sublayerHandle = lib.symbols.bunium_create_native_sublayer(
      this.windowHandle,
      payload.x,
      payload.y,
      payload.width,
      payload.height,
    )!;
    const viewHandle = lib.symbols.bunium_create_view(
      cstr(payload.src),
      payload.width,
      payload.height,
      0,
    )!;
    lib.symbols.bunium_attach_window(viewHandle, sublayerHandle);
    this.webviews.set(payload.id, { sublayerHandle, viewHandle });
  }

  updateBounds(payload: WebviewBoundsPayload): void {
    const tracked = this.webviews.get(payload.id);
    if (!tracked) return; // e.g. a bounds update racing a destroy -- ignore
    lib.symbols.bunium_set_native_sublayer_frame(
      tracked.sublayerHandle,
      payload.x,
      payload.y,
      payload.width,
      payload.height,
    );
    lib.symbols.bunium_resize(
      tracked.viewHandle,
      payload.width,
      payload.height,
    );
  }

  navigate(payload: WebviewNavigatePayload): void {
    const tracked = this.webviews.get(payload.id);
    if (!tracked) return;
    lib.symbols.bunium_navigate(tracked.viewHandle, cstr(payload.src));
  }

  // Applies/removes ancestor overflow:hidden clipping for one element's
  // sublayer -- see the detailed mechanism comment on
  // bunium_sublayer_set_clip (bunium_window_mac.mm). Coordinates here are
  // in the same window-relative space _syncClip already computed them in
  // (getBoundingClientRect() is window-relative, same as the bounds the
  // element itself reports), so no conversion needed before passing
  // through to the native call.
  updateClip(payload: WebviewClipPayload): void {
    const tracked = this.webviews.get(payload.id);
    if (!tracked) return;
    if (payload.clipped) {
      lib.symbols.bunium_set_native_sublayer_clip(
        tracked.sublayerHandle,
        payload.x,
        payload.y,
        payload.width,
        payload.height,
      );
    } else {
      lib.symbols.bunium_clear_native_sublayer_clip(tracked.sublayerHandle);
    }
  }

  // Raises each id's sublayer to the top in ascending order (bottom id
  // first), which reproduces the full requested stacking order using only
  // a "raise to top" primitive -- see bunium_raise_native_sublayer's own
  // comment (bunium_shim.cpp) for why that's sufficient. Ids not currently
  // tracked (e.g. one just destroyed, racing this message) are skipped.
  updateOrder(payload: WebviewOrderPayload): void {
    for (const id of payload.order) {
      const tracked = this.webviews.get(id);
      if (!tracked) continue;
      lib.symbols.bunium_raise_native_sublayer(
        this.windowHandle,
        tracked.sublayerHandle,
      );
    }
  }
  destroy(payload: WebviewDestroyPayload): void {
    const tracked = this.webviews.get(payload.id);
    if (!tracked) return;
    this.webviews.delete(payload.id);
    lib.symbols.bunium_close_view(tracked.viewHandle);
    lib.symbols.bunium_close_native_sublayer(tracked.sublayerHandle);
  }

  // Called from BuniumWindow.close()/onUserClosed() -- an element's own
  // disconnectedCallback won't fire once its page's CEF view is itself
  // being torn down, so clean up whatever's still tracked directly.
  destroyAll(): void {
    for (const [, tracked] of this.webviews) {
      lib.symbols.bunium_close_view(tracked.viewHandle);
      lib.symbols.bunium_close_native_sublayer(tracked.sublayerHandle);
    }
    this.webviews.clear();
  }
}

export interface Size {
  width: number;
  height: number;
}

export interface Screenshot {
  width: number;
  height: number;
  /** Raw BGRA pixels, top-left origin, `width * height * 4` bytes. */
  data: Uint8Array;
}

/**
 * Maps message names to their payload type, for typing `.on()`/the
 * `window.__bunium.send()` contract between a page and its `BuniumWindow`.
 * Declare your own and pass it as `BuniumWindow<MyMessages>` for typed
 * listeners -- e.g.:
 *
 * ```ts
 * interface MyMessages {
 *   "user-clicked-thing": { id: string };
 * }
 * const win = new BuniumWindow<MyMessages>({ ... });
 * win.on("user-clicked-thing", (payload) => payload.id); // payload is typed
 * ```
 *
 * Purely a compile-time contract -- there's no runtime schema validation,
 * `JSON.parse` is trusted. Both ends (this class and whatever calls
 * `window.__bunium.send()` in the page) need to agree on the shape by
 * convention, same as any other hand-maintained IPC type in TS.
 */
// biome-ignore lint/suspicious/noExplicitAny: unconstrained index signature so BuniumWindow works untyped out of the box; consumers opt into type safety via the generic parameter
export type BuniumMessageMap = Record<string, any>;

type MessageListener<T> = (payload: T) => void;

// First public API surface of the framework. Deliberately thin -- it wraps
// the native handles from bunium_shim's flat C ABI, nothing more yet. No
// close callback yet.
export class BuniumWindow<M extends BuniumMessageMap = BuniumMessageMap>
  implements TrackedWindow
{
  private viewHandle: Pointer;
  readonly windowHandle: Pointer;
  private closed = false;
  private closeListeners: Array<() => void> = [];
  private messageListeners = new Map<string, Set<MessageListener<unknown>>>();
  // "Inner size" (CSS/logical px, what the page's JS sees as window.innerWidth
  // etc.) vs "rendered size" (physical px the paint buffer actually is) --
  // distinct once devicePixelRatio != 1. See .innerSize / .renderedSize.
  private logicalWidth: number;
  private logicalHeight: number;
  private webviews: WebviewManager;

  constructor(options: BuniumWindowOptions) {
    app.init();

    const width = options.width ?? 800;
    const height = options.height ?? 600;
    this.logicalWidth = width;
    this.logicalHeight = height;

    const transparent = options.transparent ?? false;
    const frame = options.frame ?? true;
    const resizable = options.resizable ?? true;

    this.windowHandle = lib.symbols.bunium_create_native_window(
      width,
      height,
      cstr(options.title ?? "bunium"),
      transparent ? 1 : 0,
      frame ? 1 : 0,
    )!;

    // Deliberately a separate call, not more params on create_native_window
    // above: that function hit what looks like a bun:ffi bug/limitation
    // with >8 arguments on arm64 (AAPCS64 spills args 9+ to the stack) --
    // the 10th argument (max_height) consistently arrived as 0 natively
    // despite JS-side logging confirming the correct value was passed and
    // every native signature matching. Keeping each FFI call at <=8 args
    // sidesteps it entirely, and splitting "create" from "configure
    // constraints" is arguably cleaner anyway.
    lib.symbols.bunium_set_native_window_constraints(
      this.windowHandle,
      resizable ? 1 : 0,
      options.minWidth ?? 0,
      options.minHeight ?? 0,
      options.maxWidth ?? 0,
      options.maxHeight ?? 0,
    );

    this.viewHandle = lib.symbols.bunium_create_view(
      cstr(options.url),
      width,
      height,
      transparent ? 1 : 0,
    )!;

    lib.symbols.bunium_attach_window(this.viewHandle, this.windowHandle);
    this.webviews = new WebviewManager(this.windowHandle);
    app.registerWindow(this);
  }

  get frameCount(): bigint {
    return lib.symbols.bunium_frame_count(this.viewHandle);
  }

  loadURL(url: string): void {
    lib.symbols.bunium_navigate(this.viewHandle, cstr(url));
  }

  resize(width: number, height: number): void {
    this.logicalWidth = width;
    this.logicalHeight = height;
    lib.symbols.bunium_resize(this.viewHandle, width, height);
  }

  /** The logical (CSS px) size passed to the constructor / .resize(). */
  get innerSize(): Size {
    return { width: this.logicalWidth, height: this.logicalHeight };
  }

  /**
   * The actual physical-pixel size of the paint buffer -- equals
   * innerSize * devicePixelRatio once a frame has painted at the current
   * scale. Distinct from innerSize whenever devicePixelRatio != 1 (e.g.
   * Retina displays default to 2).
   */
  get renderedSize(): Size {
    const w = new Int32Array(1);
    const h = new Int32Array(1);
    lib.symbols.bunium_view_get_frame_size(this.viewHandle, ptr(w), ptr(h));
    return { width: w[0] ?? 0, height: h[0] ?? 0 };
  }

  /**
   * The scale factor CEF is rasterizing at for this window -- currently
   * always matches the actual display (auto-detected on attach), no
   * explicit override yet (tracked as future work for e.g. capturing a
   * screenshot at a higher DPR than the display itself).
   */
  get devicePixelRatio(): number {
    return lib.symbols.bunium_get_native_window_scale(this.windowHandle);
  }

  /** Whether the user can currently drag-resize the window (the `resizable` constructor option). */
  get resizable(): boolean {
    return !!lib.symbols.bunium_get_native_window_is_resizable(
      this.windowHandle,
    );
  }

  /** The min/max content size constraints currently applied -- 0 means unconstrained on that bound. */
  get sizeConstraints(): {
    minWidth: number;
    minHeight: number;
    maxWidth: number;
    maxHeight: number;
  } {
    const minW = new Int32Array(1);
    const minH = new Int32Array(1);
    const maxW = new Int32Array(1);
    const maxH = new Int32Array(1);
    lib.symbols.bunium_get_native_window_size_constraints(
      this.windowHandle,
      ptr(minW),
      ptr(minH),
      ptr(maxW),
      ptr(maxH),
    );
    return {
      minWidth: minW[0] ?? 0,
      minHeight: minH[0] ?? 0,
      maxWidth: maxW[0] ?? 0,
      maxHeight: maxH[0] ?? 0,
    };
  }

  /**
   * Raw BGRA pixels of the most recently painted frame, at renderedSize
   * (physical px), not innerSize. Copies the buffer (the underlying native
   * buffer is reused on the next frame). Encode to PNG/etc. with an image
   * library of choice -- bunium intentionally doesn't bundle one. Sequencing
   * this over time is the primitive a future video-recording feature would
   * build on; not implemented here.
   */
  captureScreenshot(): Screenshot {
    const w = new Int32Array(1);
    const h = new Int32Array(1);
    const framePtr = lib.symbols.bunium_get_frame(
      this.viewHandle,
      ptr(w),
      ptr(h),
    );
    const width = w[0] ?? 0;
    const height = h[0] ?? 0;
    if (!framePtr || width === 0 || height === 0) {
      return { width: 0, height: 0, data: new Uint8Array(0) };
    }
    const data = new Uint8Array(
      toArrayBuffer(framePtr, 0, width * height * 4).slice(0),
    );
    return { width, height, data };
  }

  onClose(listener: () => void): void {
    this.closeListeners.push(listener);
  }

  /**
   * Listen for a `window.__bunium.send(name, JSON.stringify(payload))` call
   * from this window's page. Typed via the `M` generic parameter (see
   * `BuniumMessageMap`) if one was supplied to the constructor.
   */
  on<K extends keyof M & string>(
    name: K,
    listener: MessageListener<M[K]>,
  ): void {
    let set = this.messageListeners.get(name);
    if (!set) {
      set = new Set();
      this.messageListeners.set(name, set);
    }
    set.add(listener as MessageListener<unknown>);
  }

  off<K extends keyof M & string>(
    name: K,
    listener: MessageListener<M[K]>,
  ): void {
    this.messageListeners
      .get(name)
      ?.delete(listener as MessageListener<unknown>);
  }

  /**
   * Push a typed event to this window's page, received there via
   * `window.__bunium.on(name, handler)`. The main -> renderer direction of
   * the IPC layer (`.on()`/`.send()` above are the renderer -> main half).
   */
  emit<K extends keyof M & string>(name: K, payload: M[K]): void {
    lib.symbols.bunium_emit_to_renderer(
      this.viewHandle,
      cstr(name),
      cstr(JSON.stringify(payload)),
    );
  }

  // Called by BuniumApp's pump loop every tick -- drains the native inbox
  // and dispatches to whatever listeners .on() registered for each message
  // name. Not meant to be called directly.
  pollMessages(): void {
    for (;;) {
      const envelopePtr = lib.symbols.bunium_poll_message(this.viewHandle);
      if (envelopePtr === null) break;
      const envelope = new CString(envelopePtr).toString();

      let name: string;
      let payloadJson: string;
      try {
        ({ name, payload: payloadJson } = JSON.parse(envelope));
      } catch {
        continue; // malformed envelope -- shouldn't happen, skip rather than throw
      }

      // Reserved internal channel (draggable regions), not a message the
      // app itself should see via .on() -- pass the raw JSON straight to
      // the native setter, no parse/re-stringify round-trip needed since
      // it's already the shape bunium_set_drag_regions expects.
      if (name === DRAG_REGIONS_MESSAGE_NAME) {
        lib.symbols.bunium_set_drag_regions(this.viewHandle, cstr(payloadJson));
        continue;
      }

      if (
        name === WEBVIEW_CREATE_MESSAGE_NAME ||
        name === WEBVIEW_BOUNDS_MESSAGE_NAME ||
        name === WEBVIEW_NAVIGATE_MESSAGE_NAME ||
        name === WEBVIEW_DESTROY_MESSAGE_NAME ||
        name === WEBVIEW_CLIP_MESSAGE_NAME ||
        name === WEBVIEW_ORDER_MESSAGE_NAME
      ) {
        let webviewPayload: unknown;
        try {
          webviewPayload = JSON.parse(payloadJson);
        } catch {
          continue; // malformed -- shouldn't happen, skip rather than throw
        }
        switch (name) {
          case WEBVIEW_CREATE_MESSAGE_NAME:
            this.webviews.create(webviewPayload as WebviewCreatePayload);
            break;
          case WEBVIEW_BOUNDS_MESSAGE_NAME:
            this.webviews.updateBounds(webviewPayload as WebviewBoundsPayload);
            break;
          case WEBVIEW_NAVIGATE_MESSAGE_NAME:
            this.webviews.navigate(webviewPayload as WebviewNavigatePayload);
            break;
          case WEBVIEW_DESTROY_MESSAGE_NAME:
            this.webviews.destroy(webviewPayload as WebviewDestroyPayload);
            break;
          case WEBVIEW_CLIP_MESSAGE_NAME:
            this.webviews.updateClip(webviewPayload as WebviewClipPayload);
            break;
          case WEBVIEW_ORDER_MESSAGE_NAME:
            this.webviews.updateOrder(webviewPayload as WebviewOrderPayload);
            break;
        }
        continue;
      }

      const listeners = this.messageListeners.get(name);
      if (!listeners || listeners.size === 0) continue;

      let payload: unknown;
      try {
        payload = JSON.parse(payloadJson);
      } catch {
        continue; // page sent a non-JSON payload -- skip rather than throw
      }

      for (const listener of listeners) listener(payload);
    }
  }

  // Called by BuniumApp's pump loop when the native window's size changes
  // (e.g. the user dragged an edge) -- not meant to be called directly,
  // use resize() for programmatic resizing.
  onNativeResize(width: number, height: number): void {
    this.resize(width, height);
  }

  // Called by BuniumApp's pump loop when it detects the user closed the
  // window (red button) -- the NSWindow is already closing/closed at this
  // point, so this only cleans up the CEF-side view and fires listeners,
  // it does not call bunium_close_native_window again.
  onUserClosed(): void {
    if (this.closed) return;
    this.closed = true;
    app.unregisterWindow(this);
    this.webviews.destroyAll();
    lib.symbols.bunium_close_view(this.viewHandle);
    for (const listener of this.closeListeners) listener();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    app.unregisterWindow(this);
    this.webviews.destroyAll();
    lib.symbols.bunium_close_view(this.viewHandle);
    lib.symbols.bunium_close_native_window(this.windowHandle);
    for (const listener of this.closeListeners) listener();
  }
}
