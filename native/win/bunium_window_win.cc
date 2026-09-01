// Native Win32 window + sublayer backing for a CEF OSR view. The Windows
// counterpart to native/mac/bunium_window_mac.mm, compiled into the same
// DLL as bunium_shim.cpp and implementing the exact same flat-C-ABI
// contract (see the extern "C" declarations in bunium_shim.cpp).
//
// Model notes (deltas vs. the macOS implementation, deliberately kept):
//   - macOS windows are point-sized NSWindows with a CAMetalLayer that
//     Chromium paints into at device-pixel scale. Windows windows are
//     created with a client area of logical_size * scale (scale = dpi/96),
//     and the CEF frame buffer (which is logical_size * scale, because
//     BuniumClient::GetScreenInfo reports device_scale_factor) is blitted
//     1:1 in WM_PAINT (opaque windows) or pushed per-pixel-alpha via
//     UpdateLayeredWindow (transparent windows, or every sublayer).
//   - Sub-, non transparent (WS_EX_LAYERED) windows cannot have visible
//     children, so <bunium-webview> sublayers are implemented as separate
//     top-level WS_POPUP | WS_EX_LAYERED | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW
//     windows that track the parent window's position (repositioned on
//     parent WM_MOVE/WM_SIZE). Hit-testing still runs entirely through
//     HitTestSublayer in bunium_shim.cpp with the parent's g_window_sublayers
//     registry, so input routing is identical to macOS.
//   - dom overflow:hidden ancestor clipping uses SetWindowRgn on a sublayer
//     (the Win32 analogue of the mac clipLayer + masksToBounds mechanism).
//   - Frames stay top-left-origin BGRA premultiplied (Chromium's OSR byte
//     order), matching both GDI BI_RGB (BGR) and UpdateLayeredWindow's
//     premultiplied BGRA-in-memory expectation.
//   - Windows v1 keeps the >8-argument bun:ffi avoidance rule intact; these
//   signatures mirror the shim's existing exports exactly (all <=8 args).
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX  // windows.h min/max macros would shadow std::min/::max
#include <windows.h>

#include <dwmapi.h>
#include <windowsx.h>  // GET_X_LPARAM/GET_Y_LPARAM

#include <algorithm>
#include <atomic>
#include <cstdint>
#include <cstring>
#include <mutex>
#include <string>
#include <vector>

#include "bunium_system_win.h"

// Implemented in bunium_shim.cpp, linked into the same DLL -- forwards raw
// Win32 mouse events to whichever CefBrowser/CEF view is attached to one of
// our window/sublayer handles. See bunium_shim.cpp for the hit-testing and
// focus-routing semantics.
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

// CEF event modifier bits (cef_event_flags_t), same encoding the mac
// implementation assembles from NSEvent.modifierFlags.
constexpr uint32_t kShiftDown = 1 << 1;
constexpr uint32_t kControlDown = 1 << 2;
constexpr uint32_t kAltDown = 1 << 3;

struct BuniumWinHandle {
  HWND hwnd = nullptr;
  bool is_sublayer = false;
  bool closed = false;
  bool transparent = false;
  bool frame_enabled = true;

  double scale = 1.0;
  int logical_w = 0;  // CSS px, what JS reports/creates with
  int logical_h = 0;
  int min_w = 0;
  int min_h = 0;
  int max_w = 0;
  int max_h = 0;
  bool resizable = true;

  // Last painted frame, logical_size * scale device pixels, premultiplied
  // BGRA. Guarded by frame_mtx.
  std::mutex frame_mtx;
  std::vector<uint8_t> pixels;
  int pix_w = 0;
  int pix_h = 0;

  // Sublayer state (only when is_sublayer). abs_frame is window-relative,
  // in logical (CSS) px, matching bunium_sublayer_get_frame's contract.
  HWND parent_hwnd = nullptr;
  RECT abs_frame{0, 0, 0, 0};
  bool clipped = false;
  RECT clip_rect{0, 0, 0, 0};  // window-relative logical px when clipped
  HRGN clip_rgn = nullptr;
};

std::vector<BuniumWinHandle*> g_all;  // lifetime registry; also sole owners

BuniumWinHandle* FindHandle(HWND hwnd) {
  for (auto* h : g_all) {
    if (h->hwnd == hwnd) return h;
  }
  return nullptr;
}

// Client-area physical px -> logical (CSS) px. Win32 mouse messages report
// physical pixels; CEF expects view-space logical coordinates matching
// GetViewRect (the same division the mac BuniumContentView does between
// NSEvent location (points) and the backing-scale raster).
POINT PhysToLogical(const BuniumWinHandle* h, POINT p) {
  if (h->scale == 1.0) return p;
  POINT out;
  out.x = static_cast<LONG>(p.x / h->scale);
  out.y = static_cast<LONG>(p.y / h->scale);
  return out;
}

