// Phase 6: native menu bar for bunium on Linux via the com.canonical.
// dbusmenu wire protocol (the "AppIndicator" convention GNOME Shell's
// AppIndicator extension, KDE Plasma, XFCE's indicator-application, and
// most other panels that render a tray at all already know how to
// consume). This is deliberately NOT an in-window GtkMenuBar: bunium's
// Linux window is raw Xlib (see bunium_window_linux.cc), no GTK toplevel
// exists to attach a real widget menu bar to, and there is no single
// cross-desktop convention for an application-level (not tray-attached)
// global menu bar the way macOS's NSMenu or Windows' HMENU are -- see
// PLAN.md Phase 6 for the survey.
//
// What IS real, universal-enough, and tractable: a tray icon's context
// menu. The StatusNotifierItem spec (bunium_system_tray_linux.cc) already
// has a `Menu` property (a D-Bus object path) and an `ItemIsMenu` bool --
// every SNI-consuming panel already knows to fetch and render whatever
// dbusmenu object that path points at when the user activates the tray
// icon. `tray.setMenu(menu)` becomes fully real via this file (menu tree
// construction) + bunium_system_tray_linux.cc (which serves the dbusmenu
// wire protocol -- GetLayout/Event/AboutToShow -- on the SAME
// DBusConnection/bus name the tray's own SNI object already uses, see
// that file's header for why), while `Menu.setApplicationMenu()` stays an
// HONEST no-op (see below) since it has no tray to attach to.
//
// This file ONLY builds the in-memory item tree (a plain GObject tree via
// libdbusmenu-glib's DbusmenuMenuitem, used purely as a convenient typed
// property-bag/child-list data structure -- NOT via DbusmenuServer, which
// this codebase deliberately does not use: DbusmenuServer opens its OWN
// private GDBus connection with its own unique bus name, unreachable by a
// real host that resolves the tray's `Menu` property against the tray's
// OWN registered SNI bus name. Confirmed empirically: a real GetLayout
// call against a DbusmenuServer-published path failed with "not a valid
// bus name" when routed through the tray's SNI bus name, since the two
// objects lived on two different D-Bus connections entirely. Serving the
// wire protocol by hand on the tray's existing raw-libdbus connection
// (bunium_system_tray_linux.cc) is the real fix, so this file's job ends
// at tree construction). Menu construction itself
// (bunium_system_menu_create/add_item/add_submenu/add_separator) IS real
// regardless of whether the resulting Menu ever gets attached to a tray
// or to setApplicationMenu() -- a Menu must be fully buildable before
// tray.setMenu() can hand it off. Only the final "become the app-wide
// menu bar" step is the no-op.
//
// Threading: dbusmenu-glib's DbusmenuMenuitem is itself GLib/GObject-based
// (its GType machinery is initialized the first time any GObject-based
// type is touched), same class of hazard bunium_system_dialogs_linux.cc's
// header documents in detail for GTK -- a second thread initializing its
// own GLib main loop can race CEF's own GLib-based UI-thread pump
// (base::MessagePumpGlib) for ownership of the default GMainContext and
// abort (SIGTRAP, already hit and fixed once for GTK). This file follows
// the same fix: every DbusmenuMenuitem call happens directly on the
// thread that calls these exported functions (CEF's UI thread, same
// thread bunium_do_message_loop_work() runs on) -- never spawning a
// dedicated thread or running g_main_loop_run()/gtk_main() of our own.
// DbusmenuMenuitem's own GObject property storage needs no main loop at
// all (it's just a hash table + signals, no D-Bus of its own here), so
// this is even less main-loop-sensitive than the GTK dialogs case.
#include <libdbusmenu-glib/menuitem.h>
#include <libdbusmenu-glib/client.h>

#include <cstdint>

#define BUNIUM_LINUX_EXPORT __attribute__((visibility("default")))

