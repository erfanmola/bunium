// Windows system surface for bunium -- Phase 7 (real implementations).
//
// The macOS implementation (bunium_system_mac.mm / notify / dialogs) is
// NSMenu/NSStatusItem/UNUserNotificationCenter/NSOpenPanel-based; the Win32
// equivalents here are:
//   - App menu bar: HMENU menus applied via SetMenu to every framed primary
//     window (Windows has one menu bar per window, not per app -- unlike the
//     mac single NSApp.mainMenu). The menu is *spec-driven* (item/submenu/
//     separator tree stored per MenuHandle), so each window gets its own
//     rebuilt HMENU -- SetMenu transfers ownership to the window and the
//     system destroys it with the window, so a shared HMENU across windows
//     would be freed under the surviving windows' feet.
//   - Tray: NOTIFYICONDATA with a hidden message-only window (NOTIFYICON_
//     VERSION_4). A status menu is shown via TrackPopupMenu on click; menu-
//     less trays can opt into bunium-tray-click via bunium_system_tray_set_click.
//   - Notifications: classic shell balloons (NIF_INFO) from a dedicated
//     hidden tray icon. Balloons are the shell's dev-friendly path with no
//     packaged AUMID/manifest requirements -- the Win32 analogue of the mac
//     legacy NSUserNotification fallback for unbundled dev binaries. Real
//     toast notifications (Windows.UI.Notifications) need an AppUserModelID
//     + shortcut registration and are a packaged-app (Phase 8) follow-up.
//   - Dialogs: IFileOpenDialog / IFileSaveDialog / TaskDialogIndirect run on
//     a detached worker thread (never blocks the JS pump -- same contract as
//     the mac completion handlers); results land on the shared event bus as
//     bunium-dialog-result {"requestId":N,...}.
//
// All events ride the shared inbox drained by JS via bunium_poll_system_event
// ({"name":...,"payload":"..."}, payload itself JSON) -- see
// src/system/events.ts.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>

// objidl.h (IStream) must precede gdiplus.h, which references it.
#include <objidl.h>
#include <gdiplus.h>
#include <objbase.h>
#include <shellapi.h>
#include <shlobj.h>

#include <cstdint>
#include <cstdio>
#include <cstring>
#include <cwchar>
#include <cwctype>
#include <deque>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "bunium_system_win.h"

#pragma comment(lib, "shell32.lib")
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "oleaut32.lib")
#pragma comment(lib, "uuid.lib")
#pragma comment(lib, "gdiplus.lib")

namespace {

std::mutex g_inbox_mtx;
std::deque<std::string> g_inbox;
std::string g_export;

// Escapes `in` as the *contents* of a JSON string literal: quote/backslash/
// control chars get the usual escapes; everything else (including UTF-8
// bytes) passes through. Payloads carry Unicode file paths, so this must
// stay ASCII-safe by construction.
std::string JsonEscape(const std::string& in) {
  std::string out;
  out.reserve(in.size() + 8);
  for (unsigned char c : in) {
    switch (c) {
      case '"': out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\b': out += "\\b"; break;
      case '\f': out += "\\f"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      default:
        if (c < 0x20) {
          char buf[8];
          std::snprintf(buf, sizeof(buf), "\\u%04x", c);
          out += buf;
        } else {
          out += static_cast<char>(c);
        }
    }
  }
  return out;
}

void PushSystemEvent(const char* name, const std::string& payload_json) {
  std::string env = "{\"name\":\"" + std::string(name) +
                    "\",\"payload\":\"" + JsonEscape(payload_json) + "\"}";
  std::lock_guard<std::mutex> lock(g_inbox_mtx);
  g_inbox.push_back(std::move(env));
}

// UTF-8 -> UTF-16 (empty on failure; callers treat it as a blank string).
std::wstring Utf8ToWide(const char* s) {
  if (!s || !*s) return std::wstring();
  int n = MultiByteToWideChar(CP_UTF8, 0, s, -1, nullptr, 0);
  if (n <= 0) return std::wstring();
  std::wstring w(n, L'\0');
  MultiByteToWideChar(CP_UTF8, 0, s, -1, &w[0], n);
  w.pop_back();  // strip the null terminator MultiByteToWideChar appended
  return w;
}

// ---------------------------------------------------------------------------
// Menu (spec-driven; see file header for why HMENUs are rebuilt per window)
// ---------------------------------------------------------------------------

struct MenuItemSpec {
  enum Kind { kSeparator, kItem, kSubmenu } kind = kSeparator;
  std::wstring label;
  int id = 0;
  std::vector<MenuItemSpec> children;
};

struct MenuHandle {
  // Root handle owns `owned`; a submenu handle aliases a kSubmenu element's
  // `children` inside its parent handle (`owner->owned[index].children`).
  // Index (not pointer) indirection survives parent vector reallocation.
  std::vector<MenuItemSpec> owned;
  MenuHandle* owner = nullptr;
  size_t index = 0;

