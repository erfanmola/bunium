// Native X11 window + sublayer backing for a CEF OSR view. The Linux
// counterpart to native/mac/bunium_window_mac.mm and
// native/win/bunium_window_win.cc, compiled into the same shared object as
// bunium_shim.cpp and implementing the exact same flat-C-ABI contract (see
// the extern "C" declarations in bunium_shim.cpp).
//
// Scope (Phase 6 v1, matches PLAN.md's "repeat Phase 0-1 validation steps
// for this platform" -- not full mac/win feature parity yet):
//   - Real Xlib top-level window, opaque only. CEF's OSR buffer (top-left
//     origin BGRA, 8-8-8-8) is blitted 1:1 via XPutImage on every
//     bunium_window_update_frame call -- no XShm, no compositor-dependent
//     ARGB visual/transparency. Software rasterization only (matches the
//     project's own measured GPU-composited-OSR-is-slower finding, see
//     ARCHITECTURE.md Sec6).
//   - DPI scaling: `Xft.dpi` (the X resource desktop environments write to
//     communicate the user's configured DPI -- same source GTK/Qt/Xft-aware
//     toolkits read) drives scale = dpi/96, with an explicit `GDK_SCALE`
//     integer env override taking priority when set (matches GTK's own
//     override convention). No per-monitor detection (X11/Xinerama has no
//     single-window "which monitor is this on" primitive the way Win32's
//     per-monitor-DPI-v2 or macOS's NSScreen does) -- one scale for the
//     whole X11 display, applied at window-creation time and left fixed for
//     that window's lifetime (matches this port's overall no-live-monitor-
//     hotplug-tracking scope).
//   - Sublayers (<bunium-webview> backing) are real override-redirect
//     windows that track their parent's position, mirroring the Windows
//     WS_POPUP approach. Clipping (DOM overflow:hidden ancestor clipping)
//     uses the X11 Shape extension (XShapeCombineRectangles), the X11
//     analogue of Win32's SetWindowRgn -- same semantics as mac's
//     clipLayer/masksToBounds and Windows' clip_rgn: the sublayer's CEF
//     content is never re-rasterized or resized, only its on-screen visible
//     region changes. Sublayers still paint opaque, not alpha-composited
//     (needs a running compositor + 32-bit ARGB visual, unlike a plain
//     Xvfb/no-WM dev environment) -- tracked as a Phase 2-parity follow-up.
//   - Resize-edge + draggable-region hit-testing for frameless windows uses
//     the EWMH `_NET_WM_MOVERESIZE` client-message convention (the same
//     mechanism GTK/Qt's own client-side-decoration windows use to hand a
//     border-drag or titlebar-drag off to the window manager) rather than
//     manually tracking the drag ourselves via XMoveResizeWindow -- almost
//     every WM (mutter, kwin, xfwm, i3, etc.) implements this, and letting
//     the WM own the drag loop gets snapping/multi-monitor/edge-resistance
//     behavior for free, matching what mac's performWindowDragWithEvent:
//     already delegates to AppKit. See ResizeDirectionAtPoint/
//     SendNetWmMoveResize below; hit-tested and dispatched from ButtonPress
//     in bunium_window_pump_events, mirroring win32's WM_NCHITTEST gate
//     (only frame_enabled=false, non-sublayer, resizable-aware).
//   - Frames stay top-left-origin BGRA, matching CEF's OSR output directly.
#include <X11/Xlib.h>
#include <X11/Xresource.h>
#include <X11/Xutil.h>
#include <X11/extensions/shape.h>

#define BUNIUM_LINUX_EXPORT __attribute__((visibility("default")))

#include <algorithm>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <mutex>
#include <vector>

// Implemented in bunium_shim.cpp, linked into the same .so -- forwards raw
// X11 input events to whichever CefBrowser/CEF view is attached to one of
// our window/sublayer handles.
extern "C" void bunium_dispatch_mouse_click(void* window_handle, int x, int y,
                                             int button, int mouse_up,
                                             int click_count);
extern "C" void bunium_dispatch_mouse_move(void* window_handle, int x, int y,
                                            int mouse_leave);
extern "C" int bunium_is_window_point_draggable(void* window_handle, int x,
                                                 int y);
extern "C" void bunium_dispatch_key_event(void* window_handle, int event_type,
                                           int modifiers, int key_code,
                                           uint16_t character);

