// Phase 5 system-surface stub for Linux v1 (native menu bar only). Every
// other Phase 5 vertical -- notifications (bunium_system_notify_linux.cc),
// the system-event inbox (bunium_system_events_linux.cc), dialogs
// (bunium_system_dialogs_linux.cc), and tray (bunium_system_tray_linux.cc)
// -- is real now. Menu remains an honest no-op: Linux has no NSMenu/HMENU
// equivalent without a real toolkit window to attach one to (bunium's
// window is raw Xlib, see bunium_window_linux.cc), and no single
// cross-desktop "global menu" convention -- real design work, not
// attempted this pass (see PLAN.md Phase 6). src/native.ts's single
// dlopen() call binds this whole symbol set unconditionally (same list on
// every platform), so unimplemented ones must still exist as honest
// no-ops (menu creation returns null) rather than missing symbols, which
// would fail dlopen entirely and block even a plain window.
#include <cstdint>

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

}  // extern "C"
