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
//   - No DPI scaling yet (bunium_window_get_scale always returns 1.0) --
//     Xft.dpi/randr-based scale detection is real work, deferred until a
//     HiDPI Linux target is actually being validated against.
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
//   - No synthetic resize-edge/draggable-region hit-testing for frameless
//     windows yet (mirrors mac's BuniumContentView resize-bar code, not
//     ported) -- frame_enabled=false windows have no window-manager
//     decorations to fight for the resize border but the app draws its own
//     UI to indicate this rather than the OS.
//   - Frames stay top-left-origin BGRA, matching CEF's OSR output directly.
#include <X11/Xlib.h>
#include <X11/Xutil.h>
#include <X11/extensions/shape.h>

#define BUNIUM_LINUX_EXPORT __attribute__((visibility("default")))

#include <algorithm>
#include <cstdint>
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

struct BuniumLinuxHandle {
  Window window = 0;
  GC gc = nullptr;
  bool is_sublayer = false;
  bool closed = false;
  bool transparent = false;
  bool frame_enabled = true;

  double scale = 1.0;  // no HiDPI detection yet, see file header
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
  XMoveResizeWindow(d, h->window, screen_x + h->abs_x, screen_y + h->abs_y,
                     std::max(1, h->abs_w), std::max(1, h->abs_h));
  if (h->clipped) ApplyClipShape(h);
}

// Applies (or re-derives, after a move/resize) the sublayer's active clip
// as an X11 Shape region. clip_x/y/w/h are window-relative (same space as
// abs_x/y/w/h); the shape itself must be expressed in the sublayer's own
// client-relative coordinates, so this re-bases by abs_x/abs_y every call
// -- mirrors the win implementation's LogRectToPhysical + SetWindowRgn
// (rel = clip - abs_frame origin) exactly, just without the DPI scale
// step (Linux has none yet, see file header).
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
  XRectangle rect{static_cast<short>(rel_x), static_cast<short>(rel_y),
                   static_cast<unsigned short>(rel_w),
                   static_cast<unsigned short>(rel_h)};
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
  XImage* image = XCreateImage(
      d, DefaultVisual(d, screen), 24, ZPixmap, 0,
      reinterpret_cast<char*>(pixels.data()), pw, ph, 32, 0);
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

void ForwardMouse(BuniumLinuxHandle* h, int x, int y, int button,
                   bool is_move, bool mouse_up, bool leave,
                   int click_count) {
  void* target = h->is_sublayer
                     ? reinterpret_cast<void*>(h->parent_window)
                     : reinterpret_cast<void*>(h->window);
  int abs_x = x, abs_y = y;
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
  h->logical_w = width;
  h->logical_h = height;

  int screen = DefaultScreen(d);
  XSetWindowAttributes attrs = {};
  attrs.background_pixel = BlackPixel(d, screen);
  attrs.event_mask = ExposureMask | StructureNotifyMask | ButtonPressMask |
                      ButtonReleaseMask | PointerMotionMask | KeyPressMask |
                      KeyReleaseMask | LeaveWindowMask;

  Window window = XCreateWindow(
      d, RootWindow(d, screen), 0, 0, width, height, 0,
      DefaultDepth(d, screen), InputOutput, DefaultVisual(d, screen),
      CWBackPixel | CWEventMask, &attrs);
  if (!window) {
    DeleteHandle(h);
    return nullptr;
  }
  h->window = window;
  h->gc = XCreateGC(d, window, 0, nullptr);

  if (title && *title) XStoreName(d, window, title);
  if (!frame_enabled) {
    // Ask the window manager to skip decorations. Not all WMs honor
    // override_redirect gracefully for a resizable top-level window, but
    // it's the standard Xlib-only (no Motif/EWMH hints dependency) way to
    // request it.
    XSetWindowAttributes ov = {};
    ov.override_redirect = frame_enabled ? False : True;
    XChangeWindowAttributes(d, window, CWOverrideRedirect, &ov);
  }

  XSetWMProtocols(d, window, &g_wm_delete_window, 1);

  XSizeHints hints = {};
  hints.flags = PMinSize | PMaxSize;
  hints.min_width = hints.max_width = width;
  hints.min_height = hints.max_height = height;
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

  Display* d = GetDisplay();
  XSizeHints hints = {};
  if (resizable) {
    hints.flags = PMinSize | PMaxSize;
    hints.min_width = min_width > 0 ? min_width : 1;
    hints.min_height = min_height > 0 ? min_height : 1;
    hints.max_width = max_width > 0 ? max_width : 100000;
    hints.max_height = max_height > 0 ? max_height : 100000;
  } else {
    hints.flags = PMinSize | PMaxSize;
    hints.min_width = hints.max_width = h->logical_w;
    hints.min_height = hints.max_height = h->logical_h;
  }
  XSetWMNormalHints(d, h->window, &hints);
}

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
          h->logical_w = ev.xconfigure.width;
          h->logical_h = ev.xconfigure.height;
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

  int screen = DefaultScreen(d);
  XSetWindowAttributes attrs = {};
  attrs.background_pixel = BlackPixel(d, screen);
  attrs.override_redirect = True;
  attrs.event_mask = ExposureMask | ButtonPressMask | ButtonReleaseMask |
                      PointerMotionMask;
  Window window = XCreateWindow(
      d, RootWindow(d, screen), 0, 0, std::max(1, width), std::max(1, height),
      0, DefaultDepth(d, screen), InputOutput, DefaultVisual(d, screen),
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
