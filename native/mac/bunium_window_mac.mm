// Native Cocoa window backing for a CEF OSR view. Kept in its own .mm
// translation unit (Objective-C++) and compiled into the same dylib as
// bunium_shim.cpp -- linked together, not a separate library.
#include <Cocoa/Cocoa.h>
#include <Metal/Metal.h>
#include <QuartzCore/CAMetalLayer.h>
#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>

// Temporary startup-timing probe (2026-09-02, investigating the first-paint
// gap vs Electron -- see PLAN.md's post-Phase-11 notes) -- same
// BUNIUM_CEF_VERBOSE gate and steady_clock approach as bunium_common.h's
// MonotonicNowUs/BuniumIpcDiagLog, duplicated here rather than including
// bunium_common.h (kept independent to avoid pulling CEF headers into this
// Cocoa-only translation unit).
static bool BuniumWindowVerbose() {
  static const bool on = getenv("BUNIUM_CEF_VERBOSE") != nullptr;
  return on;
}
static int64_t BuniumWindowNowUs() {
  return std::chrono::duration_cast<std::chrono::microseconds>(
             std::chrono::steady_clock::now().time_since_epoch())
      .count();
}

// Implemented in bunium_shim.cpp, linked into the same dylib -- forwards
// raw Cocoa mouse events to whichever CefBrowser is attached to
// `window_handle` (primary view only for now, see task tracking sublayer
// hit-testing as a follow-up).
extern "C" void bunium_dispatch_mouse_click(void* window_handle, int x, int y,
                                             int button, int mouse_up,
                                             int click_count);
extern "C" int bunium_is_window_point_draggable(void* window_handle, int x,
                                                 int y);
extern "C" void bunium_dispatch_mouse_move(void* window_handle, int x, int y,
                                            int mouse_leave);
extern "C" void bunium_dispatch_key_event(void* window_handle, int event_type,
                                           int modifiers, int key_code,
                                           uint16_t character);

// Custom resize-bar hit-testing for frameless (frame:false / borderless)
// windows -- AppKit only gives edge-drag resizing for free to *titled*
// windows (via NSThemeFrame); a borderless window loses it entirely even
// with NSWindowStyleMaskResizable set, since there's no chrome for the
// window manager to track. This replicates the behavior manually in
// BuniumContentView's mouse handlers below. Titled windows never hit this
// path (checked via styleMask at the callsite) -- they already resize
// correctly via native chrome, no need to duplicate that.
typedef NS_OPTIONS(NSUInteger, BuniumResizeEdge) {
  kBuniumResizeEdgeNone = 0,
  kBuniumResizeEdgeLeft = 1 << 0,
  kBuniumResizeEdgeRight = 1 << 1,
  kBuniumResizeEdgeTop = 1 << 2,
  kBuniumResizeEdgeBottom = 1 << 3,
};

static const CGFloat kBuniumResizeBorder = 6.0;

// `p`/`bounds` are in BuniumContentView's own (flipped, top-left-origin)
// coordinate space -- same convention CEF/the rest of this file already
// uses for mouse events, so "top" here means visually top regardless of
// AppKit's own bottom-left-origin screen space (that distinction matters
// for ApplyResizeDelta below, which operates in screen space instead).
static BuniumResizeEdge ResizeEdgeAtPoint(NSPoint p, NSRect bounds) {
  BuniumResizeEdge edge = kBuniumResizeEdgeNone;
  if (p.x <= kBuniumResizeBorder) edge = (BuniumResizeEdge)(edge | kBuniumResizeEdgeLeft);
  if (p.x >= bounds.size.width - kBuniumResizeBorder)
    edge = (BuniumResizeEdge)(edge | kBuniumResizeEdgeRight);
  if (p.y <= kBuniumResizeBorder) edge = (BuniumResizeEdge)(edge | kBuniumResizeEdgeTop);
  if (p.y >= bounds.size.height - kBuniumResizeBorder)
    edge = (BuniumResizeEdge)(edge | kBuniumResizeEdgeBottom);
  return edge;
}

// Applies one resize-drag step: given the edge(s) grabbed and the mouse's
// screen-space delta since drag start, computes and applies the new window
// frame, clamped to contentMinSize/contentMaxSize. Screen coordinates are
// AppKit's own convention (y-up, origin bottom-left) -- NOT the flipped
// view-local space ResizeEdgeAtPoint uses above, since NSWindow.frame and
// [NSEvent mouseLocation] are both already in screen space and converting
// through the view would just be extra work for no benefit here. Only the
// edge(s) actually being dragged move their own origin coordinate to
// compensate when a min/max clamp kicks in -- the opposite edge is always
// the anchor and must never move out from under the user's other hand.
static void ApplyResizeDelta(NSWindow* window, BuniumResizeEdge edge,
                              NSRect startFrame, CGFloat deltaX,
                              CGFloat deltaY) {
  CGFloat x = startFrame.origin.x;
  CGFloat y = startFrame.origin.y;
  CGFloat w = startFrame.size.width;
  CGFloat h = startFrame.size.height;

  if (edge & kBuniumResizeEdgeLeft) {
    x += deltaX;
    w -= deltaX;
  }
  if (edge & kBuniumResizeEdgeRight) w += deltaX;
  if (edge & kBuniumResizeEdgeTop) h += deltaY;
  if (edge & kBuniumResizeEdgeBottom) {
    y += deltaY;
    h -= deltaY;
  }

  NSSize minSize = window.contentMinSize;
  NSSize maxSize = window.contentMaxSize;
  CGFloat clampedW = std::clamp(w, minSize.width, maxSize.width);
  CGFloat clampedH = std::clamp(h, minSize.height, maxSize.height);
  if (edge & kBuniumResizeEdgeLeft) x -= (clampedW - w);
  if (edge & kBuniumResizeEdgeBottom) y -= (clampedH - h);

  [window setFrame:NSMakeRect(x, y, clampedW, clampedH) display:YES];
}