  MenuHandle() = default;
  MenuHandle(MenuHandle* o, size_t i) : owner(o), index(i) {}

  std::vector<MenuItemSpec>& items() {
    return owner ? owner->owned[index].children : owned;
  }
};

// WM_COMMAND only carries 16 bits of id; ids at/above 0x10000 would collide.
constexpr int kMaxMenuId = 0xFFFF;

static HMENU BuildMenu(const std::vector<MenuItemSpec>& items) {
  HMENU menu = CreatePopupMenu();
  for (const auto& spec : items) {
    switch (spec.kind) {
      case MenuItemSpec::kSeparator:
        AppendMenuW(menu, MF_SEPARATOR, 0, nullptr);
        break;
      case MenuItemSpec::kItem:
        if (spec.id < 0 || spec.id > kMaxMenuId) {
          fprintf(stderr,
                  "[bunium] menu: item id %d exceeds the 0..%d range Win32 "
                  "WM_COMMAND supports\n",
                  spec.id, kMaxMenuId);
        }
        AppendMenuW(menu, MF_STRING, static_cast<UINT_PTR>(spec.id & kMaxMenuId),
                    spec.label.c_str());
        break;
      case MenuItemSpec::kSubmenu: {
        HMENU sub = BuildMenu(spec.children);
        AppendMenuW(menu, MF_POPUP | MF_STRING, reinterpret_cast<UINT_PTR>(sub),
                    spec.label.c_str());
        break;
      }
    }
  }
  return menu;
}

// The application menu, when one was registered. Raw owning pointer: menus
// outlive the app (JS never frees them), so leak-on-purpose is fine.
MenuHandle* g_app_menu = nullptr;

}  // namespace

void BuniumSystemForwardMenuCommand(int id) {
  char buf[32];
  std::snprintf(buf, sizeof(buf), "{\"id\":%d}", id);
  PushSystemEvent("bunium-menu-click", buf);
}

void BuniumApplyAppMenu(HWND hwnd) {
  MenuHandle* menu = g_app_menu;
  if (!menu) return;
  HMENU rebuilt = BuildMenu(menu->items());
  SetMenu(hwnd, rebuilt);  // window takes ownership; destroyed with it
}

// -------- menu exports -----------------------------------------------------