// Window-relative logical coords -> physical px client rect (top-left origin).
RECT LogRectToPhysical(const BuniumWinHandle* h, const RECT& r) {
  RECT out;
  out.left = static_cast<LONG>(r.left * h->scale);
  out.top = static_cast<LONG>(r.top * h->scale);
  out.right = static_cast<LONG>(r.right * h->scale);
  out.bottom = static_cast<LONG>(r.bottom * h->scale);
  return out;
}

LONG ClampLogical(LONG v, int min_v, int max_v) {
  if (max_v > 0 && v > max_v) v = max_v;
  if (min_v > 0 && v < min_v) v = min_v;
  return v;
}

// -------- painting -------------------------------------------------------

// Blits the stored frame buffer into `hwnd`'s client area at 1:1
// (physical px buffer -> physical px client; values match because CEF
// rasterizes at device_scale_factor). Called from WM_PAINT (opaque path).
void PaintOpaqueFrame(HWND hwnd, BuniumWinHandle* h) {
  PAINTSTRUCT ps;
  HDC dc = BeginPaint(hwnd, &ps);
  if (!dc) return;
  RECT client;
  GetClientRect(hwnd, &client);

  std::vector<uint8_t> pixels;
  int pw = 0, ph = 0;
  {
    std::lock_guard<std::mutex> lock(h->frame_mtx);
    pixels = h->pixels;
    pw = h->pix_w;
    ph = h->pix_h;
  }

  if (pw > 0 && ph > 0) {
    BITMAPINFO bi = {};
    bi.bmiHeader.biSize = sizeof(bi.bmiHeader);
    bi.bmiHeader.biWidth = pw;
    bi.bmiHeader.biHeight = -ph;  // top-down, matches browser origin
    bi.bmiHeader.biPlanes = 1;
    bi.bmiHeader.biBitCount = 32;
    bi.bmiHeader.biCompression = BI_RGB;
    StretchDIBits(dc, 0, 0, client.right - client.left,
                  client.bottom - client.top, 0, 0, pw, ph, pixels.data(), &bi,
                  DIB_RGB_COLORS, SRCCOPY);
  } else {
    HBRUSH brush = static_cast<HBRUSH>(GetStockObject(
        h->transparent ? NULL_BRUSH : BLACK_BRUSH));
    FillRect(dc, &client, brush);
  }
  EndPaint(hwnd, &ps);
}

// Pushes a frame to a layered window with per-pixel alpha. Used for
// transparent main windows and for every sublayer (which are always
// layered). The sublayer case notably implies the CEF view attached to a
// sublayer can paint with real alpha and composite over the app window,
// matching the mac CAMetalLayer behavior.
void PushLayeredFrame(HWND hwnd, BuniumWinHandle* h,
                      const uint8_t* bgra, int pw, int ph) {
  RECT client;
  GetClientRect(hwnd, &client);
  const int cw = client.right - client.left;
  const int ch = client.bottom - client.top;
  if (cw <= 0 || ch <= 0) return;

  HDC screen_dc = GetDC(nullptr);
  HDC mem_dc = CreateCompatibleDC(screen_dc);

  // Neutralize the buffer's premultiplied alpha against a black backdrop by
  // asking GDI to copy it as-is (BGRA premultiplied is exactly what
  // UpdateLayeredWindow expects for ULW_ALPHA with a 32bpp DIB).
  BITMAPINFO bi = {};
  bi.bmiHeader.biSize = sizeof(bi.bmiHeader);
  bi.bmiHeader.biWidth = pw;
  bi.bmiHeader.biHeight = -ph;
  bi.bmiHeader.biPlanes = 1;
  bi.bmiHeader.biBitCount = 32;
  bi.bmiHeader.biCompression = BI_RGB;
  uint8_t* dib_bits = nullptr;
  HBITMAP dib = CreateDIBSection(mem_dc, &bi, DIB_RGB_COLORS,
                                 reinterpret_cast<void**>(&dib_bits), nullptr,
                                 0);
  if (dib) {
    std::memcpy(dib_bits, bgra, static_cast<size_t>(pw) * ph * 4);
    HGDIOBJ old = SelectObject(mem_dc, dib);
    // Stretch (not just blit) so a stale frame size still fills the client
    // area after a DPI/scale change before the next OnPaint arrives.
    StretchBlt(mem_dc, 0, 0, cw, ch, mem_dc, 0, 0, pw, ph, SRCCOPY);

    POINT src_origin{0, 0};
    SIZE dst{cw, ch};
    BLENDFUNCTION blend = {};
    blend.BlendOp = AC_SRC_OVER;
    blend.SourceConstantAlpha = 255;
    blend.AlphaFormat = AC_SRC_ALPHA;  // per-pixel premultiplied alpha
    UpdateLayeredWindow(hwnd, screen_dc, nullptr, &dst, mem_dc, &src_origin, 0,
                        &blend, ULW_ALPHA);

    SelectObject(mem_dc, old);
    DeleteObject(dib);
  }
  DeleteDC(mem_dc);
  ReleaseDC(nullptr, screen_dc);
}