namespace {

// CEF event modifier bits (cef_event_flags_t), same encoding the mac/win
// implementations assemble.
constexpr uint32_t kShiftDown = 1 << 1;
constexpr uint32_t kControlDown = 1 << 2;
constexpr uint32_t kAltDown = 1 << 3;

Display* g_display = nullptr;
Atom g_wm_delete_window;

Display* GetDisplay() {
  if (!g_display) {
    g_display = XOpenDisplay(nullptr);
    if (g_display) {
      g_wm_delete_window = XInternAtom(g_display, "WM_DELETE_WINDOW", False);
    }
  }
  return g_display;
}

// Detects the display's DPI scale. See file header for the Xft.dpi/
// GDK_SCALE precedence rationale. 96 DPI is the X11 baseline (scale 1.0),
// matching the win32 96-DPI baseline exactly, so the same downstream
// physical/logical conversion math the Windows port already established
// (LogRectToPhysical/PhysToLogical there) applies unchanged here.
double DetectX11Scale(Display* d) {
  if (const char* gdk_scale = getenv("GDK_SCALE")) {
    int s = atoi(gdk_scale);
    if (s >= 1 && s <= 4) return static_cast<double>(s);
  }
  double scale = 1.0;
  char* rms = XResourceManagerString(d);
  if (rms) {
    XrmDatabase db = XrmGetStringDatabase(rms);
    if (db) {
      char* type = nullptr;
      XrmValue value;
      if (XrmGetResource(db, "Xft.dpi", "Xft.Dpi", &type, &value) &&
          value.addr) {
        double dpi = atof(value.addr);
        if (dpi > 0) scale = dpi / 96.0;
      }
      XrmDestroyDatabase(db);
    }
  }
  // Clamp to a sane range -- a malformed/missing resource (no session bus,
  // headless Xvfb, etc.) should degrade to scale 1.0, not a degenerate
  // window.
  if (scale < 0.5 || scale > 4.0) scale = 1.0;
  return scale;
}

int RoundScale(double v) { return static_cast<int>(v + 0.5); }

// Finds a 32-bit TrueColor visual with an 8-bit alpha channel (depth=32,
// the standard "ARGB visual" every compositor-aware toolkit -- GTK's
// gdk_screen_get_rgba_visual, Qt's QX11Info, etc. -- looks up the same way)
// on the given screen, if one exists. A running compositing manager
// (picom, mutter, kwin's own compositor, etc.) is what actually turns
// per-pixel alpha in such a visual into real screen blending; without one,
// creating a window with this visual still works (X11 doesn't require a
// compositor to create ARGB windows) but the alpha channel has no visible
// effect -- the WM/X server just shows garbage or ignores it, which is
// exactly the documented v1 gap ("needs a running compositor").
Visual* FindArgbVisual(Display* d, int screen, int* depth_out) {
  XVisualInfo template_info;
  template_info.screen = screen;
  template_info.depth = 32;
  template_info.c_class = TrueColor;
  int count = 0;
  XVisualInfo* infos =
      XGetVisualInfo(d, VisualScreenMask | VisualDepthMask | VisualClassMask,
                      &template_info, &count);
  if (!infos || count == 0) {
    if (infos) XFree(infos);
    return nullptr;
  }
  // Prefer one with a non-zero alpha mask (some 32-depth TrueColor visuals
  // are padding-only, alpha_mask==0 -- not what we want).
  Visual* result = nullptr;
  for (int i = 0; i < count; i++) {
    unsigned long rgb_mask = infos[i].red_mask | infos[i].green_mask |
                              infos[i].blue_mask;
    unsigned long alpha_mask = (~rgb_mask) & 0xFFFFFFFFUL;
    if (alpha_mask != 0) {
      result = infos[i].visual;
      break;
    }
  }
  if (!result) result = infos[0].visual;
  if (depth_out) *depth_out = 32;
  XFree(infos);
  return result;
}

struct BuniumLinuxHandle {
  Window window = 0;
  GC gc = nullptr;
  bool is_sublayer = false;
  bool closed = false;
  bool transparent = false;
  bool frame_enabled = true;

  // 24 (opaque, DefaultVisual) unless transparent=true and a 32-bit ARGB
  // TrueColor visual was found at creation time (see bunium_window_create),
  // in which case this is 32 and `visual` points at that visual -- BlitFrame
  // must build its XImage with these, not DefaultDepth/DefaultVisual,
  // otherwise the alpha byte CEF wrote gets silently discarded by the X
  // server (a 24-bit visual has no alpha channel at all, regardless of what
  // bytes are in the client-side buffer).
  int depth = 24;
  Visual* visual = nullptr;  // null => caller should use DefaultVisual

  double scale = 1.0;  // Xft.dpi/GDK_SCALE-derived, see DetectX11Scale above
  int logical_w = 0;
  int logical_h = 0;
  int min_w = 0;
  int min_h = 0;
  int max_w = 0;
  int max_h = 0;
  bool resizable = true;

  std::mutex frame_mtx;
  std::vector<uint8_t> pixels;  // BGRA, reused as XImage backing storage
  int pix_w = 0;
  int pix_h = 0;

  // Window-relative logical (CSS) px, matching bunium_sublayer_set_frame's
  // cross-platform contract -- converted to physical px (via scale) only at
  // the point of an actual X11 geometry call, mirroring the win
  // implementation's LogRectToPhysical pattern.
  Window parent_window = 0;
  int abs_x = 0, abs_y = 0, abs_w = 0, abs_h = 0;

