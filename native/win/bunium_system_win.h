// Cross-TU declarations for the Windows system surface (menu/tray/notify/
// dialogs, all in bunium_system_win.cc) and the window layer that feeds it
// native notifications (bunium_window_win.cc). Both TUs link into the same
// bunium_shim.dll; the window proc needs to forward menu selections here,
// and the system module needs to apply the app menu to every live window.
#ifndef BUNIUM_SYSTEM_WIN_H
#define BUNIUM_SYSTEM_WIN_H

#include <windows.h>

#include <string>

// ---- implemented in bunium_system_win.cc ----

// Forward a WM_COMMAND menu selection (LOWORD(wParam)) to the system bus as
// a bunium-menu-click {"id":N} event.
void BuniumSystemForwardMenuCommand(int id);

// Rebuilds + sets the application menu bar on `hwnd` if one was registered
// via bunium_system_set_application_menu. No-op otherwise.
void BuniumApplyAppMenu(HWND hwnd);

// ---- implemented in bunium_window_win.cc ----

// Calls `fn(hwnd, ctx)` for every primary (non-sublayer) window whose
// HWND is still valid, in creation order.
void BuniumForEachPrimaryWindow(void (*fn)(HWND, void*), void* ctx);

#endif  // BUNIUM_SYSTEM_WIN_H