// -------- sublayer positioning/tracking ----------------------------------

// Physical screen position of a sublayer from its window-relative logical
// abs_frame + the parent client origin. Returns false if no meaningful
// position (parent destroyed/hidden).
bool ComputeSublayerScreenRect(BuniumWinHandle* sub, RECT* out_phys) {
  if (!sub->parent_hwnd || !IsWindow(sub->parent_hwnd)) return false;
  POINT origin{0, 0};
  ClientToScreen(sub->parent_hwnd, &origin);
  RECT phys = LogRectToPhysical(sub, sub->abs_frame);
  out_phys->left = origin.x + phys.left;
  out_phys->top = origin.y + phys.top;
  out_phys->right = origin.x + phys.right;
  out_phys->bottom = origin.y + phys.bottom;
  return true;
}

void PositionSublayer(BuniumWinHandle* h, bool show) {
  if (!h->is_sublayer) return;
  RECT phys;
  if (!ComputeSublayerScreenRect(h, &phys)) return;
  SetWindowPos(h->hwnd, nullptr, phys.left, phys.top, phys.right - phys.left,
               phys.bottom - phys.top, SWP_NOZORDER | SWP_NOACTIVATE);
  if (show) ShowWindow(h->hwnd, SW_SHOWNOACTIVATE);
}

void RepositionAllSublayers(HWND parent) {
  for (auto* h : g_all) {
    if (h->is_sublayer && h->parent_hwnd == parent) PositionSublayer(h, true);
  }
}

// -------- input forwarding (mirrors BuniumContentView) -------------------

int LogicalClickCountFor(UINT msg) {
  switch (msg) {
    case WM_LBUTTONDBLCLK:
    case WM_MBUTTONDBLCLK:
    case WM_RBUTTONDBLCLK:
      return 2;
    default:
      return 1;
  }
}

int ButtonFor(UINT msg) {
  switch (msg) {
    case WM_MBUTTONDOWN:
    case WM_MBUTTONUP:
    case WM_MBUTTONDBLCLK:
      return 1;  // middle
    case WM_RBUTTONDOWN:
    case WM_RBUTTONUP:
    case WM_RBUTTONDBLCLK:
      return 2;  // right
    default:
      return 0;  // left
  }
}

// CefEventFlags assembly from the current keyboard state.
uint32_t ModifiersFromKeyboardState() {
  uint32_t mods = 0;
  if (GetKeyState(VK_SHIFT) & 0x8000) mods |= kShiftDown;
  if (GetKeyState(VK_CONTROL) & 0x8000) mods |= kControlDown;
  if (GetKeyState(VK_MENU) & 0x8000) mods |= kAltDown;
  return mods;
}

// Routes a mouse event to the shim exactly like the mac
// BuniumContentView::mouseDown/moved do: window-relative logical coords,
// and the *parent* window handle (the shim's HitTestSublayer resolves the
// actual target, sublayer or main view, from g_window_sublayers).
void ForwardMouse(HWND hwnd, BuniumWinHandle* h, int logical_x,
                  int logical_y, UINT msg) {
  void* parent = h->is_sublayer ? h->parent_hwnd : static_cast<void*>(hwnd);
  int abs_x = logical_x, abs_y = logical_y;
  if (h->is_sublayer) {
    abs_x += h->abs_frame.left;
    abs_y += h->abs_frame.top;
  }
  if (msg == WM_MOUSEMOVE || msg == WM_MOUSELEAVE) {
    bunium_dispatch_mouse_move(parent, abs_x, abs_y, msg == WM_MOUSELEAVE);
    return;
  }
  bool mouse_up = msg == WM_LBUTTONUP || msg == WM_MBUTTONUP ||
                  msg == WM_RBUTTONUP;
  bunium_dispatch_mouse_click(parent, abs_x, abs_y, ButtonFor(msg),
                              mouse_up ? 1 : 0, LogicalClickCountFor(msg));
}

// cef_key_event_type_t ordering matches WM_* directly:
// 0=RAWKEYDOWN, 1=KEYDOWN, 2=KEYUP, 3=CHAR.
int KeyEventTypeFor(UINT msg) {
  switch (msg) {
    case WM_KEYDOWN:
      return 1;
    case WM_KEYUP:
      return 2;
    case WM_CHAR:
      return 3;
    default:
      return 1;
  }
}