struct BuniumWindowHandle {
  NSWindow* window;
  CAMetalLayer* layer;
  std::atomic<bool> closed_by_user{false};
  // Clipping/stacking support for sublayers only (window's own primary
  // layer never uses these -- always nil for that case). A sublayer needs
  // to visually respect a DOM ancestor's `overflow: hidden` the same way a
  // real child element would; CALayer supports this natively via a masking
  // parent layer (`masksToBounds`), but nothing sets that up by default --
  // `layer` is added directly as a child of the window/parent-sublayer's
  // own layer at creation. `bunium_sublayer_set_clip` (below) lazily
  // reparents `layer` under `clipLayer` the first time clipping becomes
  // active, and un-reparents it back under `hostLayer` if clipping is later
  // removed (e.g. the element scrolled out from under its clipping
  // ancestor). `hostLayer` is fixed at creation time and never changes --
  // needed because once `layer`'s superlayer becomes `clipLayer`, there's
  // no other way to recover "where does this sublayer originally attach"
  // when un-clipping. `absFrame` is the sublayer's true window-relative
  // frame regardless of clip state (what JS/bunium_sublayer_set_frame
  // thinks the sublayer's position is) -- `layer.frame` itself becomes
  // relative to `clipLayer` once clipping is active, so `absFrame` is kept
  // separately and `layer.frame` is always *derived* from it (see
  // BuniumSublayerReposition), never treated as the source of truth once
  // clipping is in play.
  CALayer* hostLayer = nil;
  CALayer* clipLayer = nil;
  CGRect absFrame = CGRectZero;
  // NSWindow.delegate is `weak` -- ARC won't keep our delegate alive on its
  // own. Hold a manual +1 (via CFBridgingRetain) and release it in
  // bunium_window_close. `void*` because ARC forbids ownership-qualified
  // ObjC pointers as members of a plain C++ struct.
  void* delegate_retained = nullptr;
  // Metal-specific: `void*` for the same ARC-in-a-plain-struct reason above.
  // CEF rasterizes on the CPU (deliberately -- GPU-composited OSR measured
  // slower, see ARCHITECTURE.md); Metal here is presentation-only, uploading
  // the CPU buffer into a drawable's texture each frame instead of going
  // through CGImageCreate.
  void* device_retained = nullptr;
  void* command_queue_retained = nullptr;
  // titleBarStyle/trafficLightPosition (Electron parity, mac-only concept --
  // there's no equivalent on Windows/Linux, see the no-op stubs on those
  // platforms). AppKit resets standardWindowButton frames on every resize
  // (Cocoa re-lays-out the title bar), so the requested position has to be
  // remembered and reapplied from windowDidResize below, not just set once.
  CGFloat trafficLightX = 0;
  CGFloat trafficLightY = 0;
  bool hasTrafficLightPosition = false;
};

// Repositions the three standard title-bar buttons to (x, y), measured from
// the title bar's top-left corner (same convention as Electron's
// trafficLightPosition). Spacing between buttons is read from their own
// existing layout rather than hardcoded, so this keeps working if a future
// macOS changes the standard spacing/size. No-op if the window has no
// title-bar buttons (e.g. a frame:false/borderless window).
static void BuniumRepositionTrafficLights(NSWindow* window, CGFloat x, CGFloat y) {
  NSButton* close = [window standardWindowButton:NSWindowCloseButton];
  NSButton* miniaturize = [window standardWindowButton:NSWindowMiniaturizeButton];
  NSButton* zoom = [window standardWindowButton:NSWindowZoomButton];
  if (!close || !miniaturize || !zoom) return;

  NSView* titleBarView = close.superview;
  if (!titleBarView) return;

  CGFloat spacing = miniaturize.frame.origin.x - close.frame.origin.x;
  CGFloat buttonHeight = close.frame.size.height;

  NSArray<NSButton*>* buttons = @[ close, miniaturize, zoom ];
  for (NSUInteger i = 0; i < buttons.count; i++) {
    NSRect rect = buttons[i].frame;
    rect.origin.x = x + (CGFloat)i * spacing;
    rect.origin.y = titleBarView.frame.size.height - y - buttonHeight;
    [buttons[i] setFrameOrigin:rect.origin];
  }
}