extern "C" {

__declspec(dllexport) void* bunium_system_menu_create() {
  return new MenuHandle();
}

__declspec(dllexport) void* bunium_system_menu_add_item(void* menu,
                                                        const char* title,
                                                        int id) {
  auto* m = static_cast<MenuHandle*>(menu);
  MenuItemSpec spec;
  spec.kind = MenuItemSpec::kItem;
  spec.label = Utf8ToWide(title);
  spec.id = id;
  m->items().push_back(std::move(spec));
  // Informational, like the mac side: JS ignores the return for items.
  return reinterpret_cast<void*>(uintptr_t(1));
}

__declspec(dllexport) void* bunium_system_menu_add_submenu(void* menu,
                                                           const char* title) {
  auto* m = static_cast<MenuHandle*>(menu);
  MenuItemSpec spec;
  spec.kind = MenuItemSpec::kSubmenu;
  spec.label = Utf8ToWide(title);
  m->items().push_back(std::move(spec));
  // JS builds into the returned handle (#addInto); alias the new kSubmenu
  // element's children so additions land in the parent's tree.
  return new MenuHandle(m, m->items().size() - 1);
}

__declspec(dllexport) void bunium_system_menu_add_separator(void* menu) {
  auto* m = static_cast<MenuHandle*>(menu);
  MenuItemSpec spec;
  spec.kind = MenuItemSpec::kSeparator;
  m->items().push_back(std::move(spec));
}

__declspec(dllexport) void bunium_system_set_application_menu(void* menu) {
  g_app_menu = static_cast<MenuHandle*>(menu);
  // Apply to every already-open window; windows created later pick it up in
  // bunium_window_create via BuniumApplyAppMenu.
  BuniumForEachPrimaryWindow(
      [](HWND hwnd, void*) { BuniumApplyAppMenu(hwnd); }, nullptr);
}

}  // extern "C"

// -------- tray (NOTIFYICONDATA) -------------------------------------------

namespace {

constexpr UINT kTrayCallbackMsg = WM_APP + 1;
constexpr UINT_PTR kNotifyIconUid = 0;  // reserved for notification balloons

struct TrayHandle {
  intptr_t id;
  HWND msg_hwnd = nullptr;
  UINT_PTR uid = 0;
  HICON icon = nullptr;
  bool click_enabled = false;
  bool has_menu = false;
  HMENU menu_cache = nullptr;
  std::wstring title;
};

// Only one message window is ever created; tray icons + the notification
// icon all report into it, distinguished by uID.
HWND g_msg_hwnd = nullptr;
// uid -> TrayHandle (user trays get uids 1..; the notify icon is uid 0 and
// is NOT in this map).
std::vector<TrayHandle*> g_trays;
intptr_t g_tray_seq = 1;

struct NotifyState {
  bool added = false;
  int pending_id = 0;
};
NotifyState g_notify;

TrayHandle* FindTrayByUid(UINT_PTR uid) {
  for (auto* t : g_trays) {
    if (t->uid == uid) return t;
  }
  return nullptr;
}

UINT_PTR NextTrayUid() {
  static UINT_PTR next = 1;
  return next++;
}

LRESULT CALLBACK TrayWindowProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp);

HWND EnsureTrayMessageWindow() {
  if (g_msg_hwnd) return g_msg_hwnd;
  static const wchar_t* kClass = L"BuniumTrayWindow";
  WNDCLASSEXW wc = {};
  wc.cbSize = sizeof(wc);
  wc.lpfnWndProc = TrayWindowProc;
  wc.hInstance = GetModuleHandleW(nullptr);
  wc.lpszClassName = kClass;
  RegisterClassExW(&wc);
  g_msg_hwnd = CreateWindowExW(0, kClass, L"", 0, 0, 0, 0, 0, HWND_MESSAGE,
                               nullptr, wc.hInstance, nullptr);
  return g_msg_hwnd;
}

// TPM_RETURNCMD hands the chosen item's id back to us directly, so no
// foreground/owner-window juggling is needed for a tray popup menu.
void ShowTrayMenu(TrayHandle* tray) {
  if (!tray->has_menu || !tray->menu_cache) return;
  POINT pt;
  GetCursorPos(&pt);
  UINT_PTR cmd = TrackPopupMenu(
      tray->menu_cache, TPM_LEFTALIGN | TPM_TOPALIGN | TPM_LEFTBUTTON |
                            TPM_RETURNCMD,
      pt.x, pt.y, 0, tray->msg_hwnd, nullptr);
  if (cmd) BuniumSystemForwardMenuCommand(static_cast<int>(cmd));
}

