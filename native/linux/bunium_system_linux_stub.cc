// Phase 5 system-surface stubs for Linux v1 (native menu bar / tray /
// dialogs). Notifications and the system-event inbox (bunium_poll_
// system_event) are real now -- see bunium_system_notify_linux.cc /
// bunium_system_events_linux.cc -- menu/tray/dialogs remain honest no-ops
// for the moment (dialogs and tray are next; menu needs real design work,
// see PLAN.md Phase 6). src/native.ts's single dlopen() call binds this
// whole symbol set unconditionally (same list on every platform), so
// unimplemented ones must still exist as honest no-ops (menu/tray creation
// returns null, dialogs are silent no-ops) rather than missing symbols,
// which would fail dlopen entirely and block even a plain window.
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

BUNIUM_LINUX_EXPORT void bunium_system_dialog_open(const char*, int, int, int,
                                                     const char*, int) {}
BUNIUM_LINUX_EXPORT void bunium_system_dialog_save(const char*, const char*,
                                                     const char*, int) {}
BUNIUM_LINUX_EXPORT void bunium_system_dialog_message(const char*, const char*,
                                                        const char*,
                                                        const char*, int) {}

}  // extern "C"