// Only job: flip closed_by_user when the user clicks the window's close
// button. Polled from JS (bunium_window_is_closed) rather than pushed via a
// native-to-JS callback -- same "JS orchestrates, native just answers
// queries" pattern as bunium_window_get_size.
@interface BuniumWindowDelegate : NSObject <NSWindowDelegate>
@property(nonatomic, assign) BuniumWindowHandle* handle;
@end

@implementation BuniumWindowDelegate
- (void)windowWillClose:(NSNotification*)notification {
  if (self.handle) self.handle->closed_by_user.store(true);
}
- (void)windowDidResize:(NSNotification*)notification {
  if (self.handle && self.handle->hasTrafficLightPosition) {
    BuniumRepositionTrafficLights(self.handle->window, self.handle->trafficLightX,
                                   self.handle->trafficLightY);
  }
}
@end

// The content view for a bunium window. Its only jobs: host the
// CAMetalLayer (set up by the caller after construction) and forward raw
// mouse events to bunium_dispatch_mouse_click/_move, keyed by
// `window_handle` (this view's identity is otherwise Cocoa boilerplate).
// isFlipped=YES makes this view's local coordinate space top-left-origin,
// matching CEF's convention directly -- no manual y-flip needed when
// forwarding locationInView.
@interface BuniumContentView : NSView
@property(nonatomic, assign) void* windowHandle;
// Active resize-drag state, only ever set while the user is dragging one of
// the synthetic resize edges on a borderless (frame:false) + resizable
// window -- see ResizeEdgeAtPoint/ApplyResizeDelta above. kBuniumResizeEdgeNone
// means "no resize in progress", checked at the top of mouseDragged:/mouseUp:
// to distinguish a resize drag from an ordinary click-drag forwarded to CEF.
@property(nonatomic, assign) BuniumResizeEdge activeResizeEdge;
@property(nonatomic, assign) NSRect resizeStartFrame;
@property(nonatomic, assign) NSPoint resizeStartMouseScreenLocation;
@end

@implementation BuniumContentView
- (BOOL)isFlipped {
  return YES;
}
- (BOOL)acceptsFirstResponder {
  return YES;
}
// Only borderless + resizable windows get synthetic resize-edge dragging --
// titled windows already resize for free via native NSThemeFrame chrome, and
// a non-resizable window (resizable:false) must never resize no matter how
// its frame style got there. Checked at the two callsites below rather than
// baked into ResizeEdgeAtPoint itself, so that function stays a pure
// geometry helper.
- (BOOL)shouldUseSyntheticResizeEdges {
  NSWindowStyleMask mask = self.window.styleMask;
  BOOL isBorderless = !(mask & NSWindowStyleMaskTitled);
  BOOL isResizable = (mask & NSWindowStyleMaskResizable) != 0;
  return isBorderless && isResizable;
}
- (void)mouseDown:(NSEvent*)event {
  NSPoint p = [self convertPoint:event.locationInWindow fromView:nil];
  // Resize edges take priority over draggable regions: the border is a thin
  // 6px strip inset from the true window edge, while drag regions are
  // typically a whole titlebar-height strip that can overlap it (e.g. a
  // full-width custom titlebar in a frame:false window). A user grabbing
  // right at the window's physical edge almost always means "resize", not
  // "move the window" -- matches native title-bar behavior, where the resize
  // border also takes priority over the draggable titlebar beneath it.
  if ([self shouldUseSyntheticResizeEdges]) {
    BuniumResizeEdge edge = ResizeEdgeAtPoint(p, self.bounds);
    if (edge != kBuniumResizeEdgeNone) {
      self.activeResizeEdge = edge;
      self.resizeStartFrame = self.window.frame;
      self.resizeStartMouseScreenLocation = [NSEvent mouseLocation];
      return;
    }
  }
  // Draggable regions (-webkit-app-region: drag equivalent) eat the click
  // entirely rather than also forwarding it to CEF -- known v1 limitation,
  // no Electron-style app-region:no-drag override for interactive elements
  // inside a drag region yet.
  if (bunium_is_window_point_draggable(self.windowHandle, (int)p.x, (int)p.y)) {
    [self.window performWindowDragWithEvent:event];
    return;
  }
  bunium_dispatch_mouse_click(self.windowHandle, (int)p.x, (int)p.y,
                               /*button=*/0, /*mouse_up=*/0,
                               (int)event.clickCount);
}
- (void)mouseUp:(NSEvent*)event {
  if (self.activeResizeEdge != kBuniumResizeEdgeNone) {
    self.activeResizeEdge = kBuniumResizeEdgeNone;
    return;
  }
  NSPoint p = [self convertPoint:event.locationInWindow fromView:nil];
  bunium_dispatch_mouse_click(self.windowHandle, (int)p.x, (int)p.y,
                               /*button=*/0, /*mouse_up=*/1,
                               (int)event.clickCount);
}
- (void)rightMouseDown:(NSEvent*)event {
  NSPoint p = [self convertPoint:event.locationInWindow fromView:nil];
  bunium_dispatch_mouse_click(self.windowHandle, (int)p.x, (int)p.y,
                               /*button=*/2, /*mouse_up=*/0,
                               (int)event.clickCount);
}
- (void)rightMouseUp:(NSEvent*)event {
  NSPoint p = [self convertPoint:event.locationInWindow fromView:nil];
  bunium_dispatch_mouse_click(self.windowHandle, (int)p.x, (int)p.y,
                               /*button=*/2, /*mouse_up=*/1,
                               (int)event.clickCount);
}
- (void)mouseMoved:(NSEvent*)event {
  NSPoint p = [self convertPoint:event.locationInWindow fromView:nil];
  bunium_dispatch_mouse_move(self.windowHandle, (int)p.x, (int)p.y, 0);
}
- (void)mouseDragged:(NSEvent*)event {
  if (self.activeResizeEdge != kBuniumResizeEdgeNone) {
    NSPoint mouseNow = [NSEvent mouseLocation];
    CGFloat deltaX = mouseNow.x - self.resizeStartMouseScreenLocation.x;
    CGFloat deltaY = mouseNow.y - self.resizeStartMouseScreenLocation.y;
    ApplyResizeDelta(self.window, self.activeResizeEdge, self.resizeStartFrame,
                      deltaX, deltaY);
    return;
  }
  NSPoint p = [self convertPoint:event.locationInWindow fromView:nil];
  bunium_dispatch_mouse_move(self.windowHandle, (int)p.x, (int)p.y, 0);
}
- (void)keyDown:(NSEvent*)event {
  bunium_dispatch_key_event(self.windowHandle, /*RAWKEYDOWN=*/0, 0,
                             (int)event.keyCode, 0);
  if (event.characters.length > 0) {
    unichar ch = [event.characters characterAtIndex:0];
    bunium_dispatch_key_event(self.windowHandle, /*CHAR=*/3, 0,
                               (int)event.keyCode, (uint16_t)ch);
  }
}
- (void)keyUp:(NSEvent*)event {
  bunium_dispatch_key_event(self.windowHandle, /*KEYUP=*/2, 0,
                             (int)event.keyCode, 0);
}
@end