  // Clip state (sublayer only). clip_rect is window-relative logical px,
  // same space as abs_x/y/w/h -- matches bunium_sublayer_set_frame's
  // contract on every other platform.
  bool clipped = false;
  int clip_x = 0, clip_y = 0, clip_w = 0, clip_h = 0;
};

std::vector<BuniumLinuxHandle*> g_all;

BuniumLinuxHandle* FindHandle(Window w) {
  for (auto* h : g_all) {
    if (h->window == w) return h;
  }
  return nullptr;
}

BuniumLinuxHandle* NewHandle(bool sublayer) {
  auto* h = new BuniumLinuxHandle();
  h->is_sublayer = sublayer;
  g_all.push_back(h);
  return h;
}

void DeleteHandle(BuniumLinuxHandle* h) {
  g_all.erase(std::remove(g_all.begin(), g_all.end(), h), g_all.end());
  delete h;
}

void ApplyClipShape(BuniumLinuxHandle* h);

void RepositionSublayer(BuniumLinuxHandle* h) {
  if (!h->is_sublayer) return;
  Display* d = GetDisplay();
  Window root_ret;
  int parent_x = 0, parent_y = 0;
  unsigned int w_ret, h_ret, bw_ret, depth_ret;
  XGetGeometry(d, h->parent_window, &root_ret, &parent_x, &parent_y, &w_ret,
               &h_ret, &bw_ret, &depth_ret);
  // XGetGeometry's x/y are relative to the parent's own parent, not the
  // screen -- translate to root (screen) coordinates like the win/mac
  // implementations' ClientToScreen/window-space math.
  int screen_x = 0, screen_y = 0;
  Window child_ret;
  XTranslateCoordinates(d, h->parent_window, DefaultRootWindow(d), 0, 0,
                         &screen_x, &screen_y, &child_ret);
  // abs_x/y/w/h are logical (CSS) px -- convert to physical px for the
  // actual X11 geometry call (X11 windows are always sized in physical/
  // device px, same as every other platform's native window).
  const double s = h->scale;
  int phys_x = static_cast<int>(h->abs_x * s);
  int phys_y = static_cast<int>(h->abs_y * s);
  int phys_w = static_cast<int>(h->abs_w * s);
  int phys_h = static_cast<int>(h->abs_h * s);
  XMoveResizeWindow(d, h->window, screen_x + phys_x, screen_y + phys_y,
                     std::max(1, phys_w), std::max(1, phys_h));
  if (h->clipped) ApplyClipShape(h);
}

// Applies (or re-derives, after a move/resize) the sublayer's active clip
// as an X11 Shape region. clip_x/y/w/h are window-relative (same space as
// abs_x/y/w/h); the shape itself must be expressed in the sublayer's own
// client-relative coordinates, so this re-bases by abs_x/abs_y every call
// -- mirrors the win implementation's LogRectToPhysical + SetWindowRgn
// (rel = clip - abs_frame origin) exactly, including the DPI scale step.
void ApplyClipShape(BuniumLinuxHandle* h) {
  if (!h->is_sublayer || !h->clipped) return;
  Display* d = GetDisplay();
  int rel_x = h->clip_x - h->abs_x;
  int rel_y = h->clip_y - h->abs_y;
  int rel_w = h->clip_w;
  int rel_h = h->clip_h;
  // Clamp to non-negative -- a clip rect that ends up entirely outside the
  // sublayer's own bounds should hide it completely (0x0 region), not wrap
  // negative into a huge unsigned width/height.
  if (rel_x < 0) {
    rel_w += rel_x;
    rel_x = 0;
  }
  if (rel_y < 0) {
    rel_h += rel_y;
    rel_y = 0;
  }
  rel_w = std::max(0, rel_w);
  rel_h = std::max(0, rel_h);
  // rel_x/y/w/h are logical px (same space as clip_x/y/w/h); the Shape
  // region itself is expressed in the sublayer's own physical px, same
  // conversion RepositionSublayer applies to abs_x/y/w/h.
  const double s = h->scale;
  XRectangle rect{static_cast<short>(rel_x * s), static_cast<short>(rel_y * s),
                   static_cast<unsigned short>(rel_w * s),
                   static_cast<unsigned short>(rel_h * s)};
  XShapeCombineRectangles(d, h->window, ShapeBounding, 0, 0, &rect, 1,
                           ShapeSet, 0);
}

void ClearClipShape(BuniumLinuxHandle* h) {
  if (!h->is_sublayer) return;
  Display* d = GetDisplay();
  XShapeCombineMask(d, h->window, ShapeBounding, 0, 0, None, ShapeSet);
}

void RepositionAllSublayers(Window parent) {
  for (auto* h : g_all) {
    if (h->is_sublayer && h->parent_window == parent) RepositionSublayer(h);
  }
}

// -------- painting --------------------------------------------------------

void BlitFrame(BuniumLinuxHandle* h) {
  Display* d = GetDisplay();
  std::vector<uint8_t> pixels;
  int pw = 0, ph = 0;
  {
    std::lock_guard<std::mutex> lock(h->frame_mtx);
    if (h->pixels.empty()) return;
    pixels = h->pixels;
    pw = h->pix_w;
    ph = h->pix_h;
  }

  int screen = DefaultScreen(d);
  // Use the window's own visual/depth, not DefaultVisual/24 -- a
  // transparent=true window created with a 32-bit ARGB visual (see
  // bunium_window_create) needs its XImage built at depth 32 too, or the
  // X server reinterprets CEF's BGRA bytes as a 24-bit image (silently
  // dropping the alpha byte) regardless of what visual the window itself
  // was created with.
  Visual* visual = h->visual ? h->visual : DefaultVisual(d, screen);
  int depth = h->visual ? h->depth : 24;
  XImage* image = XCreateImage(d, visual, depth, ZPixmap, 0,
                                reinterpret_cast<char*>(pixels.data()), pw, ph,
                                32, 0);
  if (!image) return;
  // Ownership of `pixels`' storage stays with the local vector -- detach
  // before XDestroyImage tries to free() it (XCreateImage over an existing
  // buffer doesn't take ownership by convention here since we pass our own
  // pointer, but XDestroyImage always frees image->data unconditionally).
  XPutImage(d, h->window, h->gc, image, 0, 0, 0, 0, pw, ph);
  image->data = nullptr;
  XDestroyImage(image);
  XFlush(d);
}

// -------- input forwarding (mirrors ForwardMouse/ForwardKey on win) ------

uint32_t ModifiersFromXState(unsigned int state) {
  uint32_t mods = 0;
  if (state & ShiftMask) mods |= kShiftDown;
  if (state & ControlMask) mods |= kControlDown;
  if (state & Mod1Mask) mods |= kAltDown;
  return mods;
}

// EWMH _NET_WM_MOVERESIZE direction values (wm-spec.freedesktop.org) --
// the 8 resize edges/corners plus a dedicated "move" value.
enum {
  kNetWmMoveResizeSizeTopLeft = 0,
  kNetWmMoveResizeSizeTop = 1,
  kNetWmMoveResizeSizeTopRight = 2,
  kNetWmMoveResizeSizeRight = 3,
  kNetWmMoveResizeSizeBottomRight = 4,
  kNetWmMoveResizeSizeBottom = 5,
  kNetWmMoveResizeSizeBottomLeft = 6,
  kNetWmMoveResizeSizeLeft = 7,
  kNetWmMoveResizeMove = 8,
};

// Border thickness for synthetic resize-edge hit-testing, in logical
// (CSS) px -- same 6px value mac's kBuniumResizeBorder and win's kEdge use.
constexpr int kResizeBorder = 6;

// Asks the window manager to take over an interactive move or resize,
// starting from the given root(screen)-relative point. Once sent, the WM
// owns the drag loop entirely -- no further ButtonPress/MotionNotify/
// ButtonRelease events arrive for this window until the drag ends, same
// hand-off semantics as win32 returning a non-HTCLIENT code from
// WM_NCHITTEST (the OS takes over from there too).
void SendNetWmMoveResize(Display* d, Window w, int root_x, int root_y,
                          int direction, int button) {
  Atom atom = XInternAtom(d, "_NET_WM_MOVERESIZE", False);
  XClientMessageEvent msg = {};
  msg.type = ClientMessage;
  msg.window = w;
  msg.message_type = atom;
  msg.format = 32;
  msg.data.l[0] = root_x;
  msg.data.l[1] = root_y;
  msg.data.l[2] = direction;
  msg.data.l[3] = button;
  msg.data.l[4] = 1;  // source indication: 1 = normal application
  // Per the EWMH spec, the client should release any of its own pointer
  // grab before handing off -- we never take one explicitly, but this is
  // cheap insurance against a WM that expects it unconditionally.
  XUngrabPointer(d, CurrentTime);
  XSendEvent(d, DefaultRootWindow(d), False,
             SubstructureRedirectMask | SubstructureNotifyMask,
             reinterpret_cast<XEvent*>(&msg));
  XFlush(d);
}

// Mirrors mac's ResizeEdgeAtPoint / win's WM_NCHITTEST edge math: lx/ly are
// window-relative logical px. Returns a kNetWmMoveResizeSize* direction, or
// -1 if the point isn't within the resize border (or the window can't
// resize at all -- unresizable, or min==max on either axis).
int ResizeDirectionAtPoint(BuniumLinuxHandle* h, int lx, int ly) {
  if (!h->resizable) return -1;
  bool can_resize = (h->max_w == 0 || h->max_w > h->min_w) &&
                     (h->max_h == 0 || h->max_h > h->min_h);
  if (!can_resize) return -1;
  const int w = h->logical_w;
  const int hgt = h->logical_h;
  bool left = lx <= kResizeBorder;
  bool right = lx >= w - kResizeBorder;
  bool top = ly <= kResizeBorder;
  bool bottom = ly >= hgt - kResizeBorder;
  if (top && left) return kNetWmMoveResizeSizeTopLeft;
  if (top && right) return kNetWmMoveResizeSizeTopRight;
  if (bottom && left) return kNetWmMoveResizeSizeBottomLeft;
  if (bottom && right) return kNetWmMoveResizeSizeBottomRight;
  if (top) return kNetWmMoveResizeSizeTop;
  if (bottom) return kNetWmMoveResizeSizeBottom;
  if (left) return kNetWmMoveResizeSizeLeft;
  if (right) return kNetWmMoveResizeSizeRight;
  return -1;
}

void ForwardMouse(BuniumLinuxHandle* h, int x, int y, int button,
                   bool is_move, bool mouse_up, bool leave,
                   int click_count) {
  void* target = h->is_sublayer
                     ? reinterpret_cast<void*>(h->parent_window)
                     : reinterpret_cast<void*>(h->window);
  // X11 event coords are physical px (window-relative) -- convert to
  // logical (CSS) px before forwarding, matching the win implementation's
  // PhysToLogical step between WM_* messages and CEF's view-space coords.
  const double s = h->scale;
  int abs_x = s != 1.0 ? static_cast<int>(x / s) : x;
  int abs_y = s != 1.0 ? static_cast<int>(y / s) : y;
  if (h->is_sublayer) {
    abs_x += h->abs_x;
    abs_y += h->abs_y;
  }
  if (is_move) {
    bunium_dispatch_mouse_move(target, abs_x, abs_y, leave ? 1 : 0);
    return;
  }
  bunium_dispatch_mouse_click(target, abs_x, abs_y, button, mouse_up ? 1 : 0,
                               click_count);
}

}  // namespace