// Uses the Win32 virtual key code directly as windows_key_code (this is
// the Windows-native value, unlike the mac port which had to reuse
// NSEvent.keyCode), and WM_CHAR's wParam as the character. The shim routes
// the event to whichever view most recently received a mouse click, so
// this always forwards from the main window's hwnd (sublayers are
// WS_EX_NOACTIVATE and never see keyboard messages).
void ForwardKey(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
  uint16_t character = 0;
  if (msg == WM_CHAR) {
    character = static_cast<uint16_t>(wp);
  }
  int key_code = static_cast<int>(wp);
  if (msg == WM_CHAR) key_code = character;  // CHAR is ASCII; n/a for WPARAM VK
  bunium_dispatch_key_event(hwnd, KeyEventTypeFor(msg),
                            static_cast<int>(ModifiersFromKeyboardState()),
                            key_code, character);
}

// -------- window proc ----------------------------------------------------

LRESULT CALLBACK BuniumWindowProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
  BuniumWinHandle* h = FindHandle(hwnd);
  switch (msg) {
    case WM_NCCREATE: {
      // WM_NCCREATE arrives before the handle is registered -- find it via
      // the lpCreateParams back-pointer set at window creation.
      CREATESTRUCT* cs = reinterpret_cast<CREATESTRUCT*>(lp);
      auto* target = static_cast<BuniumWinHandle*>(cs->lpCreateParams);
      // Only the primary window registers itself here; sublayers register
      // before CreateWindowEx (see CreateSublayerHwnd).
      if (target && !target->hwnd) target->hwnd = hwnd;
      h = target;
      break;
    }

    case WM_ERASEBKGND:
      return 1;  // no erasing -- the frame (or ULW) covers everything

    case WM_PAINT:
      if (h) {
        if (h->transparent) {
          // Transparency uses UpdateLayeredWindow exclusively; a plain
          // BeginPaint would erase the layered surface.
          RECT r{};
          GetClientRect(hwnd, &r);
          ValidateRect(hwnd, &r);
        } else {
          PaintOpaqueFrame(hwnd, h);
        }
      }
      return 0;

    case WM_WINDOWPOSCHANGED: {
      // h is null during creation of sublayers (their lpCreateParams is
      // null and hwnd is registered only after CreateWindowExW returns).
      if (!h) break;
      RECT client;
      GetClientRect(hwnd, &client);
      h->scale = static_cast<double>(GetDpiForWindow(hwnd)) / 96.0;
      if (h->is_sublayer) break;  // logical size owned by abs_frame
      h->logical_w = static_cast<int>((client.right - client.left) / h->scale);
      h->logical_h = static_cast<int>((client.bottom - client.top) / h->scale);
      if (!h->is_sublayer) RepositionAllSublayers(hwnd);
      break;
    }

    case WM_GETMINMAXINFO: {
      if (!h || h->is_sublayer) break;
      MINMAXINFO* mmi = reinterpret_cast<MINMAXINFO*>(lp);
      // Constraints are logical px; convert to physical for the OS dialog.
      mmi->ptMinTrackSize.x = static_cast<LONG>(h->min_w * h->scale);
      mmi->ptMinTrackSize.y = static_cast<LONG>(h->min_h * h->scale);
      if (h->max_w > 0 || h->max_h > 0) {
        mmi->ptMaxTrackSize.x = h->max_w > 0 ? static_cast<LONG>(h->max_w * h->scale)
                                             : GetSystemMetrics(SM_CXMAXTRACK);
        mmi->ptMaxTrackSize.y = h->max_h > 0 ? static_cast<LONG>(h->max_h * h->scale)
                                             : GetSystemMetrics(SM_CYMAXTRACK);
      }
      return 0;
    }

    case WM_NCHITTEST: {
      // Frameless windows need manual resize edges + draggable regions
      // (mac's BuniumContentView resize-bar hit-testing equivalent). Framed
      // windows let the OS dialog handle it.
      if (!h || h->is_sublayer || h->frame_enabled) break;
      POINT pt{GET_X_LPARAM(lp), GET_Y_LPARAM(lp)};
      ScreenToClient(hwnd, &pt);
      const LONG cx = static_cast<LONG>(pt.x / h->scale);
      const LONG cy = static_cast<LONG>(pt.y / h->scale);
      constexpr LONG kEdge = 6;
      const LONG w = h->logical_w;
      const LONG hgt = h->logical_h;
      const bool can_resize = h->resizable &&
                              (h->max_w == 0 || h->max_w > h->min_w) &&
                              (h->max_h == 0 || h->max_h > h->min_h);
      if (can_resize) {
        if (cy <= kEdge && cx <= kEdge) return HTTOPLEFT;
        if (cy <= kEdge && cx >= w - kEdge) return HTTOPRIGHT;
        if (cy >= hgt - kEdge && cx <= kEdge) return HTBOTTOMLEFT;
        if (cy >= hgt - kEdge && cx >= w - kEdge) return HTBOTTOMRIGHT;
        if (cy <= kEdge) return HTTOP;
        if (cy >= hgt - kEdge) return HTBOTTOM;
        if (cx <= kEdge) return HTLEFT;
        if (cx >= w - kEdge) return HTRIGHT;
      }
      if (bunium_is_window_point_draggable(hwnd, cx, cy)) return HTCAPTION;
      return HTCLIENT;
    }

    case WM_CLOSE:
      // User closed the window (title-bar X or Alt+F4). Mark closed so the
      // JS pump's bunium_is_native_window_closed poll sees it; the view's
      // CEF browser is torn down by bunium_close_view once JS observes it.
      if (h) h->closed = true;
      DestroyWindow(hwnd);
      return 0;

    case WM_COMMAND:
      // Menu-item selection from the window's menu bar (bunium windows have
      // no child controls, so HIWORD(wParam)==0 always means a menu item).
      // Forward the app-assigned id to the system bus -- the Win32 analogue
      // of the mac NSMenuItem.tag dispatcher.
      if (HIWORD(wp) == 0) {
        BuniumSystemForwardMenuCommand(static_cast<int>(LOWORD(wp)));
        return 0;
      }
      break;

    case WM_DESTROY:
      if (h) h->closed = true;
      if (!h->is_sublayer) PostQuitMessage(0);
      return 0;

    case WM_MOVE:
    case WM_SIZE:
      if (h && !h->is_sublayer) RepositionAllSublayers(hwnd);
      break;

    // Input -----------------------------------------------------------------
    case WM_MOUSEMOVE: {
      if (!h) break;
      POINT pt{GET_X_LPARAM(lp), GET_Y_LPARAM(lp)};
      pt = PhysToLogical(h, pt);
      // Request WM_MOUSELEAVE so the page sees mouseleave (mac forwards
      // the same via mouse_leave on NSMouseExited).
      TRACKMOUSEEVENT tme = {};
      tme.cbSize = sizeof(tme);
      tme.dwFlags = TME_LEAVE;
      tme.hwndTrack = hwnd;
      TrackMouseEvent(&tme);
      ForwardMouse(hwnd, h, pt.x, pt.y, WM_MOUSEMOVE);
      return 0;
    }

    case WM_LBUTTONDOWN:
    case WM_LBUTTONUP:
    case WM_LBUTTONDBLCLK:
    case WM_MBUTTONDOWN:
    case WM_MBUTTONUP:
    case WM_MBUTTONDBLCLK:
    case WM_RBUTTONDOWN:
    case WM_RBUTTONUP:
    case WM_RBUTTONDBLCLK: {
      if (!h) break;
      POINT pt{GET_X_LPARAM(lp), GET_Y_LPARAM(lp)};
      pt = PhysToLogical(h, pt);
      ForwardMouse(hwnd, h, pt.x, pt.y, msg);
      return 0;
    }
    case WM_MOUSELEAVE:
      if (h) ForwardMouse(hwnd, h, 0, 0, msg);
      break;

    case WM_KEYDOWN:
    case WM_KEYUP:
    case WM_CHAR:
    case WM_SYSKEYDOWN:
    case WM_SYSKEYUP: {
      if (!h) break;
      ForwardKey(hwnd, msg, wp, lp);
      return 0;
    }

    default:
      break;
  }
  return DefWindowProcW(hwnd, msg, wp, lp);
}