extern "C" __attribute__((visibility("default"))) void*
bunium_window_create(int width, int height, const char* title,
                      int transparent, int frame_enabled) {
  @autoreleasepool {
    if (BuniumWindowVerbose())
      fprintf(stderr, "[startup-diag] t=%lld us stage=window_create_start\n",
              (long long)BuniumWindowNowUs());
    [NSApplication sharedApplication];
    if (BuniumWindowVerbose())
      fprintf(stderr, "[startup-diag] t=%lld us stage=nsapplication_shared_done\n",
              (long long)BuniumWindowNowUs());
    [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];

    // frame_enabled=false -> Borderless (Electron's frame:false equivalent:
    // no title bar, no traffic-light buttons). Resizable starts on here --
    // bunium_window_set_constraints (called right after, see its own
    // comment for why this is a separate call) can remove it.
    NSWindowStyleMask styleMask =
        frame_enabled
            ? (NSWindowStyleMaskTitled | NSWindowStyleMaskClosable |
               NSWindowStyleMaskResizable)
            : (NSWindowStyleMaskBorderless | NSWindowStyleMaskResizable);

    NSRect windowRect = NSMakeRect(100, 100, width, height);
    NSWindow* window = [[NSWindow alloc]
        initWithContentRect:windowRect
                  styleMask:styleMask
                    backing:NSBackingStoreBuffered
                      defer:NO];
    [window setTitle:[NSString stringWithUTF8String:title]];

    if (transparent) {
      window.opaque = NO;
      window.backgroundColor = [NSColor clearColor];
      window.hasShadow = NO;
    }

    if (BuniumWindowVerbose())
      fprintf(stderr, "[startup-diag] t=%lld us stage=nswindow_alloc_done\n",
              (long long)BuniumWindowNowUs());
    id<MTLDevice> device = MTLCreateSystemDefaultDevice();
    if (BuniumWindowVerbose())
      fprintf(stderr, "[startup-diag] t=%lld us stage=mtl_device_created\n",
              (long long)BuniumWindowNowUs());
    id<MTLCommandQueue> commandQueue = [device newCommandQueue];
    if (BuniumWindowVerbose())
      fprintf(stderr, "[startup-diag] t=%lld us stage=mtl_command_queue_created\n",
              (long long)BuniumWindowNowUs());

    CAMetalLayer* metalLayer = [CAMetalLayer layer];
    metalLayer.device = device;
    metalLayer.pixelFormat = MTLPixelFormatBGRA8Unorm;
    metalLayer.framebufferOnly = NO;  // must be writable for replaceRegion
    metalLayer.opaque = !transparent;
    metalLayer.drawableSize = CGSizeMake(width, height);
    metalLayer.backgroundColor =
        transparent ? [NSColor clearColor].CGColor : [NSColor blackColor].CGColor;
    // Paint buffer is top-left origin (browser convention); flip the layer
    // so the upload lands right-side up without a manual row-reverse.
    metalLayer.geometryFlipped = YES;
    // Without this, CoreAnimation assumes the drawable's pixels are 1:1
    // with points and stretches them to fill the (point-sized) frame --
    // that stretch is the blur the user is seeing on Retina displays.
    // window.backingScaleFactor reflects whichever actual screen the
    // window is on (correct for multi-monitor setups), read after the
    // window exists since it's not meaningful before that.
    metalLayer.contentsScale = window.backingScaleFactor;

    BuniumContentView* contentView =
        [[BuniumContentView alloc] initWithFrame:windowRect];
    [contentView setWantsLayer:YES];
    contentView.layer = metalLayer;
    window.contentView = contentView;
    [window setAcceptsMouseMovedEvents:YES];

    // Without this, macOS's own window management (Stage Manager /
    // automatic tiling on recent macOS versions) was observed resizing a
    // freshly-created resizable+titled window on its own a few hundred ms
    // after creation, with no resize call from us -- confirmed via a bare
    // window with no CEF view attached at all, so definitely not a bunium
    // bug, but still something bunium needs to defend against since a
    // silently-resized window breaks the "inner size == what you asked
    // for" contract. FullScreenNone/FullScreenAuxiliary opt out of both
    // Spaces-fullscreen and Stage-Manager-style auto-tiling participation.
    window.collectionBehavior =
        NSWindowCollectionBehaviorFullScreenNone |
        NSWindowCollectionBehaviorFullScreenAuxiliary;

    [window makeKeyAndOrderFront:nil];
    [window makeFirstResponder:contentView];
    [NSApp activateIgnoringOtherApps:YES];

    auto* handle = new BuniumWindowHandle{window, metalLayer};
    handle->device_retained = (void*)CFBridgingRetain(device);
    handle->command_queue_retained = (void*)CFBridgingRetain(commandQueue);
    contentView.windowHandle = handle;

    BuniumWindowDelegate* delegate = [[BuniumWindowDelegate alloc] init];
    delegate.handle = handle;
    window.delegate = delegate;
    handle->delegate_retained = (void*)CFBridgingRetain(delegate);

    if (BuniumWindowVerbose())
      fprintf(stderr, "[startup-diag] t=%lld us stage=window_create_return\n",
              (long long)BuniumWindowNowUs());
    return handle;
  }
}