// -------- exported ABI (flat C, no CEF types cross) -----------------------

extern "C" {

BUNIUM_LINUX_EXPORT void* bunium_window_create(int width, int height,
                                                const char* title,
                                                int transparent,
                                                int frame_enabled) {
  Display* d = GetDisplay();
  if (!d) return nullptr;

  auto* h = NewHandle(/*sublayer=*/false);
  h->transparent = transparent != 0;
  h->frame_enabled = frame_enabled != 0;
  h->scale = DetectX11Scale(d);
  h->logical_w = width;
  h->logical_h = height;

  // width/height are logical (CSS) px -- X11 windows are always sized in
  // physical px (same as win32's CreateWindowHwnd(width*scale, ...)), so
  // convert here, once, at creation.
  int phys_w = static_cast<int>(width * h->scale);
  int phys_h = static_cast<int>(height * h->scale);

  int screen = DefaultScreen(d);
  Visual* visual = DefaultVisual(d, screen);
  int depth = DefaultDepth(d, screen);
  unsigned long attr_mask = CWEventMask;
  XSetWindowAttributes attrs = {};
  attrs.event_mask = ExposureMask | StructureNotifyMask | ButtonPressMask |
                      ButtonReleaseMask | PointerMotionMask | KeyPressMask |
                      KeyReleaseMask | LeaveWindowMask;

  if (h->transparent) {
    int argb_depth = 24;
    Visual* argb_visual = FindArgbVisual(d, screen, &argb_depth);
    if (argb_visual) {
      visual = argb_visual;
      depth = argb_depth;
      // A non-default-depth window requires an explicit colormap for that
      // visual (XCreateWindow fails with BadMatch otherwise) and border
      // pixel 0 in place of BlackPixel (which is only valid for the
      // default visual/depth). CWBackPixel is deliberately dropped for
      // this path -- a solid background_pixel would paint every frame's
      // "before CEF's first paint" gap opaque black instead of leaving it
      // transparent, undermining the whole point of the ARGB visual.
      attrs.colormap = XCreateColormap(d, RootWindow(d, screen), visual,
                                         AllocNone);
      attrs.border_pixel = 0;
      attr_mask |= CWColormap | CWBorderPixel;
    }
    // No ARGB visual available (e.g. no compositor/no 32-bit visual
    // advertised by the X server) -- fall through and create a normal
    // opaque window rather than fail outright; matches this file's
    // existing pattern of degrading gracefully (see DetectX11Scale's
    // fallback-to-1.0 comment) instead of hard-failing on an
    // environment-dependent capability.
  }
  if (!h->transparent || visual == DefaultVisual(d, screen)) {
    attrs.background_pixel = BlackPixel(d, screen);
    attr_mask |= CWBackPixel;
  }
  h->depth = depth;
  h->visual = visual;

  Window window =
      XCreateWindow(d, RootWindow(d, screen), 0, 0, phys_w, phys_h, 0, depth,
                     InputOutput, visual, attr_mask, &attrs);
  if (!window) {
    DeleteHandle(h);
    return nullptr;
  }
  h->window = window;
  h->gc = XCreateGC(d, window, 0, nullptr);

  if (title && *title) XStoreName(d, window, title);
  if (!frame_enabled) {
    // Ask the window manager to skip decorations via _MOTIF_WM_HINTS --
    // the same mechanism GTK/Qt's own client-side-decoration windows use.
    // This was previously done via override_redirect=True, which is wrong:
    // override-redirect windows opt OUT of window-manager management
    // entirely, so a real WM (confirmed with openbox) silently ignores
    // this window's _NET_WM_MOVERESIZE ClientMessages (SendNetWmMoveResize
    // below) -- the synthetic-XTest-only test (test-resize-moveresize.cc)
    // could not catch this because it only checks that bunium SENDS the
    // message, not that anything WM-side consumes it. Keeping the window
    // WM-managed (override_redirect stays False, the XCreateWindow
    // default) while hiding decorations via Motif hints lets the WM still
    // own the resize/drag protocol as designed, matching this file's own
    // header-comment intent above.
    struct MotifWmHints {
      unsigned long flags;
      unsigned long functions;
      unsigned long decorations;
      long input_mode;
      unsigned long status;
    };
    Atom motif_hints_atom = XInternAtom(d, "_MOTIF_WM_HINTS", False);
    MotifWmHints hints = {};
    hints.flags = 1L << 1;  // MWM_HINTS_DECORATIONS
    hints.decorations = 0;  // no border/titlebar
    XChangeProperty(d, window, motif_hints_atom, motif_hints_atom, 32,
                     PropModeReplace, reinterpret_cast<unsigned char*>(&hints),
                     5);
  }

  XSetWMProtocols(d, window, &g_wm_delete_window, 1);

  XSizeHints hints = {};
  hints.flags = PMinSize | PMaxSize;
  hints.min_width = hints.max_width = phys_w;
  hints.min_height = hints.max_height = phys_h;
  XSetWMNormalHints(d, window, &hints);

  XMapWindow(d, window);
  XFlush(d);
  return h;
}

BUNIUM_LINUX_EXPORT void bunium_window_set_constraints(void* handle,
                                                        int resizable,
                                                        int min_width,
                                                        int min_height,
                                                        int max_width,
                                                        int max_height) {
  auto* h = static_cast<BuniumLinuxHandle*>(handle);
  h->resizable = resizable != 0;
  h->min_w = min_width;
  h->min_h = min_height;
  h->max_w = max_width;
  h->max_h = max_height;

  // min/max_width/height are logical px (cross-platform contract) --
  // convert to physical px for the WM size-hint call, same as
  // bunium_window_create.
  const double s = h->scale;
  Display* d = GetDisplay();
  XSizeHints hints = {};
  if (resizable) {
    hints.flags = PMinSize | PMaxSize;
    hints.min_width = min_width > 0 ? static_cast<int>(min_width * s) : 1;
    hints.min_height = min_height > 0 ? static_cast<int>(min_height * s) : 1;
    hints.max_width = max_width > 0 ? static_cast<int>(max_width * s) : 100000;
    hints.max_height =
        max_height > 0 ? static_cast<int>(max_height * s) : 100000;
  } else {
    hints.flags = PMinSize | PMaxSize;
    hints.min_width = hints.max_width = static_cast<int>(h->logical_w * s);
    hints.min_height = hints.max_height = static_cast<int>(h->logical_h * s);
  }
  XSetWMNormalHints(d, h->window, &hints);
}

// No native traffic-light/title-bar-style concept on Linux (X11 window
// decorations, if any, are drawn by the window manager, not the app) --
// honest no-ops kept so the shared bun:ffi symbol table (same declared
// symbols across all three platforms) still resolves here. See the real
// mac implementation in bunium_window_mac.mm.
BUNIUM_LINUX_EXPORT void bunium_window_set_titlebar_style(void* /*handle*/,
                                                           int /*style*/) {}
BUNIUM_LINUX_EXPORT void bunium_window_set_traffic_light_position(
    void* /*handle*/, int /*x*/, int /*y*/) {}

BUNIUM_LINUX_EXPORT void bunium_window_pump_events() {
  Display* d = GetDisplay();
  if (!d) return;
  while (XPending(d) > 0) {
    XEvent ev;
    XNextEvent(d, &ev);
    BuniumLinuxHandle* h = FindHandle(ev.xany.window);
    if (!h) continue;

    switch (ev.type) {
      case Expose:
        BlitFrame(h);
        break;
      case ConfigureNotify:
        if (!h->is_sublayer) {
          // ConfigureNotify reports physical px -- convert back to logical
          // (CSS) px, matching win32's WM_WINDOWPOSCHANGED handling.
          const double s = h->scale;
          h->logical_w = s != 1.0
                             ? static_cast<int>(ev.xconfigure.width / s)
                             : ev.xconfigure.width;
          h->logical_h = s != 1.0
                             ? static_cast<int>(ev.xconfigure.height / s)
                             : ev.xconfigure.height;
          RepositionAllSublayers(h->window);
        }
        break;
      case ClientMessage:
        if (static_cast<Atom>(ev.xclient.data.l[0]) == g_wm_delete_window) {
          h->closed = true;
        }
        break;
      case ButtonPress:
      case ButtonRelease: {
        // Resize-edge / draggable-region hand-off, frameless windows only
        // (WM-decorated windows already get both for free from the WM's
        // own titlebar/border chrome) -- checked on left-button press only,
        // same priority order as mac's mouseDown: (resize edge wins over a
        // draggable region underneath it).
        if (ev.type == ButtonPress && !h->is_sublayer && !h->frame_enabled &&
            ev.xbutton.button == 1) {
          const double s = h->scale;
          int lx = s != 1.0 ? static_cast<int>(ev.xbutton.x / s) : ev.xbutton.x;
          int ly = s != 1.0 ? static_cast<int>(ev.xbutton.y / s) : ev.xbutton.y;
          int dir = ResizeDirectionAtPoint(h, lx, ly);
          if (dir < 0 &&
              bunium_is_window_point_draggable(
                  reinterpret_cast<void*>(h->window), lx, ly)) {
            dir = kNetWmMoveResizeMove;
          }
          if (dir >= 0) {
            SendNetWmMoveResize(d, h->window, ev.xbutton.x_root,
                                 ev.xbutton.y_root, dir, /*button=*/1);
            break;
          }
        }
        int button = ev.xbutton.button == 2 ? 1
                     : ev.xbutton.button == 3 ? 2
                                               : 0;
        ForwardMouse(h, ev.xbutton.x, ev.xbutton.y, button, /*is_move=*/false,
                     ev.type == ButtonRelease, /*leave=*/false,
                     /*click_count=*/1);
        break;
      }
      case MotionNotify:
        ForwardMouse(h, ev.xmotion.x, ev.xmotion.y, 0, /*is_move=*/true,
                     false, /*leave=*/false, 0);
        break;
      case LeaveNotify:
        ForwardMouse(h, ev.xcrossing.x, ev.xcrossing.y, 0, /*is_move=*/true,
                     false, /*leave=*/true, 0);
        break;
      case KeyPress:
      case KeyRelease: {
        char buf[8] = {};
        KeySym keysym;
        XLookupString(&ev.xkey, buf, sizeof(buf), &keysym, nullptr);
        int event_type = ev.type == KeyPress ? 1 : 2;  // KEYDOWN / KEYUP
        bunium_dispatch_key_event(
            reinterpret_cast<void*>(h->window), event_type,
            static_cast<int>(ModifiersFromXState(ev.xkey.state)),
            static_cast<int>(keysym), 0);
        if (ev.type == KeyPress && buf[0] != 0) {
          bunium_dispatch_key_event(
              reinterpret_cast<void*>(h->window), /*CHAR=*/3,
              static_cast<int>(ModifiersFromXState(ev.xkey.state)),
              static_cast<int>(keysym), static_cast<uint16_t>(buf[0]));
        }
        break;
      }
      default:
        break;
    }
  }
}

BUNIUM_LINUX_EXPORT int bunium_window_get_id(void* handle) {
  auto* h = static_cast<BuniumLinuxHandle*>(handle);
  return static_cast<int>(h->window);
}

BUNIUM_LINUX_EXPORT void bunium_window_get_size(void* handle, int* out_width,
                                                 int* out_height) {
  auto* h = static_cast<BuniumLinuxHandle*>(handle);
  *out_width = h->logical_w;
  *out_height = h->logical_h;
}

BUNIUM_LINUX_EXPORT int bunium_window_is_closed(void* handle) {
  auto* h = static_cast<BuniumLinuxHandle*>(handle);
  return h->closed ? 1 : 0;
}

BUNIUM_LINUX_EXPORT void bunium_window_close(void* handle) {
  auto* h = static_cast<BuniumLinuxHandle*>(handle);
  if (h->closed) return;
  h->closed = true;
  Display* d = GetDisplay();
  if (h->gc) XFreeGC(d, h->gc);
  XDestroyWindow(d, h->window);
  XFlush(d);
}

BUNIUM_LINUX_EXPORT double bunium_window_get_scale(void* handle) {
  auto* h = static_cast<BuniumLinuxHandle*>(handle);
  return h->scale;
}

BUNIUM_LINUX_EXPORT int bunium_window_is_resizable(void* handle) {
  auto* h = static_cast<BuniumLinuxHandle*>(handle);
  return h->resizable ? 1 : 0;
}

BUNIUM_LINUX_EXPORT void bunium_window_get_size_constraints(
    void* handle, int* out_min_width, int* out_min_height,
    int* out_max_width, int* out_max_height) {
  auto* h = static_cast<BuniumLinuxHandle*>(handle);
  *out_min_width = h->min_w;
  *out_min_height = h->min_h;
  *out_max_width = h->max_w;
  *out_max_height = h->max_h;
}

// -------- frame upload (paint target for a window OR a sublayer) ---------

BUNIUM_LINUX_EXPORT void bunium_window_update_frame(void* handle,
                                                     const uint8_t* bgra,
                                                     int width, int height) {
  auto* h = static_cast<BuniumLinuxHandle*>(handle);
  {
    std::lock_guard<std::mutex> lock(h->frame_mtx);
    h->pixels.assign(bgra, bgra + static_cast<size_t>(width) * height * 4);
    h->pix_w = width;
    h->pix_h = height;
  }
  BlitFrame(h);
}

// -------- sublayers (<bunium-webview> backing) ----------------------------
//
// Real windows that track the parent's position (see file header for the
// clipping/alpha-compositing gaps still open).

BUNIUM_LINUX_EXPORT void* bunium_create_sublayer(void* window_handle, int x,
                                                  int y, int width,
                                                  int height) {
  Display* d = GetDisplay();
  auto* parent = static_cast<BuniumLinuxHandle*>(window_handle);
  auto* h = NewHandle(/*sublayer=*/true);
  h->parent_window = parent->window;
  h->scale = parent->scale;
  h->abs_x = x;
  h->abs_y = y;
  h->abs_w = width;
  h->abs_h = height;

  // width/height (like x/y above) are logical px -- RepositionSublayer
  // (called below) immediately resizes to physical px, so the initial size
  // here just needs to be non-zero, not exactly right.
  int phys_w = std::max(1, static_cast<int>(width * h->scale));
  int phys_h = std::max(1, static_cast<int>(height * h->scale));

  int screen = DefaultScreen(d);
  XSetWindowAttributes attrs = {};
  attrs.background_pixel = BlackPixel(d, screen);
  attrs.override_redirect = True;
  attrs.event_mask = ExposureMask | ButtonPressMask | ButtonReleaseMask |
                      PointerMotionMask;
  Window window = XCreateWindow(
      d, RootWindow(d, screen), 0, 0, phys_w, phys_h, 0,
      DefaultDepth(d, screen), InputOutput, DefaultVisual(d, screen),
      CWBackPixel | CWOverrideRedirect | CWEventMask, &attrs);
  if (!window) {
    DeleteHandle(h);
    return nullptr;
  }
  h->window = window;
  h->gc = XCreateGC(d, window, 0, nullptr);
  RepositionSublayer(h);
  XMapWindow(d, window);
  XFlush(d);
  return h;
}

BUNIUM_LINUX_EXPORT void bunium_sublayer_set_frame(void* layer_handle, int x,
                                                    int y, int width,
                                                    int height) {
  auto* h = static_cast<BuniumLinuxHandle*>(layer_handle);
  h->abs_x = x;
  h->abs_y = y;
  h->abs_w = width;
  h->abs_h = height;
  RepositionSublayer(h);
}

BUNIUM_LINUX_EXPORT void bunium_sublayer_get_frame(void* layer_handle,
                                                    int* out_x, int* out_y,
                                                    int* out_width,
                                                    int* out_height) {
  auto* h = static_cast<BuniumLinuxHandle*>(layer_handle);
  *out_x = h->abs_x;
  *out_y = h->abs_y;
  *out_width = h->abs_w;
  *out_height = h->abs_h;
}

// Clips a sublayer to clip_x/y/w/h (window-relative, same space as
// bunium_sublayer_set_frame) via the X11 Shape extension -- see
// ApplyClipShape above for the coordinate re-basing.
BUNIUM_LINUX_EXPORT void bunium_sublayer_set_clip(void* layer_handle,
                                                   int clip_x, int clip_y,
                                                   int clip_w, int clip_h) {
  auto* h = static_cast<BuniumLinuxHandle*>(layer_handle);
  h->clipped = true;
  h->clip_x = clip_x;
  h->clip_y = clip_y;
  h->clip_w = clip_w;
  h->clip_h = clip_h;
  ApplyClipShape(h);
}

BUNIUM_LINUX_EXPORT void bunium_sublayer_clear_clip(void* layer_handle) {
  auto* h = static_cast<BuniumLinuxHandle*>(layer_handle);
  if (!h->clipped) return;
  h->clipped = false;
  ClearClipShape(h);
}

// Verification-only readback, same semantics as mac/win: 0/1 in
// *out_clipped, and when clipped, the on-screen visible rect (abs frame
// intersected with the clip rect) in window-relative logical px -- not
// the raw clip rect itself.
BUNIUM_LINUX_EXPORT void bunium_sublayer_get_clip(void* layer_handle,
                                                   int* out_clipped, int* out_x,
                                                   int* out_y, int* out_width,
                                                   int* out_height) {
  auto* h = static_cast<BuniumLinuxHandle*>(layer_handle);
  if (!h->clipped) {
    *out_clipped = 0;
    *out_x = *out_y = *out_width = *out_height = 0;
    return;
  }
  int left = std::max(h->abs_x, h->clip_x);
  int top = std::max(h->abs_y, h->clip_y);
  int right = std::min(h->abs_x + h->abs_w, h->clip_x + h->clip_w);
  int bottom = std::min(h->abs_y + h->abs_h, h->clip_y + h->clip_h);
  *out_clipped = 1;
  *out_x = left;
  *out_y = top;
  *out_width = std::max(0, right - left);
  *out_height = std::max(0, bottom - top);
}

BUNIUM_LINUX_EXPORT void bunium_sublayer_raise_to_top(void* layer_handle) {
  auto* h = static_cast<BuniumLinuxHandle*>(layer_handle);
  if (!h->is_sublayer) return;
  Display* d = GetDisplay();
  XRaiseWindow(d, h->window);
}

BUNIUM_LINUX_EXPORT void bunium_close_sublayer(void* layer_handle) {
  auto* h = static_cast<BuniumLinuxHandle*>(layer_handle);
  if (!h->is_sublayer) return;
  Display* d = GetDisplay();
  if (h->gc) XFreeGC(d, h->gc);
  XDestroyWindow(d, h->window);
  XFlush(d);
  DeleteHandle(h);
}

}  // extern "C"