// -------- registration ---------------------------------------------------

bool RegisterBuniumClass(const wchar_t* name) {
  WNDCLASSEXW wc = {};
  wc.cbSize = sizeof(wc);
  wc.lpfnWndProc = BuniumWindowProc;
  wc.hInstance = GetModuleHandleW(nullptr);
  wc.hCursor = LoadCursorW(nullptr, IDC_ARROW);
  wc.lpszClassName = name;
  return RegisterClassExW(&wc) != 0;
}

BuniumWinHandle* NewHandle(bool sublayer) {
  auto* h = new BuniumWinHandle();
  h->is_sublayer = sublayer;
  g_all.push_back(h);
  return h;
}

void DeleteHandle(BuniumWinHandle* h) {
  g_all.erase(std::remove(g_all.begin(), g_all.end(), h), g_all.end());
  if (h->clip_rgn) DeleteObject(h->clip_rgn);
  delete h;
}

}  // namespace

void BuniumForEachPrimaryWindow(void (*fn)(HWND, void*), void* ctx) {
  for (auto* h : g_all) {
    if (!h->is_sublayer && h->hwnd && IsWindow(h->hwnd)) fn(h->hwnd, ctx);
  }
}

namespace {

HWND CreateWindowHwnd(BuniumWinHandle* h, int phys_w, int phys_h,
                      DWORD style, DWORD ex_style) {
  // One class name per window keeps per-instance WndProc dispatch trivial;
  // sublayers reuse the same proc via FindHandle, so one class suffices.
  static const wchar_t* kClassName = L"BuniumOSRWindow";
  static bool registered = false;
  if (!registered) {
    registered = RegisterBuniumClass(kClassName);
  }
  HWND hwnd = CreateWindowExW(
      ex_style, kClassName, L"", style, CW_USEDEFAULT, CW_USEDEFAULT, phys_w,
      phys_h, nullptr, nullptr, GetModuleHandleW(nullptr), h);
  return hwnd;
}

// -------- exported ABI (flat C, no CEF types cross) ----------------------

}  // namespace