// Electron's macOS titleBarStyle: 0=default (normal titled window), 1=hidden
// (title bar area absorbed into the content view, traffic lights stay at
// their normal spot), 2=hiddenInset (same, plus traffic lights nudged to a
// standard inset position -- matches Electron's own hiddenInset look).
// No-op on a frame:false/borderless window (no title bar to style). A prior
// explicit bunium_window_set_traffic_light_position call is left untouched
// by style 1; style 2 only applies its own default inset if the app hasn't
// already set a custom position.
extern "C" __attribute__((visibility("default"))) void
bunium_window_set_titlebar_style(void* handle, int style) {
  @autoreleasepool {
    auto* h = static_cast<BuniumWindowHandle*>(handle);
    NSWindow* window = h->window;
    if (!(window.styleMask & NSWindowStyleMaskTitled)) return;

    if (style == 0) {
      window.titlebarAppearsTransparent = NO;
      window.titleVisibility = NSWindowTitleVisible;
      window.styleMask &= ~NSWindowStyleMaskFullSizeContentView;
      return;
    }

    window.titlebarAppearsTransparent = YES;
    window.titleVisibility = NSWindowTitleHidden;
    window.styleMask |= NSWindowStyleMaskFullSizeContentView;

    if (style == 2 && !h->hasTrafficLightPosition) {
      h->trafficLightX = 20;
      h->trafficLightY = 20;
      h->hasTrafficLightPosition = true;
    }
    if (h->hasTrafficLightPosition) {
      BuniumRepositionTrafficLights(window, h->trafficLightX, h->trafficLightY);
    }
  }
}

// Explicit traffic-light-position override (Electron's trafficLightPosition
// option). Applies immediately and is remembered for reapplication on every
// future resize (see BuniumWindowDelegate.windowDidResize above -- AppKit
// resets the standard buttons' frames on its own during title-bar layout).
extern "C" __attribute__((visibility("default"))) void
bunium_window_set_traffic_light_position(void* handle, int x, int y) {
  @autoreleasepool {
    auto* h = static_cast<BuniumWindowHandle*>(handle);
    h->trafficLightX = x;
    h->trafficLightY = y;
    h->hasTrafficLightPosition = true;
    BuniumRepositionTrafficLights(h->window, x, y);
  }
}

// Unlike the earlier CGDataProviderCreateWithData path, replaceRegion below
// copies `bgra` into the texture synchronously before returning -- no
// use-after-free risk here (see ARCHITECTURE.md §8 for why that mattered
// with the CG path).
extern "C" __attribute__((visibility("default"))) void bunium_window_update_frame(
    void* handle, const uint8_t* bgra, int width, int height) {
  @autoreleasepool {
    auto* h = static_cast<BuniumWindowHandle*>(handle);

    if (h->layer.drawableSize.width != width ||
        h->layer.drawableSize.height != height) {
      h->layer.drawableSize = CGSizeMake(width, height);
    }

    id<CAMetalDrawable> drawable = [h->layer nextDrawable];
    if (!drawable) return;  // e.g. window occluded/minimized; skip this frame

    MTLRegion region = MTLRegionMake2D(0, 0, width, height);
    [drawable.texture replaceRegion:region
                         mipmapLevel:0
                           withBytes:bgra
                         bytesPerRow:static_cast<NSUInteger>(width) * 4];

    id<MTLCommandQueue> queue =
        (__bridge id<MTLCommandQueue>)h->command_queue_retained;
    id<MTLCommandBuffer> commandBuffer = [queue commandBuffer];
    [commandBuffer presentDrawable:drawable];
    [commandBuffer commit];
  }
}