void AddTrayIcon(TrayHandle* tray) {
  HWND hwnd = EnsureTrayMessageWindow();
  if (!hwnd) return;
  tray->msg_hwnd = hwnd;
  NOTIFYICONDATAW nid = {};
  nid.cbSize = sizeof(nid);
  nid.hWnd = hwnd;
  nid.uID = static_cast<UINT>(tray->uid);
  nid.uFlags = NIF_MESSAGE;
  nid.uCallbackMessage = kTrayCallbackMsg;
  if (tray->icon) {
    nid.uFlags |= NIF_ICON;
    nid.hIcon = tray->icon;
  }
  if (!tray->title.empty()) {
    nid.uFlags |= NIF_TIP;
    wcsncpy_s(nid.szTip, tray->title.c_str(), _TRUNCATE);
  }
  Shell_NotifyIconW(NIM_ADD, &nid);
  // Granular NIN_SELECT/WM_CONTEXTMENU delivery instead of raw button msgs.
  nid.uVersion = NOTIFYICON_VERSION_4;
  Shell_NotifyIconW(NIM_SETVERSION, &nid);
}

void UpdateTrayIcon(TrayHandle* tray, bool icon_changed) {
  HWND hwnd = EnsureTrayMessageWindow();
  if (!hwnd) return;
  NOTIFYICONDATAW nid = {};
  nid.cbSize = sizeof(nid);
  nid.hWnd = hwnd;
  nid.uID = static_cast<UINT>(tray->uid);
  nid.uFlags = icon_changed ? NIF_ICON : NIF_TIP;
  if (icon_changed) {
    nid.hIcon = tray->icon;
  } else if (!tray->title.empty()) {
    wcsncpy_s(nid.szTip, tray->title.c_str(), _TRUNCATE);
  }
  Shell_NotifyIconW(NIM_MODIFY, &nid);
}

bool EndsWithIco(const std::wstring& s) {
  if (s.size() < 4) return false;
  std::wstring ext = s.substr(s.size() - 4);
  for (auto& c : ext) c = towlower(c);
  return ext == L".ico";
}

// GDI+ is used to decode non-ICO images (PNG is the common tray case) with
// alpha. Initialized lazily on first non-ICO icon.
HICON LoadTrayIconFile(const std::wstring& wide) {
  if (EndsWithIco(wide)) {
    return static_cast<HICON>(LoadImageW(nullptr, wide.c_str(), IMAGE_ICON, 16,
                                         16, LR_LOADFROMFILE));
  }
  static bool gdiplus_ready = false;
  static ULONG_PTR gdiplus_token = 0;
  if (!gdiplus_ready) {
    Gdiplus::GdiplusStartupInput si;
    if (Gdiplus::GdiplusStartup(&gdiplus_token, &si, nullptr) == Gdiplus::Ok) {
      gdiplus_ready = true;
    }
  }
  if (!gdiplus_ready) return nullptr;
  Gdiplus::Bitmap bmp(wide.c_str());
  if (bmp.GetLastStatus() != Gdiplus::Ok) return nullptr;
  HICON icon = nullptr;
  bmp.GetHICON(&icon);  // caller frees with DestroyIcon
  return icon;
}

LRESULT CALLBACK TrayWindowProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
  if (msg == kTrayCallbackMsg) {
    UINT_PTR uid = wp;
    switch (lp) {
      case WM_CONTEXTMENU:  // right-click
      case NIN_SELECT: {    // left-click (single) with NOTIFYICON_VERSION_4
        TrayHandle* tray = FindTrayByUid(uid);
        if (!tray) break;
        if (tray->has_menu) {
          ShowTrayMenu(tray);
        } else if (tray->click_enabled) {
          char buf[32];
          std::snprintf(buf, sizeof(buf), "{\"id\":%lld}",
                        static_cast<long long>(tray->id));
          PushSystemEvent("bunium-tray-click", buf);
        }
        break;
      }
      case NIN_BALLOONUSERCLICK:  // user clicked the notification balloon
        if (uid == kNotifyIconUid) {
          char buf[32];
          std::snprintf(buf, sizeof(buf), "{\"id\":%d}", g_notify.pending_id);
          PushSystemEvent("bunium-notification-click", buf);
        }
        break;
      default:
        break;
    }
    return 0;
  }
  if (msg == WM_COMMAND && HIWORD(wp) == 0) {
    // Menu selection from a tray's TrackPopupMenu (defensive; the
    // TPM_RETURNCMD path above is the normal route).
    BuniumSystemForwardMenuCommand(static_cast<int>(LOWORD(wp)));
    return 0;
  }
  return DefWindowProcW(hwnd, msg, wp, lp);
}

}  // namespace