extern "C" {

// Returns a DbusmenuMenuitem* (the tree's root) cast to void*, matching
// the same opaque-handle contract every other Phase 5/6 export uses. Root
// id is forced to 0 (not the GType-machinery-assigned auto id
// dbusmenu_menuitem_new() would otherwise pick) because GetLayout(0, ...)
// -- "give me the tree starting at id 0" -- is the universal convention
// every dbusmenu client (GNOME Shell's AppIndicator extension included)
// uses to mean "the root", regardless of what id the root object itself
// happens to carry.
BUNIUM_LINUX_EXPORT void* bunium_system_menu_create() {
  return dbusmenu_menuitem_new_with_id(0);
}

// item ids are passed straight through as the DbusmenuMenuitem's own id
// (dbusmenu_menuitem_new_with_id), NOT capped the way win's HMENU-based
// WM_COMMAND ids are (native/win/bunium_system_win.cc's kMaxMenuId =
// 0xFFFF, a 16-bit Win32 limitation) -- dbusmenu ids are plain gint
// (32-bit signed), so bunium's full int32 id range from Menu.ts's
// `spec.id ?? this.nextId++` passes through unmodified. Caller-supplied
// ids must stay nonzero (0 is reserved for the root, see
// bunium_system_menu_create) -- Menu.ts's own nextId counter already
// starts at 1, so this only matters for explicit `id: 0` in a
// MenuItemSpec, an edge case not worth guarding against here (same
// "trust the caller" posture the mac/win menu code takes for its own id
// space).
BUNIUM_LINUX_EXPORT void* bunium_system_menu_add_item(void* menu_handle,
                                                       const char* label,
                                                       int32_t id) {
  if (!menu_handle) return nullptr;
  DbusmenuMenuitem* parent = static_cast<DbusmenuMenuitem*>(menu_handle);
  DbusmenuMenuitem* item = dbusmenu_menuitem_new_with_id(id);
  dbusmenu_menuitem_property_set(item, DBUSMENU_MENUITEM_PROP_LABEL,
                                 label ? label : "");
  dbusmenu_menuitem_property_set_bool(item, DBUSMENU_MENUITEM_PROP_VISIBLE,
                                      TRUE);
  dbusmenu_menuitem_property_set_bool(item, DBUSMENU_MENUITEM_PROP_ENABLED,
                                      TRUE);
  dbusmenu_menuitem_child_append(parent, item);
  return item;
}

// Submenus are just ordinary DbusmenuMenuitem nodes with children of their
// own -- dbusmenu has no distinct "submenu" node type the way NSMenu does
// (an NSMenuItem's submenu is a separate NSMenu object); a client infers
// "this is a submenu" from the "children-display":"submenu" property,
// which bunium_system_tray_linux.cc's GetLayout serializer sets on any
// node with children (see that file). No id is assigned (submenu headers
// aren't independently clickable, matching mac/win's own
// submenu-header-is-not-an-actionable-item behavior).
BUNIUM_LINUX_EXPORT void* bunium_system_menu_add_submenu(void* menu_handle,
                                                          const char* label) {
  if (!menu_handle) return nullptr;
  DbusmenuMenuitem* parent = static_cast<DbusmenuMenuitem*>(menu_handle);
  // No explicit id -- submenu headers are never independently clickable
  // (see comment above), so what id dbusmenu_menuitem_new()'s internal
  // auto-counter picks doesn't matter; it just needs to be unique enough
  // not to collide with 0 (root) or any caller-assigned item id, which
  // dbusmenu-glib's own global auto-id counter (separate id space from
  // caller-assigned ones in practice) already guarantees.
  DbusmenuMenuitem* submenu = dbusmenu_menuitem_new();
  dbusmenu_menuitem_property_set(submenu, DBUSMENU_MENUITEM_PROP_LABEL,
                                 label ? label : "");
  dbusmenu_menuitem_property_set_bool(submenu, DBUSMENU_MENUITEM_PROP_VISIBLE,
                                      TRUE);
  dbusmenu_menuitem_child_append(parent, submenu);
  return submenu;
}

BUNIUM_LINUX_EXPORT void bunium_system_menu_add_separator(void* menu_handle) {
  if (!menu_handle) return;
  DbusmenuMenuitem* parent = static_cast<DbusmenuMenuitem*>(menu_handle);
  DbusmenuMenuitem* sep = dbusmenu_menuitem_new();
  dbusmenu_menuitem_property_set(sep, DBUSMENU_MENUITEM_PROP_TYPE,
                                 DBUSMENU_CLIENT_TYPES_SEPARATOR);
  dbusmenu_menuitem_child_append(parent, sep);
}

// Honest no-op: there is no cross-desktop application-level (not
// tray-attached) global menu bar convention on Linux -- see file header.
// A Menu built via the exports above can still become fully real via
// tray.setMenu() (bunium_system_tray_set_menu in
// bunium_system_tray_linux.cc), which is the supported v1 path for a
// clickable menu on Linux.
BUNIUM_LINUX_EXPORT void bunium_system_set_application_menu(void*) {}

}  // extern "C"