extern "C" __attribute__((visibility("default"))) void bunium_window_pump_events() {
  @autoreleasepool {
    NSEvent* event;
    while ((event = [NSApp nextEventMatchingMask:NSEventMaskAny
                                        untilDate:[NSDate distantPast]
                                           inMode:NSDefaultRunLoopMode
                                          dequeue:YES])) {
      [NSApp sendEvent:event];
    }
  }
}

extern "C" __attribute__((visibility("default"))) int bunium_window_get_id(
    void* handle) {
  auto* h = static_cast<BuniumWindowHandle*>(handle);
  return (int)h->window.windowNumber;
}

// Polled from the JS pump loop (see BuniumApp.tick in src/app.ts) rather
// than pushed via an NSWindowDelegate callback -- keeps all orchestration
// on the JS side instead of adding a native-to-JS callback bridge.
extern "C" __attribute__((visibility("default"))) void bunium_window_get_size(
    void* handle, int* out_width, int* out_height) {
  auto* h = static_cast<BuniumWindowHandle*>(handle);
  NSRect bounds = h->window.contentView.bounds;
  *out_width = (int)bounds.size.width;
  *out_height = (int)bounds.size.height;
}

// Works for both a window's primary layer and a sublayer -- both are
// CAMetalLayers with contentsScale already set correctly at creation time.
extern "C" __attribute__((visibility("default"))) double
bunium_window_get_scale(void* handle) {
  auto* h = static_cast<BuniumWindowHandle*>(handle);
  return h->layer.contentsScale;
}

// Separate from bunium_window_create deliberately: that function hit what
// looks like a bun:ffi bug/limitation with >8 arguments on arm64 (AAPCS64
// spills args 9+ to the stack) -- the 10th argument consistently arrived
// as 0 natively despite JS confirming the correct value was sent and every
// native signature matching. resizable/min/max as constructor params would
// have pushed create() to 10 args; splitting into a second <=8-arg call
// (5 here) sidesteps it, and NSWindow's styleMask/contentMinSize/
// contentMaxSize are all mutable post-creation anyway, so nothing is lost.
extern "C" __attribute__((visibility("default"))) void
bunium_window_set_constraints(void* handle, int resizable, int min_width,
                               int min_height, int max_width, int max_height) {
  auto* h = static_cast<BuniumWindowHandle*>(handle);

  if (resizable) {
    h->window.styleMask |= NSWindowStyleMaskResizable;
  } else {
    h->window.styleMask &= ~NSWindowStyleMaskResizable;
  }

  // 0 means "no constraint" on either side -- NSWindow's own defaults are
  // contentMinSize={0,0} and contentMaxSize={CGFLOAT_MAX,CGFLOAT_MAX}, so
  // only override when a real value was passed.
  if (min_width > 0 || min_height > 0) {
    h->window.contentMinSize = NSMakeSize(min_width, min_height);
  }
  if (max_width > 0 || max_height > 0) {
    h->window.contentMaxSize =
        NSMakeSize(max_width > 0 ? max_width : CGFLOAT_MAX,
                   max_height > 0 ? max_height : CGFLOAT_MAX);
  }
}

// Readbacks used only for verification (JS can't otherwise observe whether
// resizable/min/max size were actually applied) -- not part of the
// steady-state hot path, same rationale as bunium_sublayer_get_frame.
extern "C" __attribute__((visibility("default"))) int
bunium_window_is_resizable(void* handle) {
  auto* h = static_cast<BuniumWindowHandle*>(handle);
  return (h->window.styleMask & NSWindowStyleMaskResizable) ? 1 : 0;
}

extern "C" __attribute__((visibility("default"))) void
bunium_window_get_size_constraints(void* handle, int* out_min_width,
                                    int* out_min_height, int* out_max_width,
                                    int* out_max_height) {
  auto* h = static_cast<BuniumWindowHandle*>(handle);
  *out_min_width = (int)h->window.contentMinSize.width;
  *out_min_height = (int)h->window.contentMinSize.height;
  *out_max_width = h->window.contentMaxSize.width >= CGFLOAT_MAX
                        ? 0
                        : (int)h->window.contentMaxSize.width;
  *out_max_height = h->window.contentMaxSize.height >= CGFLOAT_MAX
                         ? 0
                         : (int)h->window.contentMaxSize.height;
}

extern "C" __attribute__((visibility("default"))) int bunium_window_is_closed(
    void* handle) {
  auto* h = static_cast<BuniumWindowHandle*>(handle);
  return h->closed_by_user.load() ? 1 : 0;
}

