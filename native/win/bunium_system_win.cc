// Windows system surface for bunium -- Phase 7 v1.
//
// Status: placeholders, not features. The macOS implementation
// (bunium_system_mac.mm / notify / dialogs) is NSMenu/NSStatusItem/
// UNUserNotificationCenter/NSOpenPanel-based; the Win32 equivalents
// (HMENU app menus, NOTIFYICONDATA shell tray, toast notifications,
// IFileDialog/GetOpenFileName) are a tracked follow-up (see PLAN.md Phase 7
// milestones). These stubs exist so the DLL exposes the full ABI surface
// bun:ffi's dlopen() lists in src/native.ts -- a missing symbol would fail
// the whole dlopen -- while behaving honestly: menu/tray/notify objects
// exist as inert handles and dialogs immediately resolve as "canceled"
// instead of hanging the JS promise.
//
// Format matches the mac side exactly: bunium_poll_system_event returns
// a JSON envelope {"name": "...", "payload": "..."} (payload itself JSON) or
// NULL; see src/system/events.ts for the drain loop.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>

#include <cstdint>
#include <cstdio>
#include <cstring>
#include <deque>
#include <mutex>
#include <string>

namespace {

std::mutex g_inbox_mtx;
std::deque<std::string> g_inbox;
std::string g_export;

// Enqueues one envelope, matching mac PushSystemEvent's encoding: the
// payload string is embedded as JSON (quoted/escaped) inside a
// {"name":..., "payload":...} object.
void PushSystemEvent(const std::string& name, const std::string& payload) {
  // Envelope: {"name":"...","payload":"..."}. Name comes from our own
  // code (no escaping needed); payload is JSON we built with snprintf, so
  // it is already valid JSON text and is embedded verbatim.
  char buf[32];
  std::snprintf(buf, sizeof(buf), "%zu", payload.size());
  std::string env = "{\"name\":\"" + name + "\",\"payload\":" + payload + "}";
  std::lock_guard<std::mutex> lock(g_inbox_mtx);
  g_inbox.push_back(std::move(env));
}

// Opaque handle objects -- non-null so JS-side truthiness checks pass,
// no-op operations so the object model (Menu/Tray classes) works unchanged.
struct MenuHandle {
  int kind;  // 0 = menu, 1 = item
};

struct TrayHandle {
  intptr_t id;
};

void PushCanceledResult(int request_id, bool open_panel) {
  char buf[256];
  if (open_panel) {
    std::snprintf(buf, sizeof(buf),
                  "{\"requestId\":%d,\"result\":{\"canceled\":true,"
                  "\"paths\":[]}}",
                  request_id);
  } else {
    std::snprintf(buf, sizeof(buf),
                  "{\"requestId\":%d,\"result\":{\"canceled\":true,"
                  "\"path\":null}}",
                  request_id);
  }
  PushSystemEvent("bunium-dialog-result", buf);
}

}  // namespace

extern "C" {

// -------- menu (stub; Win32 HMENU app-menu surface is a follow-up) -------

__declspec(dllexport) void* bunium_system_menu_create() {
  return new MenuHandle{0};
}

__declspec(dllexport) void* bunium_system_menu_add_item(void* menu,
                                                        const char* title,
                                                        int key_modifiers) {
  (void)menu;
  (void)title;
  (void)key_modifiers;
  return new MenuHandle{1};
}

__declspec(dllexport) void* bunium_system_menu_add_submenu(void* menu,
                                                           const char* title) {
  (void)menu;
  (void)title;
  return new MenuHandle{0};
}

__declspec(dllexport) void bunium_system_menu_add_separator(void* menu) {
  (void)menu;
}

__declspec(dllexport) void bunium_system_set_application_menu(void* menu) {
  (void)menu;
}

// -------- tray (stub; NOTIFYICONDATA shell tray is a follow-up) ----------

__declspec(dllexport) void* bunium_system_tray_create(const char* title) {
  (void)title;
  static intptr_t next_id = 1;
  return new TrayHandle{next_id++};
}

__declspec(dllexport) void bunium_system_tray_set_title(void* tray,
                                                        const char* title) {
  (void)tray;
  (void)title;
}

__declspec(dllexport) void bunium_system_tray_set_icon(void* tray,
                                                       const char* image_path,
                                                       int is_template) {
  (void)tray;
  (void)image_path;
  (void)is_template;
}

__declspec(dllexport) void bunium_system_tray_set_symbol(void* tray,
                                                         const char* symbol) {
  (void)tray;
  (void)symbol;
}

__declspec(dllexport) void bunium_system_tray_set_click(void* tray, int on) {
  (void)tray;
  (void)on;
}

__declspec(dllexport) int64_t bunium_system_tray_get_id(void* tray) {
  return static_cast<int64_t>(static_cast<TrayHandle*>(tray)->id);
}

__declspec(dllexport) void bunium_system_tray_set_menu(void* tray,
                                                       void* menu) {
  (void)tray;
  (void)menu;
}

__declspec(dllexport) void bunium_system_tray_destroy(void* tray) {
  delete static_cast<TrayHandle*>(tray);
}

// -------- notifications (stub; toast notifications are a follow-up) ------

__declspec(dllexport) void bunium_system_notify(const char* title,
                                                const char* body, int flags) {
  (void)title;
  (void)body;
  (void)flags;
}

// -------- dialogs (v1: always resolve canceled, never block the pump) ----

__declspec(dllexport) void bunium_system_dialog_open(
    const char* title, int allow_multiple, int can_choose_directories,
    int can_create_directories, const char* ok_label, int request_id) {
  (void)title;
  (void)allow_multiple;
  (void)can_choose_directories;
  (void)can_create_directories;
  (void)ok_label;
  PushCanceledResult(request_id, /*open_panel=*/true);
}

__declspec(dllexport) void bunium_system_dialog_save(const char* title,
                                                     const char* default_name,
                                                     const char* ok_label,
                                                     int request_id) {
  (void)title;
  (void)default_name;
  (void)ok_label;
  PushCanceledResult(request_id, /*open_panel=*/false);
}

__declspec(dllexport) void bunium_system_dialog_message(
    const char* message, const char* detail, const char* ok_label,
    const char* cancel_label, int request_id) {
  (void)message;
  (void)detail;
  (void)ok_label;
  (void)cancel_label;
  char buf[128];
  std::snprintf(buf, sizeof(buf),
                "{\"requestId\":%d,\"result\":{\"response\":1}}", request_id);
  PushSystemEvent("bunium-dialog-result", buf);
}

// -------- event bus (real; same drain contract as mac) -------------------

__declspec(dllexport) const char* bunium_poll_system_event() {
  std::lock_guard<std::mutex> lock(g_inbox_mtx);
  if (g_inbox.empty()) return nullptr;
  g_export = std::move(g_inbox.front());
  g_inbox.pop_front();
  return g_export.c_str();
}

}  // extern "C"