// -------- tray exports -----------------------------------------------------

extern "C" {

__declspec(dllexport) void* bunium_system_tray_create(const char* title) {
  auto* tray = new TrayHandle();
  tray->id = g_tray_seq++;
  tray->uid = NextTrayUid();
  tray->title = Utf8ToWide(title);
  g_trays.push_back(tray);
  AddTrayIcon(tray);
  return tray;
}

__declspec(dllexport) void bunium_system_tray_set_title(void* tray_ptr,
                                                        const char* title) {
  auto* tray = static_cast<TrayHandle*>(tray_ptr);
  tray->title = Utf8ToWide(title);
  UpdateTrayIcon(tray, /*icon_changed=*/false);
}

// Icon from a file (Electron-compatible tray.setImage). .ico via LoadImageW;
// anything else (PNGs are the common case) goes through GDI+ so alpha
// survives.
__declspec(dllexport) void bunium_system_tray_set_icon(void* tray_ptr,
                                                       const char* image_path,
                                                       int is_template) {
  (void)is_template;  // Windows has no template-image concept
  auto* tray = static_cast<TrayHandle*>(tray_ptr);
  std::wstring wide = Utf8ToWide(image_path);
  HICON icon = LoadTrayIconFile(wide);
  if (!icon) {
    fprintf(stderr, "[bunium] tray: failed to load icon at %s\n", image_path);
    return;
  }
  if (tray->icon) DestroyIcon(tray->icon);
  tray->icon = icon;
  UpdateTrayIcon(tray, /*icon_changed=*/true);
}

__declspec(dllexport) void bunium_system_tray_set_symbol(void* tray_ptr,
                                                         const char* symbol) {
  (void)tray_ptr;
  // SF Symbols are a macOS concept; there is no Win32 equivalent. Keep the
  // current icon/title -- matching Electron, which ignores named images on
  // non-mac platforms.
  fprintf(stderr, "[bunium] tray: setSymbol(%s) ignored on Windows\n", symbol);
}

__declspec(dllexport) void bunium_system_tray_set_click(void* tray_ptr,
                                                        int on) {
  auto* tray = static_cast<TrayHandle*>(tray_ptr);
  tray->click_enabled = on != 0;
}

__declspec(dllexport) int64_t bunium_system_tray_get_id(void* tray_ptr) {
  return static_cast<int64_t>(static_cast<TrayHandle*>(tray_ptr)->id);
}

__declspec(dllexport) void bunium_system_tray_set_menu(void* tray_ptr,
                                                       void* menu_ptr) {
  auto* tray = static_cast<TrayHandle*>(tray_ptr);
  auto* menu = static_cast<MenuHandle*>(menu_ptr);
  // Rebuild + cache the popup HMENU; rebuilt each call in case the menu
  // changed since the last attachment (or a different menu is attached).
  if (tray->menu_cache) DestroyMenu(tray->menu_cache);
  tray->menu_cache = BuildMenu(menu->items());
  tray->has_menu = true;
  // A menu supersedes click delivery (matches Electron + the mac side).
  tray->click_enabled = false;
}

__declspec(dllexport) void bunium_system_tray_destroy(void* tray_ptr) {
  auto* tray = static_cast<TrayHandle*>(tray_ptr);
  NOTIFYICONDATAW nid = {};
  nid.cbSize = sizeof(nid);
  nid.hWnd = EnsureTrayMessageWindow();
  nid.uID = static_cast<UINT>(tray->uid);
  Shell_NotifyIconW(NIM_DELETE, &nid);
  if (tray->menu_cache) DestroyMenu(tray->menu_cache);
  if (tray->icon) DestroyIcon(tray->icon);
  g_trays.erase(std::remove(g_trays.begin(), g_trays.end(), tray),
                g_trays.end());
  delete tray;
}

// -------- notifications (shell balloons) -----------------------------------

// Balloons ride a dedicated hidden tray icon (uid 0). A real toast API needs
// a packaged app (AUMID + Start-menu shortcut); balloons are the dev-path
// analogue of mac's legacy NSUserNotification fallback.
__declspec(dllexport) void bunium_system_notify(const char* title,
                                                const char* body, int id) {
  std::wstring wt = Utf8ToWide(title);
  std::wstring wb = Utf8ToWide(body);
  g_notify.pending_id = id;

  HWND hwnd = EnsureTrayMessageWindow();
  if (!hwnd) return;
  NOTIFYICONDATAW nid = {};
  nid.cbSize = sizeof(nid);
  nid.hWnd = hwnd;
  nid.uID = static_cast<UINT>(kNotifyIconUid);
  nid.uFlags = NIF_MESSAGE | NIF_ICON | NIF_INFO;
  nid.uCallbackMessage = kTrayCallbackMsg;
  nid.hIcon = LoadIconW(nullptr, IDI_APPLICATION);
  wcsncpy_s(nid.szInfoTitle, wt.c_str(), _TRUNCATE);
  wcsncpy_s(nid.szInfo, wb.c_str(), _TRUNCATE);
  nid.dwInfoFlags = NIIF_INFO;
  nid.uTimeout = 4000;
  Shell_NotifyIconW(g_notify.added ? NIM_MODIFY : NIM_ADD, &nid);
  if (!g_notify.added) {
    g_notify.added = true;
    nid.uVersion = NOTIFYICON_VERSION_4;
    Shell_NotifyIconW(NIM_SETVERSION, &nid);
  }
  if (nid.hIcon) DestroyIcon(nid.hIcon);
}

}  // extern "C"