// A sublayer is a second independently-painted CAMetalLayer composited
// inside an existing window's layer tree -- the mechanical building block
// for a DOM-integrated <webview>: the outer app is the window's primary
// layer, an embedded page is a sublayer positioned/transformed to track a
// DOM element (that JS<->native bounds sync is a separate, later piece).
// Reuses the exact same BuniumWindowHandle shape as the window's own
// primary layer (`window` stays null) so bunium_window_update_frame above
// works unmodified for sublayers too -- it only ever touches ->layer and
// ->command_queue_retained.
extern "C" __attribute__((visibility("default"))) void*
bunium_create_sublayer(void* window_handle, int x, int y, int width,
                        int height) {
  @autoreleasepool {
    auto* parent = static_cast<BuniumWindowHandle*>(window_handle);

    id<MTLDevice> device = MTLCreateSystemDefaultDevice();
    id<MTLCommandQueue> commandQueue = [device newCommandQueue];

    CAMetalLayer* sublayer = [CAMetalLayer layer];
    sublayer.device = device;
    sublayer.pixelFormat = MTLPixelFormatBGRA8Unorm;
    sublayer.framebufferOnly = NO;
    sublayer.frame = CGRectMake(x, y, width, height);
    sublayer.drawableSize = CGSizeMake(width, height);
    sublayer.geometryFlipped = YES;
    // Inherit scale from the parent window (or parent layer, if this
    // sublayer is itself nested inside another sublayer) -- same blur
    // fix as the primary window layer above.
    sublayer.contentsScale =
        parent->window ? parent->window.backingScaleFactor
                        : parent->layer.contentsScale;
    [parent->layer addSublayer:sublayer];

    auto* handle = new BuniumWindowHandle{nullptr, sublayer};
    handle->device_retained = (void*)CFBridgingRetain(device);
    handle->command_queue_retained = (void*)CFBridgingRetain(commandQueue);
    handle->hostLayer = parent->layer;
    handle->absFrame = CGRectMake(x, y, width, height);
    return handle;
  }
}

static void BuniumSublayerReposition(BuniumWindowHandle* h) {
  if (h->clipLayer) {
    CGRect clipFrame = h->clipLayer.frame;
    h->layer.frame = CGRectMake(h->absFrame.origin.x - clipFrame.origin.x,
                                 h->absFrame.origin.y - clipFrame.origin.y,
                                 h->absFrame.size.width,
                                 h->absFrame.size.height);
  } else {
    h->layer.frame = h->absFrame;
  }
}

extern "C" __attribute__((visibility("default"))) void
bunium_sublayer_set_frame(void* layer_handle, int x, int y, int width,
                           int height) {
  auto* h = static_cast<BuniumWindowHandle*>(layer_handle);
  h->absFrame = CGRectMake(x, y, width, height);
  BuniumSublayerReposition(h);
  if (h->layer.drawableSize.width != width ||
      h->layer.drawableSize.height != height) {
    h->layer.drawableSize = CGSizeMake(width, height);
  }
}

// Clips a sublayer to `clip_rect` (same host-relative coordinate space as
// bunium_sublayer_set_frame's x/y/width/height) -- the native-side half of
// DOM `overflow: hidden` ancestor clipping for <bunium-webview>. The
// sublayer's CEF content is *not* re-rasterized or resized -- only its
// on-screen visible portion changes, exactly matching how a real child
// element gets visually clipped by an overflow:hidden ancestor without the
// element itself being resized. Implemented by lazily reparenting `layer`
// under a new invisible `clipLayer` (`masksToBounds = YES`) sized to
// `clip_rect`, added as a sibling of `layer` in its original host layer,
// with `layer`'s own frame then re-expressed relative to `clipLayer`'s
// origin via BuniumSublayerReposition instead of the host's. Safe to call
// every rAF tick while scrolling -- `clipLayer` is only created once (first
// call), later calls just move the existing one.
extern "C" __attribute__((visibility("default"))) void
bunium_sublayer_set_clip(void* layer_handle, int clip_x, int clip_y,
                          int clip_w, int clip_h) {
  auto* h = static_cast<BuniumWindowHandle*>(layer_handle);
  if (!h->clipLayer) {
    CALayer* clip = [CALayer layer];
    clip.masksToBounds = YES;
    [h->hostLayer addSublayer:clip];
    [h->layer removeFromSuperlayer];
    [clip addSublayer:h->layer];
    h->clipLayer = clip;
  }
  h->clipLayer.frame = CGRectMake(clip_x, clip_y, clip_w, clip_h);
  BuniumSublayerReposition(h);
}

// Removes an active clip (e.g. the element scrolled out from under its
// clipping ancestor, or the ancestor's overflow style changed) -- reparents
// `layer` back under its original host layer at its true absFrame position.
// A no-op if no clip is active, so JS doesn't need to track clip state
// itself before calling this.
extern "C" __attribute__((visibility("default"))) void
bunium_sublayer_clear_clip(void* layer_handle) {
  auto* h = static_cast<BuniumWindowHandle*>(layer_handle);
  if (!h->clipLayer) return;
  [h->layer removeFromSuperlayer];
  [h->hostLayer addSublayer:h->layer];
  [h->clipLayer removeFromSuperlayer];
  h->clipLayer = nil;
  BuniumSublayerReposition(h);
}

