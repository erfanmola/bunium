// Phase 5 system-surface stubs for Linux v1 (native menu bar / tray).
// Notifications (bunium_system_notify_linux.cc), the system-event inbox
// (bunium_system_events_linux.cc), and dialogs
// (bunium_system_dialogs_linux.cc) are real now -- menu/tray remain honest
// no-ops (tray is next; menu needs real design work, see PLAN.md Phase 6).
// src/native.ts's single dlopen() call binds this whole symbol set
// unconditionally (same list on every platform), so unimplemented ones
// must still exist as honest no-ops (menu/tray creation returns null)
// rather than missing symbols, which would fail dlopen entirely and block
// even a plain window.
#include <cstdint>
#include <cstring>

#define BUNIUM_LINUX_EXPORT __attribute__((visibility("default")))

extern "C" {

BUNIUM_LINUX_EXPORT void* bunium_system_menu_create() { return nullptr; }
BUNIUM_LINUX_EXPORT void* bunium_system_menu_add_item(void*, const char*,
                                                        int) {
  return nullptr;
}
BUNIUM_LINUX_EXPORT void* bunium_system_menu_add_submenu(void*, const char*) {
  return nullptr;
}
BUNIUM_LINUX_EXPORT void bunium_system_menu_add_separator(void*) {}
BUNIUM_LINUX_EXPORT void bunium_system_set_application_menu(void*) {}

BUNIUM_LINUX_EXPORT void* bunium_system_tray_create(const char*) {
  return nullptr;
}
BUNIUM_LINUX_EXPORT void bunium_system_tray_set_title(void*, const char*) {}
BUNIUM_LINUX_EXPORT void bunium_system_tray_set_icon(void*, const char*,
                                                       int) {}
BUNIUM_LINUX_EXPORT void bunium_system_tray_set_symbol(void*, const char*) {}
BUNIUM_LINUX_EXPORT void bunium_system_tray_set_click(void*, int) {}
BUNIUM_LINUX_EXPORT int64_t bunium_system_tray_get_id(void*) { return 0; }
BUNIUM_LINUX_EXPORT void bunium_system_tray_set_menu(void*, void*) {}
BUNIUM_LINUX_EXPORT void bunium_system_tray_destroy(void*) {}

}  // extern "C"