// -------- dialogs (worker-thread; never block the pump) -------------------

namespace {

struct DialogJob {
  int kind = 0;  // 0 = open, 1 = save, 2 = message
  std::wstring title;
  std::wstring default_name;
  std::wstring ok_label;
  std::wstring cancel_label;
  std::wstring message;
  std::wstring detail;
  bool allow_multiple = false;
  bool can_choose_dirs = false;
  bool can_create_dirs = false;
  int request_id = 0;
};

void PushDialogResult(int request_id, const std::string& payload) {
  char buf[24];
  std::snprintf(buf, sizeof(buf), "%d", request_id);
  PushSystemEvent("bunium-dialog-result",
                  std::string("{\"requestId\":") + buf + ",\"result\":" +
                      payload + "}");
}

std::string PathFromItem(IShellItem* item) {
  PWSTR path = nullptr;
  if (FAILED(item->GetDisplayName(SIGDN_FILESYSPATH, &path)) || !path) {
    return "";
  }
  int n = WideCharToMultiByte(CP_UTF8, 0, path, -1, nullptr, 0, nullptr,
                              nullptr);
  std::string out(n > 0 ? n - 1 : 0, '\0');
  if (n > 0) {
    WideCharToMultiByte(CP_UTF8, 0, path, -1, &out[0], n, nullptr, nullptr);
  }
  CoTaskMemFree(path);
  return out;
}

void RunOpenDialog(const DialogJob& job) {
  IFileOpenDialog* dlg = nullptr;
  std::string payload;
  if (FAILED(CoCreateInstance(CLSID_FileOpenDialog, nullptr,
                              CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&dlg)))) {
    payload = "{\"canceled\":true,\"paths\":[]}";
    PushDialogResult(job.request_id, payload);
    return;
  }
  DWORD opts = 0;
  dlg->GetOptions(&opts);
  opts |= FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST;
  if (job.allow_multiple) opts |= FOS_ALLOWMULTISELECT;
  // canChooseDirectories alone maps to a folder picker (Win32's open dialog
  // is either files or folders; there is no files-and-folders mode like
  // NSOpenPanel). Files+folders (allowMultiple) keeps the file picker.
  if (job.can_choose_dirs && !job.allow_multiple) opts |= FOS_PICKFOLDERS;
  if (job.can_create_dirs) opts |= FOS_CREATEPROMPT;
  dlg->SetOptions(opts);
  if (!job.title.empty()) dlg->SetTitle(job.title.c_str());
  if (!job.ok_label.empty()) dlg->SetOkButtonLabel(job.ok_label.c_str());