// Verification-only readback: is a clip currently active, and if so what
// visible (on-screen, post-clip) rect is actually being displayed --
// distinct from bunium_sublayer_get_frame's absFrame, which stays the
// element's full nominal rect regardless of clipping. Returns 0/1 via
// *out_clipped; out_x/y/width/height are only meaningful when *out_clipped
// is 1 (computed as the intersection of absFrame and the clip rect, i.e.
// exactly what's visible on screen).
extern "C" __attribute__((visibility("default"))) void
bunium_sublayer_get_clip(void* layer_handle, int* out_clipped, int* out_x,
                          int* out_y, int* out_width, int* out_height) {
  auto* h = static_cast<BuniumWindowHandle*>(layer_handle);
  if (!h->clipLayer) {
    *out_clipped = 0;
    *out_x = *out_y = *out_width = *out_height = 0;
    return;
  }
  CGRect visible = CGRectIntersection(h->absFrame, h->clipLayer.frame);
  *out_clipped = 1;
  *out_x = (int)visible.origin.x;
  *out_y = (int)visible.origin.y;
  *out_width = (int)visible.size.width;
  *out_height = (int)visible.size.height;
}

// Readback used both by HitTestSublayer (bunium_shim.cpp, real hit-testing
// hot path) and by JS verification (JS can't otherwise observe whether a
// native sublayer actually moved). Returns absFrame -- the sublayer's true
// window-relative frame -- rather than h->layer.frame directly: once a
// clip is active (bunium_sublayer_set_clip), layer.frame becomes relative
// to clipLayer's origin instead, which would silently break both callers
// (hit-testing would compute the wrong window-space rect; verification
// reads would report the wrong position) if this weren't distinguished
// from the on-screen CALayer frame.
extern "C" __attribute__((visibility("default"))) void
bunium_sublayer_get_frame(void* layer_handle, int* out_x, int* out_y,
                           int* out_width, int* out_height) {
  auto* h = static_cast<BuniumWindowHandle*>(layer_handle);
  CGRect frame = h->hostLayer ? h->absFrame : h->layer.frame;
  *out_x = (int)frame.origin.x;
  *out_y = (int)frame.origin.y;
  *out_width = (int)frame.size.width;
  *out_height = (int)frame.size.height;
}



// Moves a sublayer (and its clipLayer, if clipping is active) to the top
// of its current superlayer's sublayers array -- CALayer sublayer order is
// paint order, last = topmost, so removeFromSuperlayer + addSublayer:
// reliably re-appends to the end regardless of current position. Used to
// sync DOM stacking order (CSS z-index / DOM order, approximated -- see
// _syncOrder in WEBVIEW_ELEMENT_JS) for sibling <bunium-webview> elements
// to actual CALayer paint order; see WebviewManager.updateOrder (window.ts).
// No-op for a window handle (hostLayer/clipLayer both nil -- windows don't
// have siblings in this sense).
extern "C" __attribute__((visibility("default"))) void
bunium_sublayer_raise_to_top(void* layer_handle) {
  auto* h = static_cast<BuniumWindowHandle*>(layer_handle);
  if (h->clipLayer) {
    // Raise clipLayer itself, since that's what's actually attached to
    // hostLayer -- `layer` is clipLayer's only child, so its position
    // within clipLayer is irrelevant.
    CALayer* parent = h->clipLayer.superlayer;
    if (parent) {
      [h->clipLayer removeFromSuperlayer];
      [parent addSublayer:h->clipLayer];
    }
  } else if (h->hostLayer) {
    [h->layer removeFromSuperlayer];
    [h->hostLayer addSublayer:h->layer];
  }
}

extern "C" __attribute__((visibility("default"))) void bunium_close_sublayer(
    void* layer_handle) {
  auto* h = static_cast<BuniumWindowHandle*>(layer_handle);
  [h->layer removeFromSuperlayer];
  // If a clip was active, `clipLayer` is otherwise now an orphaned empty
  // CALayer with nothing referencing it from our side -- remove it too so
  // it doesn't linger attached to the host layer forever.
  if (h->clipLayer) [h->clipLayer removeFromSuperlayer];
  if (h->command_queue_retained) CFBridgingRelease(h->command_queue_retained);
  if (h->device_retained) CFBridgingRelease(h->device_retained);
  delete h;
}

extern "C" __attribute__((visibility("default"))) void bunium_window_close(
    void* handle) {
  auto* h = static_cast<BuniumWindowHandle*>(handle);
  // Don't re-close a window the user already closed (windowWillClose: has
  // already fired by the time is_closed() is polled true) -- NSWindow
  // handles repeat -close gracefully, but skip the redundant call anyway.
  if (!h->closed_by_user.load()) {
    [h->window close];
  }
  if (h->delegate_retained) {
    CFBridgingRelease(h->delegate_retained);
  }
  if (h->command_queue_retained) {
    CFBridgingRelease(h->command_queue_retained);
  }
  if (h->device_retained) {
    CFBridgingRelease(h->device_retained);
  }
  delete h;
}