extern "C" {

// -------- windows (primary) ----------------------------------------------

__declspec(dllexport) void* bunium_window_create(int width, int height,
                                                 const char* title,
                                                 int transparent,
                                                 int frame_enabled) {
  // Per-monitor DPI v2: Chromium (via GetScreenInfo) gets the real scale.
  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  auto* h = NewHandle(/*sublayer=*/false);
  h->transparent = transparent != 0;
  h->frame_enabled = frame_enabled != 0;
  h->logical_w = width;
  h->logical_h = height;

  // Seed scale from the monitor that will host the default-created window.
  h->scale = static_cast<double>(GetDpiForSystem()) / 96.0;

  DWORD style = frame_enabled ? (WS_OVERLAPPEDWINDOW) : WS_POPUP;
  DWORD ex_style = transparent ? WS_EX_LAYERED : 0;
  HWND hwnd = CreateWindowHwnd(h, static_cast<int>(width * h->scale),
                               static_cast<int>(height * h->scale), style,
                               ex_style);
  if (!hwnd) {
    DeleteHandle(h);
    return nullptr;
  }
  h->hwnd = hwnd;
  if (h->scale == 0) h->scale = 1.0;

  SetWindowTextW(hwnd, [&] {
    if (!title || !*title) return std::wstring();
    int n = MultiByteToWideChar(CP_UTF8, 0, title, -1, nullptr, 0);
    std::wstring w(n, L'\0');
    MultiByteToWideChar(CP_UTF8, 0, title, -1, &w[0], n);
    return w;
  }().c_str());

  // Frameless windows have no caption; WS_POPUP + HTCAPTION drag works.
  // A shadow helps distinguish the window from its background (the mac
  // implementation disables shadows only for transparent windows).
  if (frame_enabled) {
    MARGINS margins{1, 1, 1, 1};
    DwmExtendFrameIntoClientArea(hwnd, &margins);
  }

  ShowWindow(hwnd, SW_SHOW);
  UpdateWindow(hwnd);
  // Attach the application menu bar (if one was registered) -- framed
  // windows show it; WS_POPUP frameless windows ignore SetMenu silently.
  BuniumApplyAppMenu(hwnd);
  return h;
}

__declspec(dllexport) void bunium_window_set_constraints(
    void* handle, int resizable, int min_width, int min_height, int max_width,
    int max_height) {
  auto* h = static_cast<BuniumWinHandle*>(handle);
  h->resizable = resizable != 0;
  h->min_w = min_width;
  h->min_h = min_height;
  h->max_w = max_width;
  h->max_h = max_height;
  LONG_PTR style = GetWindowLongPtrW(h->hwnd, GWL_STYLE);
  if (resizable && h->frame_enabled) {
    style |= WS_THICKFRAME;
  } else if (!resizable || !h->frame_enabled) {
    style &= ~WS_THICKFRAME;
  }
  SetWindowLongPtrW(h->hwnd, GWL_STYLE, style);
  SetWindowPos(h->hwnd, nullptr, 0, 0, 0, 0,
               SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_FRAMECHANGED |
                   SWP_NOACTIVATE);
}

// No macOS-style traffic-light buttons on Windows (the standard caption
// buttons are drawn by the OS and aren't individually repositionable the
// same way) -- honest no-ops kept so the shared bun:ffi symbol table (same
// declared symbols across all three platforms) still resolves here. See the
// real mac implementation in bunium_window_mac.mm.
__declspec(dllexport) void bunium_window_set_titlebar_style(void* /*handle*/,
                                                             int /*style*/) {}
__declspec(dllexport) void bunium_window_set_traffic_light_position(
    void* /*handle*/, int /*x*/, int /*y*/) {}

// Pump one batch of messages (mirrors the mac nextEventMatchingMask loop).
// Non-blocking: returns immediately once the queue is drained, so the JS
// rAF-style pump stays the single clock.
__declspec(dllexport) void bunium_window_pump_events() {
  MSG msg;
  while (PeekMessageW(&msg, nullptr, 0, 0, PM_REMOVE)) {
    TranslateMessage(&msg);
    DispatchMessageW(&msg);
  }
}

__declspec(dllexport) int bunium_window_get_id(void* handle) {
  auto* h = static_cast<BuniumWinHandle*>(handle);
  return static_cast<int>(reinterpret_cast<intptr_t>(h->hwnd));
}

__declspec(dllexport) void bunium_window_get_size(void* handle,
                                                  int* out_width,
                                                  int* out_height) {
  auto* h = static_cast<BuniumWinHandle*>(handle);
  *out_width = h->logical_w;
  *out_height = h->logical_h;
}

__declspec(dllexport) int bunium_window_is_closed(void* handle) {
  auto* h = static_cast<BuniumWinHandle*>(handle);
  return h->closed ? 1 : 0;
}

__declspec(dllexport) void bunium_window_close(void* handle) {
  auto* h = static_cast<BuniumWinHandle*>(handle);
  if (h->closed) return;
  h->closed = true;
  DestroyWindow(h->hwnd);
}

__declspec(dllexport) double bunium_window_get_scale(void* handle) {
  auto* h = static_cast<BuniumWinHandle*>(handle);
  if (GetDpiForWindow) {
    double dpi = static_cast<double>(GetDpiForWindow(h->hwnd));
    if (dpi > 0) h->scale = dpi / 96.0;
  }
  return h->scale;
}

__declspec(dllexport) int bunium_window_is_resizable(void* handle) {
  auto* h = static_cast<BuniumWinHandle*>(handle);
  return h->resizable ? 1 : 0;
}

__declspec(dllexport) void bunium_window_get_size_constraints(
    void* handle, int* out_min_width, int* out_min_height, int* out_max_width,
    int* out_max_height) {
  auto* h = static_cast<BuniumWinHandle*>(handle);
  *out_min_width = h->min_w;
  *out_min_height = h->min_h;
  *out_max_width = h->max_w;
  *out_max_height = h->max_h;
}

// -------- frame upload (paint target for a window OR a sublayer) --------

__declspec(dllexport) void bunium_window_update_frame(void* handle,
                                                      const uint8_t* bgra,
                                                      int width, int height) {
  auto* h = static_cast<BuniumWinHandle*>(handle);
  {
    std::lock_guard<std::mutex> lock(h->frame_mtx);
    h->pixels.assign(bgra, bgra + static_cast<size_t>(width) * height * 4);
    h->pix_w = width;
    h->pix_h = height;
  }
  if (h->transparent || h->is_sublayer) {
    PushLayeredFrame(h->hwnd, h, bgra, width, height);
  } else {
    InvalidateRect(h->hwnd, nullptr, FALSE);
  }
}

// -------- sublayers (<bunium-webview> backing) ---------------------------

__declspec(dllexport) void* bunium_create_sublayer(void* window_handle, int x,
                                                   int y, int width,
                                                   int height) {
  auto* parent = static_cast<BuniumWinHandle*>(window_handle);
  auto* h = NewHandle(/*sublayer=*/true);
  h->parent_hwnd = parent->hwnd;
  h->scale = parent->scale;
  h->abs_frame = {x, y, x + width, y + height};
  h->transparent = true;  // always composited (alpha over the app window)

  DWORD ex = WS_EX_LAYERED | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW;
  DWORD style = WS_POPUP;
  RECT phys;
  if (!ComputeSublayerScreenRect(h, &phys)) {
    DeleteHandle(h);
    return nullptr;
  }
  HWND hwnd = CreateWindowExW(ex, L"BuniumOSRWindow", L"", style, phys.left,
                              phys.top, phys.right - phys.left,
                              phys.bottom - phys.top, nullptr, nullptr,
                              GetModuleHandleW(nullptr), nullptr);
  if (!hwnd) {
    DeleteHandle(h);
    return nullptr;
  }
  h->hwnd = hwnd;
  PositionSublayer(h, true);
  return h;
}

__declspec(dllexport) void bunium_sublayer_set_frame(void* layer_handle, int x,
                                                     int y, int width,
                                                     int height) {
  auto* h = static_cast<BuniumWinHandle*>(layer_handle);
  h->abs_frame = {x, y, x + width, y + height};
  PositionSublayer(h, true);
}

__declspec(dllexport) void bunium_sublayer_get_frame(void* layer_handle,
                                                     int* out_x, int* out_y,
                                                     int* out_width,
                                                     int* out_height) {
  auto* h = static_cast<BuniumWinHandle*>(layer_handle);
  *out_x = h->abs_frame.left;
  *out_y = h->abs_frame.top;
  *out_width = h->abs_frame.right - h->abs_frame.left;
  *out_height = h->abs_frame.bottom - h->abs_frame.top;
}

// DOM overflow:hidden ancestor clipping. Win32 has no clipping layers, so
// the equivalent is a window region: paints outside the clip get discarded
// by the compositor without touching the rasterized content (same
// semantics as the mac clipLayer + masksToBounds). The clip rect is
// window-relative logical px (same space as set_frame).
__declspec(dllexport) void bunium_sublayer_set_clip(void* layer_handle,
                                                    int clip_x, int clip_y,
                                                    int clip_w, int clip_h) {
  auto* h = static_cast<BuniumWinHandle*>(layer_handle);
  // The region lives in the sublayer's own client space, so first express
  // the window-relative rect in sublayer-relative coordinates.
  RECT rel;
  rel.left = clip_x - h->abs_frame.left;
  rel.top = clip_y - h->abs_frame.top;
  rel.right = rel.left + clip_w;
  rel.bottom = rel.top + clip_h;
  RECT phys = LogRectToPhysical(h, rel);
  if (phys.right < phys.left) phys.right = phys.left;
  if (phys.bottom < phys.top) phys.bottom = phys.top;
  if (h->clip_rgn) DeleteObject(h->clip_rgn);
  h->clip_rgn = CreateRectRgn(phys.left, phys.top, phys.right, phys.bottom);
  SetWindowRgn(h->hwnd, h->clip_rgn, TRUE);
  h->clipped = true;
  h->clip_rect = {clip_x, clip_y, clip_x + clip_w, clip_y + clip_h};
}

__declspec(dllexport) void bunium_sublayer_clear_clip(void* layer_handle) {
  auto* h = static_cast<BuniumWinHandle*>(layer_handle);
  if (!h->clipped) return;
  SetWindowRgn(h->hwnd, nullptr, TRUE);
  if (h->clip_rgn) DeleteObject(h->clip_rgn);
  h->clip_rgn = nullptr;
  h->clipped = false;
}

// Verification-only readback; mirrors mac semantics: 0/1 in *out_clipped,
// and when clipped, the on-screen visible rect (abs frame intersected with
// the clip rect) in window-relative logical px.
__declspec(dllexport) void bunium_sublayer_get_clip(void* layer_handle,
                                                    int* out_clipped,
                                                    int* out_x, int* out_y,
                                                    int* out_width,
                                                    int* out_height) {
  auto* h = static_cast<BuniumWinHandle*>(layer_handle);
  if (!h->clipped) {
    *out_clipped = 0;
    *out_x = *out_y = *out_width = *out_height = 0;
    return;
  }
  RECT vis = h->abs_frame;
  vis.left = std::max(vis.left, h->clip_rect.left);
  vis.top = std::max(vis.top, h->clip_rect.top);
  vis.right = std::min(vis.right, h->clip_rect.right);
  vis.bottom = std::min(vis.bottom, h->clip_rect.bottom);
  *out_clipped = 1;
  *out_x = vis.left;
  *out_y = vis.top;
  *out_width = std::max(0L, vis.right - vis.left);
  *out_height = std::max(0L, vis.bottom - vis.top);
}

// Raises the sublayer to the top of the *sibling* order (via HWND_TOP, the
// Win32 z-order equivalent of CALayer append-on-top). Sublayers are
// popups; the shim's HitTestSublayer consults its own registry order, and
// JS keeps the two in sync via bunium_raise_native_sublayer (which also
// updates that registry).
__declspec(dllexport) void bunium_sublayer_raise_to_top(void* layer_handle) {
  auto* h = static_cast<BuniumWinHandle*>(layer_handle);
  if (!h->is_sublayer) return;
  SetWindowPos(h->hwnd, HWND_TOP, 0, 0, 0, 0,
               SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
}

__declspec(dllexport) void bunium_close_sublayer(void* layer_handle) {
  auto* h = static_cast<BuniumWinHandle*>(layer_handle);
  if (!h->is_sublayer) return;
  if (h->hwnd && IsWindow(h->hwnd)) DestroyWindow(h->hwnd);
  // Guard: WM_DESTROY also fires through the shared proc; the handle
  // registry already routed to us, so drop it here.
  h->closed = true;
  DeleteHandle(h);
}

// -------- teardown -------------------------------------------------------

__declspec(dllexport) void bunium_window_teardown_all() {
  // Iterate a copy: DeleteHandle erases from g_all. WM_DESTROY (fired
  // synchronously by DestroyWindow) only flips closed, it never touches
  // g_all, so destroying through the copy is safe. Sublayers were created
  // after their parent and appear later in g_all, which also keeps them
  // alive until the parent is gone.
  std::vector<BuniumWinHandle*> all = g_all;
  for (auto* h : all) {
    h->closed = true;
    if (h->hwnd && IsWindow(h->hwnd)) DestroyWindow(h->hwnd);
    DeleteHandle(h);
  }
}

}  // extern "C"