  HRESULT hr = dlg->Show(GetForegroundWindow());
  if (FAILED(hr)) {  // user canceled (ERROR_CANCELLED) or a dialog failure
    payload = "{\"canceled\":true,\"paths\":[]}";
  } else if (job.allow_multiple) {
    IShellItemArray* items = nullptr;
    std::string list = "[";
    if (SUCCEEDED(dlg->GetResults(&items)) && items) {
      DWORD count = 0;
      items->GetCount(&count);
      for (DWORD i = 0; i < count; ++i) {
        IShellItem* item = nullptr;
        if (FAILED(items->GetItemAt(i, &item)) || !item) continue;
        if (i > 0) list += ",";
        list += "\"" + JsonEscape(PathFromItem(item)) + "\"";
        item->Release();
      }
      items->Release();
    }
    list += "]";
    payload = "{\"canceled\":false,\"paths\":" + list + "}";
  } else {
    IShellItem* item = nullptr;
    std::string path;
    if (SUCCEEDED(dlg->GetResult(&item)) && item) {
      path = PathFromItem(item);
      item->Release();
    }
    payload = "{\"canceled\":false,\"paths\":[\"" + JsonEscape(path) + "\"]}";
  }
  dlg->Release();
  PushDialogResult(job.request_id, payload);
}

void RunSaveDialog(const DialogJob& job) {
  IFileSaveDialog* dlg = nullptr;
  std::string payload;
  if (FAILED(CoCreateInstance(CLSID_FileSaveDialog, nullptr,
                              CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&dlg)))) {
    payload = "{\"canceled\":true,\"path\":null}";
    PushDialogResult(job.request_id, payload);
    return;
  }
  DWORD opts = 0;
  dlg->GetOptions(&opts);
  opts |= FOS_OVERWRITEPROMPT | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST;
  dlg->SetOptions(opts);
  if (!job.title.empty()) dlg->SetTitle(job.title.c_str());
  if (!job.default_name.empty()) dlg->SetFileName(job.default_name.c_str());
  if (!job.ok_label.empty()) dlg->SetOkButtonLabel(job.ok_label.c_str());

  HRESULT hr = dlg->Show(GetForegroundWindow());
  if (FAILED(hr)) {
    payload = "{\"canceled\":true,\"path\":null}";
  } else {
    IShellItem* item = nullptr;
    std::string path;
    if (SUCCEEDED(dlg->GetResult(&item)) && item) {
      path = PathFromItem(item);
      item->Release();
    }
    payload = "{\"canceled\":false,\"path\":\"" + JsonEscape(path) + "\"}";
  }
  dlg->Release();
  PushDialogResult(job.request_id, payload);
}

void RunMessageDialog(const DialogJob& job) {
  std::string payload;
  bool has_cancel = !job.cancel_label.empty();
  TASKDIALOGCONFIG cfg = {};
  cfg.cbSize = sizeof(cfg);
  cfg.dwFlags = TDF_ALLOW_DIALOG_CANCELLATION;
  cfg.hwndParent = GetForegroundWindow();
  cfg.pszWindowTitle = job.title.empty() ? L"bunium" : job.title.c_str();
  cfg.pszMainInstruction = job.message.c_str();
  cfg.pszContent = job.detail.empty() ? nullptr : job.detail.c_str();
  TASKDIALOG_BUTTON buttons[2] = {
      {100, job.ok_label.empty() ? L"OK" : job.ok_label.c_str()},
      {101, has_cancel ? job.cancel_label.c_str() : L"Cancel"},
  };
  cfg.cButtons = has_cancel ? 2 : 1;
  cfg.pButtons = buttons;

  // TaskDialogIndirect lives in comctl32 v6. The Windows SDK's static
  // import lib binds it BY ORDINAL -- and modern comctl32.dll renumbered
  // those ordinals, so a static link fails with ERROR_INVALID_ORDINAL at
  // DLL load. Resolve by name at runtime instead.
  typedef HRESULT(WINAPI* TaskDialogIndirectFn)(const TASKDIALOGCONFIG*, int*,
                                                int*, int*);
  static TaskDialogIndirectFn task_dialog = []() -> TaskDialogIndirectFn {
    HMODULE m = LoadLibraryW(L"comctl32.dll");
    return m ? reinterpret_cast<TaskDialogIndirectFn>(
                   GetProcAddress(m, "TaskDialogIndirect"))
             : nullptr;
  }();

  int pressed = 0;
  HRESULT hr =
      task_dialog ? task_dialog(&cfg, &pressed, nullptr, nullptr)
                  : static_cast<HRESULT>(E_NOTIMPL);
  if (FAILED(hr)) {
    // No comctl32 v6 (no manifest in host process) or dialog failed. Classic
    // MessageBoxW mirrors the OK/Cancel contract; dialog failure => cancel.
    int mb = MessageBoxW(cfg.hwndParent, job.message.c_str(),
                         cfg.pszWindowTitle,
                         MB_OKCANCEL | MB_ICONINFORMATION | MB_APPLMODAL |
                             MB_SETFOREGROUND);
    int response = mb == IDOK ? 0 : 1;
    payload = std::string("{\"response\":") + (response ? "1" : "0") + "}";
    PushDialogResult(job.request_id, payload);
    return;
  }
  payload = std::string("{\"response\":") + (pressed == 100 ? "0" : "1") +
            "}";
  PushDialogResult(job.request_id, payload);
}

void DialogWorker(DialogJob job) {
  CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
  switch (job.kind) {
    case 0:
      RunOpenDialog(job);
      break;
    case 1:
      RunSaveDialog(job);
      break;
    default:
      RunMessageDialog(job);
      break;
  }
  CoUninitialize();
}

}  // namespace

// -------- dialog exports + event bus ---------------------------------------

extern "C" {

__declspec(dllexport) void bunium_system_dialog_open(
    const char* title, int allow_multiple, int can_choose_directories,
    int can_create_directories, const char* ok_label, int request_id) {
  DialogJob job;
  job.kind = 0;
  job.title = Utf8ToWide(title);
  job.ok_label = Utf8ToWide(ok_label);
  job.allow_multiple = allow_multiple != 0;
  job.can_choose_dirs = can_choose_directories != 0;
  job.can_create_dirs = can_create_directories != 0;
  job.request_id = request_id;
  std::thread(DialogWorker, std::move(job)).detach();
}

__declspec(dllexport) void bunium_system_dialog_save(const char* title,
                                                     const char* default_name,
                                                     const char* ok_label,
                                                     int request_id) {
  DialogJob job;
  job.kind = 1;
  job.title = Utf8ToWide(title);
  job.default_name = Utf8ToWide(default_name);
  job.ok_label = Utf8ToWide(ok_label);
  job.request_id = request_id;
  std::thread(DialogWorker, std::move(job)).detach();
}

__declspec(dllexport) void bunium_system_dialog_message(
    const char* message, const char* detail, const char* ok_label,
    const char* cancel_label, int request_id) {
  DialogJob job;
  job.kind = 2;
  job.message = Utf8ToWide(message);
  job.detail = Utf8ToWide(detail);
  job.ok_label = Utf8ToWide(ok_label);
  job.cancel_label = Utf8ToWide(cancel_label);
  job.request_id = request_id;
  std::thread(DialogWorker, std::move(job)).detach();
}

__declspec(dllexport) const char* bunium_poll_system_event() {
  std::lock_guard<std::mutex> lock(g_inbox_mtx);
  if (g_inbox.empty()) return nullptr;
  g_export = std::move(g_inbox.front());
  g_inbox.pop_front();
  return g_export.c_str();
}

}  // extern "C"