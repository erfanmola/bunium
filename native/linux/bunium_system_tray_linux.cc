// Phase 5: system tray for bunium on Linux via the freedesktop.org
// StatusNotifierItem D-Bus protocol (the modern replacement for the old
// XEmbed systray -- what GNOME Shell/KDE Plasma/most current panels
// actually implement). Own translation unit, same vertical-slice pattern
// as mac's tray half of bunium_system_mac.mm.
//
// Each tray registers itself as a D-Bus service (well-known name
// "org.kde.StatusNotifierItem-<pid>-<id>", object path
// "/StatusNotifierItem/<id>") exposing the org.kde.StatusNotifierItem
// interface's properties (Category/Id/Title/Status/IconName/Menu) via
// org.freedesktop.DBus.Properties, and Activate/ContextMenu/
// SecondaryActivate/Scroll methods -- then asks
// org.kde.StatusNotifierWatcher to register it. If no watcher is running
// (this dev container has none -- no GNOME/KDE session), registration
// simply fails silently and the item is inert but harmless, same
// degrade-gracefully contract bunium_system_notify_linux.cc uses for its
// own no-session-bus case. A real desktop panel is needed to ever actually
// SEE the tray icon -- same category of gap as every other platform's
// interactive tray verification.
//
// Threading: reuses the same "no dedicated GTK-style thread" lesson from
// bunium_system_dialogs_linux.cc where it matters (none of this touches
// GTK), but DOES need its own background dispatch thread like
// bunium_system_notify_linux.cc -- unlike dialogs, this is a D-Bus
// *service* that must keep responding to incoming method calls
// (Activate/Properties.Get/...) for the tray's entire lifetime, not a
// one-shot client call.
//
// v1 scope: IconName (a freedesktop icon-theme name, set via
// bunium_system_tray_set_symbol -- matches how the mac SF-Symbol names
// passed by cross-platform example code won't resolve to anything real on
// Linux either, same "platform interprets its own idiom" precedent
// Windows already established for setSymbol) AND IconPixmap (an arbitrary
// image file, set via bunium_system_tray_set_icon) are both implemented.
// setIcon decodes the file via GdkPixbuf (gdk-pixbuf-2.0, already pulled
// in transitively by the gtk+-3.0 link the dialogs half of this shim
// needs -- no new build-flag surface) into raw ARGB32 bytes in the exact
// big-endian-per-pixel layout the SNI spec's a(iiay) IconPixmap variant
// requires, cached in TrayState, and served from GetAll/Get the same way
// IconName already was. GdkPixbuf decode is safe to call directly on this
// thread with no gtk_init() gating (unlike GTK widgets, gdk-pixbuf has no
// "must run on the gtk_init() thread" requirement -- it does no windowing,
// only image decode).
//
// set_menu (Phase 6): attaches a menu tree (built by
// bunium_system_menu_linux.cc as a plain DbusmenuMenuitem GObject tree --
// used purely as a typed property-bag/child-list data structure) to this
// tray via the SNI spec's own `Menu` object-path property, the same
// "AppIndicator" convention GNOME Shell's AppIndicator extension / KDE
// Plasma / XFCE's indicator-application panel already know how to render
// on tray activation. Registers a SECOND object path (/MenuBar/<id>, a
// sibling of this tray's own /StatusNotifierItem/<id>) on the SAME
// DBusConnection/bus name the tray's SNI object already uses, serving the
// com.canonical.dbusmenu wire protocol (GetLayout/Event/AboutToShow) by
// hand in HandleMenuObjectMessage below -- deliberately NOT via
// libdbusmenu-glib's DbusmenuServer, which opens its OWN private GDBus
// connection with its own unique bus name. That was tried first and
// failed a real end-to-end check: a client resolving the tray's
// advertised Menu path against the tray's OWN registered SNI bus name hit
// "not a valid bus name", because DbusmenuServer's object lived on a
// completely different D-Bus connection than the one the Menu property's
// bus-name half implicitly points at (Menu is just an object path -- the
// bus name a client uses to resolve it is whatever bus name it already
// has the SNI object under). Serving the protocol on the tray's own
// connection is the only way the same bus name answers both the SNI
// object AND the dbusmenu object, which is what every real client
// (GNOME Shell's AppIndicator extension included) assumes.
#include <dbus/dbus.h>
#include <gdk-pixbuf/gdk-pixbuf.h>
#include <libdbusmenu-glib/menuitem.h>

#include <unistd.h>

#include <cstdint>
#include <cstdio>
#include <cstring>
#include <mutex>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>

#include "bunium_system_events_linux.h"

namespace {

struct TrayState {
  int64_t id;
  std::string title;
  std::string icon_name;
  // IconPixmap cache: one ARGB32 image (SNI supports multiple sizes per
  // icon, v1 scope keeps just the one the caller last set). Empty when no
  // setIcon() has succeeded yet -- IconName/setSymbol remains the fallback
  // a real panel picks when IconPixmap is absent (SNI clients try
  // IconPixmap first, then IconName -- both being present is fine and
  // matches how a real app might offer both).
  int32_t icon_w = 0;
  int32_t icon_h = 0;
  std::vector<uint8_t> icon_argb;  // width*height*4 bytes, big-endian ARGB
  bool click_enabled = false;
  // Phase 6: set once tray.setMenu() attaches a real dbusmenu tree. Empty
  // means "no menu" -- GetAll/Get keep advertising Menu="/" and
  // ItemIsMenu=FALSE in that case, same as before this menu existed.
  // menu_root is the DbusmenuMenuitem* tree root handed in by
  // tray.setMenu() (owned by JS-side Menu.handle, not freed here -- same
  // "caller owns handles, native just holds a raw pointer" convention
  // every other Phase 5/6 handle in this codebase already uses).
  std::string menu_path;
  DbusmenuMenuitem* menu_root = nullptr;
};

// Decodes an arbitrary image file via GdkPixbuf and repacks it into the
// big-endian ARGB32 byte layout the SNI a(iiay) IconPixmap variant
// requires (network/big-endian 32-bit ARGB per pixel, row-major) --
// GdkPixbuf itself always decodes to 8-bit-per-channel RGB(A), row-major,
// but as separate R/G/B/A bytes in that order, not packed big-endian
// ARGB32, so the channel reorder below is required, not just a copy.
// Returns false (leaving `out_*` untouched) on any decode failure --
// caller keeps whatever IconPixmap it had before, matching setSymbol's
// same "bad input leaves prior state alone" behavior.
bool DecodeIconFile(const std::string& path, int32_t* out_w, int32_t* out_h,
                    std::vector<uint8_t>* out_argb) {
  GError* err = nullptr;
  GdkPixbuf* pixbuf = gdk_pixbuf_new_from_file(path.c_str(), &err);
  if (!pixbuf) {
    fprintf(stderr, "[bunium] tray: setIcon: failed to decode %s (%s)\n",
           path.c_str(), err ? err->message : "unknown error");
    if (err) g_error_free(err);
    return false;
  }
  // Ensure an alpha channel exists (source may be opaque, e.g. a JPEG or a
  // flat PNG) -- add_alpha is a no-op copy when one is already present.
  GdkPixbuf* rgba = gdk_pixbuf_add_alpha(pixbuf, FALSE, 0, 0, 0);
  g_object_unref(pixbuf);
  if (!rgba) return false;

  int w = gdk_pixbuf_get_width(rgba);
  int h = gdk_pixbuf_get_height(rgba);
  int stride = gdk_pixbuf_get_rowstride(rgba);
  const guchar* pixels = gdk_pixbuf_get_pixels(rgba);
  if (w <= 0 || h <= 0 || !pixels) {
    g_object_unref(rgba);
    return false;
  }

  std::vector<uint8_t> argb(static_cast<size_t>(w) * h * 4);
  for (int y = 0; y < h; ++y) {
    const guchar* row = pixels + static_cast<size_t>(y) * stride;
    for (int x = 0; x < w; ++x) {
      const guchar* px = row + static_cast<size_t>(x) * 4;  // R,G,B,A
      uint8_t* out = &argb[(static_cast<size_t>(y) * w + x) * 4];
      out[0] = px[3];  // A
      out[1] = px[0];  // R
      out[2] = px[1];  // G
      out[3] = px[2];  // B
    }
  }
  g_object_unref(rgba);

  *out_w = w;
  *out_h = h;
  *out_argb = std::move(argb);
  return true;
}

std::mutex g_mtx;
DBusConnection* g_conn = nullptr;
bool g_connect_attempted = false;
std::unordered_map<int64_t, TrayState> g_trays;  // id -> state
int64_t g_next_id = 1;

std::string ObjectPathFor(int64_t id) {
  return "/StatusNotifierItem/" + std::to_string(id);
}

std::string BusNameFor(int64_t id) {
  return "org.kde.StatusNotifierItem-" + std::to_string(getpid()) + "-" +
         std::to_string(id);
}

std::string MenuObjectPathFor(int64_t id) {
  return "/MenuBar/" + std::to_string(id);
}

// Appends {"PropertyName": Variant(value)} into an already-open a{sv}
// dict-entry iterator -- shared by both Get (single property) and GetAll
// (every property) so the two can't drift out of sync on what a property
// actually contains.
void AppendStringVariant(DBusMessageIter* dict_iter, const char* key,
                        const char* value) {
  DBusMessageIter entry, variant;
  dbus_message_iter_open_container(dict_iter, DBUS_TYPE_DICT_ENTRY, nullptr,
                                   &entry);
  dbus_message_iter_append_basic(&entry, DBUS_TYPE_STRING, &key);
  dbus_message_iter_open_container(&entry, DBUS_TYPE_VARIANT, "s", &variant);
  dbus_message_iter_append_basic(&variant, DBUS_TYPE_STRING, &value);
  dbus_message_iter_close_container(&entry, &variant);
  dbus_message_iter_close_container(dict_iter, &entry);
}

void AppendBoolVariant(DBusMessageIter* dict_iter, const char* key,
                      dbus_bool_t value) {
  DBusMessageIter entry, variant;
  dbus_message_iter_open_container(dict_iter, DBUS_TYPE_DICT_ENTRY, nullptr,
                                   &entry);
  dbus_message_iter_append_basic(&entry, DBUS_TYPE_STRING, &key);
  dbus_message_iter_open_container(&entry, DBUS_TYPE_VARIANT, "b", &variant);
  dbus_message_iter_append_basic(&variant, DBUS_TYPE_BOOLEAN, &value);
  dbus_message_iter_close_container(&entry, &variant);
  dbus_message_iter_close_container(dict_iter, &entry);
}

void AppendObjectPathVariant(DBusMessageIter* dict_iter, const char* key,
                            const char* path) {
  DBusMessageIter entry, variant;
  dbus_message_iter_open_container(dict_iter, DBUS_TYPE_DICT_ENTRY, nullptr,
                                   &entry);
  dbus_message_iter_append_basic(&entry, DBUS_TYPE_STRING, &key);
  dbus_message_iter_open_container(&entry, DBUS_TYPE_VARIANT, "o", &variant);
  dbus_message_iter_append_basic(&variant, DBUS_TYPE_OBJECT_PATH, &path);
  dbus_message_iter_close_container(&entry, &variant);
  dbus_message_iter_close_container(dict_iter, &entry);
}

void WriteIconPixmapValue(DBusMessageIter* variant_iter,
                         const TrayState& tray) {
  DBusMessageIter arr, strct, byte_arr;
  dbus_message_iter_open_container(variant_iter, DBUS_TYPE_ARRAY, "(iiay)",
                                   &arr);
  if (!tray.icon_argb.empty()) {
    dbus_message_iter_open_container(&arr, DBUS_TYPE_STRUCT, nullptr, &strct);
    dbus_message_iter_append_basic(&strct, DBUS_TYPE_INT32, &tray.icon_w);
    dbus_message_iter_append_basic(&strct, DBUS_TYPE_INT32, &tray.icon_h);
    dbus_message_iter_open_container(&strct, DBUS_TYPE_ARRAY, "y", &byte_arr);
    const uint8_t* data = tray.icon_argb.data();
    dbus_message_iter_append_fixed_array(&byte_arr, DBUS_TYPE_BYTE, &data,
                                         static_cast<int>(tray.icon_argb.size()));
    dbus_message_iter_close_container(&strct, &byte_arr);
    dbus_message_iter_close_container(&arr, &strct);
  }
  dbus_message_iter_close_container(variant_iter, &arr);
}

// Writes ONE property's variant value directly into `iter` (used by Get,
// which replies with a bare variant, not a dict entry).
void WritePropertyVariant(DBusMessageIter* iter, const TrayState& tray,
                         const char* prop) {
  DBusMessageIter variant;
  if (strcmp(prop, "Category") == 0) {
    const char* v = "ApplicationStatus";
    dbus_message_iter_open_container(iter, DBUS_TYPE_VARIANT, "s", &variant);
    dbus_message_iter_append_basic(&variant, DBUS_TYPE_STRING, &v);
    dbus_message_iter_close_container(iter, &variant);
  } else if (strcmp(prop, "Id") == 0) {
    std::string v = std::to_string(tray.id);
    const char* cv = v.c_str();
    dbus_message_iter_open_container(iter, DBUS_TYPE_VARIANT, "s", &variant);
    dbus_message_iter_append_basic(&variant, DBUS_TYPE_STRING, &cv);
    dbus_message_iter_close_container(iter, &variant);
  } else if (strcmp(prop, "Title") == 0) {
    const char* v = tray.title.c_str();
    dbus_message_iter_open_container(iter, DBUS_TYPE_VARIANT, "s", &variant);
    dbus_message_iter_append_basic(&variant, DBUS_TYPE_STRING, &v);
    dbus_message_iter_close_container(iter, &variant);
  } else if (strcmp(prop, "Status") == 0) {
    const char* v = "Active";
    dbus_message_iter_open_container(iter, DBUS_TYPE_VARIANT, "s", &variant);
    dbus_message_iter_append_basic(&variant, DBUS_TYPE_STRING, &v);
    dbus_message_iter_close_container(iter, &variant);
  } else if (strcmp(prop, "IconName") == 0) {
    const char* v = tray.icon_name.c_str();
    dbus_message_iter_open_container(iter, DBUS_TYPE_VARIANT, "s", &variant);
    dbus_message_iter_append_basic(&variant, DBUS_TYPE_STRING, &v);
    dbus_message_iter_close_container(iter, &variant);
  } else if (strcmp(prop, "IconPixmap") == 0) {
    dbus_message_iter_open_container(iter, DBUS_TYPE_VARIANT, "a(iiay)",
                                     &variant);
    WriteIconPixmapValue(&variant, tray);
    dbus_message_iter_close_container(iter, &variant);
  } else if (strcmp(prop, "ItemIsMenu") == 0) {
    dbus_bool_t v = tray.menu_path.empty() ? FALSE : TRUE;
    dbus_message_iter_open_container(iter, DBUS_TYPE_VARIANT, "b", &variant);
    dbus_message_iter_append_basic(&variant, DBUS_TYPE_BOOLEAN, &v);
    dbus_message_iter_close_container(iter, &variant);
  } else if (strcmp(prop, "Menu") == 0) {
    const char* v = tray.menu_path.empty() ? "/" : tray.menu_path.c_str();
    dbus_message_iter_open_container(iter, DBUS_TYPE_VARIANT, "o", &variant);
    dbus_message_iter_append_basic(&variant, DBUS_TYPE_OBJECT_PATH, &v);
    dbus_message_iter_close_container(iter, &variant);
  }
}

DBusHandlerResult HandleObjectMessage(DBusConnection* conn, DBusMessage* msg,
                                     void* user_data) {
  int64_t id = static_cast<int64_t>(reinterpret_cast<intptr_t>(user_data));

  if (dbus_message_is_method_call(msg, "org.freedesktop.DBus.Properties",
                                  "Get")) {
    const char* iface = nullptr;
    const char* prop = nullptr;
    dbus_message_get_args(msg, nullptr, DBUS_TYPE_STRING, &iface,
                          DBUS_TYPE_STRING, &prop, DBUS_TYPE_INVALID);
    DBusMessage* reply = dbus_message_new_method_return(msg);
    DBusMessageIter iter;
    dbus_message_iter_init_append(reply, &iter);
    {
      std::lock_guard<std::mutex> lock(g_mtx);
      auto it = g_trays.find(id);
      if (it != g_trays.end() && prop) {
        WritePropertyVariant(&iter, it->second, prop);
      }
    }
    dbus_connection_send(conn, reply, nullptr);
    dbus_message_unref(reply);
    return DBUS_HANDLER_RESULT_HANDLED;
  }

  if (dbus_message_is_method_call(msg, "org.freedesktop.DBus.Properties",
                                  "GetAll")) {
    DBusMessage* reply = dbus_message_new_method_return(msg);
    DBusMessageIter iter, dict;
    dbus_message_iter_init_append(reply, &iter);
    dbus_message_iter_open_container(&iter, DBUS_TYPE_ARRAY, "{sv}", &dict);
    {
      std::lock_guard<std::mutex> lock(g_mtx);
      auto it = g_trays.find(id);
      if (it != g_trays.end()) {
        const TrayState& tray = it->second;
        AppendStringVariant(&dict, "Category", "ApplicationStatus");
        std::string idstr = std::to_string(tray.id);
        AppendStringVariant(&dict, "Id", idstr.c_str());
        AppendStringVariant(&dict, "Title", tray.title.c_str());
        AppendStringVariant(&dict, "Status", "Active");
        AppendStringVariant(&dict, "IconName", tray.icon_name.c_str());
        {
          DBusMessageIter entry, variant;
          dbus_message_iter_open_container(&dict, DBUS_TYPE_DICT_ENTRY,
                                           nullptr, &entry);
          const char* key = "IconPixmap";
          dbus_message_iter_append_basic(&entry, DBUS_TYPE_STRING, &key);
          dbus_message_iter_open_container(&entry, DBUS_TYPE_VARIANT,
                                           "a(iiay)", &variant);
          WriteIconPixmapValue(&variant, tray);
          dbus_message_iter_close_container(&entry, &variant);
          dbus_message_iter_close_container(&dict, &entry);
        }
        AppendBoolVariant(&dict, "ItemIsMenu", tray.menu_path.empty() ? FALSE : TRUE);
        AppendObjectPathVariant(&dict, "Menu",
                                tray.menu_path.empty() ? "/" : tray.menu_path.c_str());
      }
    }
    dbus_message_iter_close_container(&iter, &dict);
    dbus_connection_send(conn, reply, nullptr);
    dbus_message_unref(reply);
    return DBUS_HANDLER_RESULT_HANDLED;
  }

  // Activate(x, y) -- the spec's "user clicked the icon" method. Only
  // fires bunium-tray-click when click delivery was opted into (matches
  // mac's bunium_system_tray_set_click gate).
  if (dbus_message_is_method_call(msg, "org.kde.StatusNotifierItem",
                                  "Activate") ||
      dbus_message_is_method_call(msg, "org.kde.StatusNotifierItem",
                                  "SecondaryActivate")) {
    bool enabled = false;
    {
      std::lock_guard<std::mutex> lock(g_mtx);
      auto it = g_trays.find(id);
      if (it != g_trays.end()) enabled = it->second.click_enabled;
    }
    if (enabled) {
      char buf[64];
      snprintf(buf, sizeof(buf), "{\"id\":%lld}", (long long)id);
      PushSystemEvent("bunium-tray-click", buf);
    }
    DBusMessage* reply = dbus_message_new_method_return(msg);
    dbus_connection_send(conn, reply, nullptr);
    dbus_message_unref(reply);
    return DBUS_HANDLER_RESULT_HANDLED;
  }

  if (dbus_message_is_method_call(msg, "org.kde.StatusNotifierItem",
                                  "ContextMenu") ||
      dbus_message_is_method_call(msg, "org.kde.StatusNotifierItem",
                                  "Scroll")) {
    // ContextMenu/Scroll are not part of the dbusmenu-attach flow -- a
    // panel that already fetched Menu/ItemIsMenu renders the dbusmenu
    // tree itself via GetLayout/AboutToShow (handled entirely inside
    // libdbusmenu-glib's own D-Bus object, not this one). Acknowledge and
    // no-op here rather than leaving the caller hanging without a reply.
    DBusMessage* reply = dbus_message_new_method_return(msg);
    dbus_connection_send(conn, reply, nullptr);
    dbus_message_unref(reply);
    return DBUS_HANDLER_RESULT_HANDLED;
  }

  if (dbus_message_is_method_call(msg, "org.freedesktop.DBus.Introspectable",
                                  "Introspect")) {
    static const char* kXml =
        "<node><interface name=\"org.kde.StatusNotifierItem\">"
        "<method name=\"Activate\"><arg type=\"i\"/><arg type=\"i\"/></method>"
        "<method name=\"SecondaryActivate\"><arg type=\"i\"/><arg type=\"i\"/></method>"
        "<method name=\"ContextMenu\"><arg type=\"i\"/><arg type=\"i\"/></method>"
        "<method name=\"Scroll\"><arg type=\"i\"/><arg type=\"s\"/></method>"
        "<property name=\"Category\" type=\"s\" access=\"read\"/>"
        "<property name=\"Id\" type=\"s\" access=\"read\"/>"
        "<property name=\"Title\" type=\"s\" access=\"read\"/>"
        "<property name=\"Status\" type=\"s\" access=\"read\"/>"
        "<property name=\"IconName\" type=\"s\" access=\"read\"/>"
        "<property name=\"IconPixmap\" type=\"a(iiay)\" access=\"read\"/>"
        "<property name=\"ItemIsMenu\" type=\"b\" access=\"read\"/>"
        "<property name=\"Menu\" type=\"o\" access=\"read\"/>"
        "</interface></node>";
    DBusMessage* reply = dbus_message_new_method_return(msg);
    dbus_message_append_args(reply, DBUS_TYPE_STRING, &kXml, DBUS_TYPE_INVALID);
    dbus_connection_send(conn, reply, nullptr);
    dbus_message_unref(reply);
    return DBUS_HANDLER_RESULT_HANDLED;
  }

  return DBUS_HANDLER_RESULT_NOT_YET_HANDLED;
}


// Recursively serializes one DbusmenuMenuitem (and its children) into an
// already-open destination iterator, as the com.canonical.dbusmenu wire
// format's (ia{sv}av) layout struct: (id, {property dict}, [child
// variants, each itself a (ia{sv}av)]). `dest` must already be positioned
// to accept a STRUCT container (either the reply's top-level iter for the
// root, or an open DBUS_TYPE_VARIANT container for a child -- GetLayout's
// own children array is `av`, array-of-variant, each variant wrapping
// another full layout struct, hence the recursion opens a variant first
// for every child before recursing).
void SerializeMenuItem(DBusMessageIter* dest, DbusmenuMenuitem* item) {
  DBusMessageIter strct;
  dbus_message_iter_open_container(dest, DBUS_TYPE_STRUCT, nullptr, &strct);

  int32_t id = dbusmenu_menuitem_get_id(item);
  dbus_message_iter_append_basic(&strct, DBUS_TYPE_INT32, &id);

  DBusMessageIter props;
  dbus_message_iter_open_container(&strct, DBUS_TYPE_ARRAY, "{sv}", &props);
  const gchar* type =
      dbusmenu_menuitem_property_get(item, DBUSMENU_MENUITEM_PROP_TYPE);
  if (type) AppendStringVariant(&props, "type", type);
  const gchar* label =
      dbusmenu_menuitem_property_get(item, DBUSMENU_MENUITEM_PROP_LABEL);
  if (label) AppendStringVariant(&props, "label", label);
  AppendBoolVariant(&props, "visible", TRUE);
  AppendBoolVariant(&props, "enabled", TRUE);
  GList* children = dbusmenu_menuitem_get_children(item);
  if (children) {
    // The wire-protocol convention every dbusmenu client (including
    // GNOME Shell's AppIndicator extension) uses to render a node as a
    // submenu rather than a flat item -- see bunium_system_menu_linux.cc's
    // add_submenu comment.
    AppendStringVariant(&props, "children-display", "submenu");
  }
  dbus_message_iter_close_container(&strct, &props);

  DBusMessageIter kids;
  dbus_message_iter_open_container(&strct, DBUS_TYPE_ARRAY, "v", &kids);
  for (GList* l = children; l; l = l->next) {
    DbusmenuMenuitem* child = static_cast<DbusmenuMenuitem*>(l->data);
    DBusMessageIter variant;
    dbus_message_iter_open_container(&kids, DBUS_TYPE_VARIANT, "(ia{sv}av)",
                                     &variant);
    SerializeMenuItem(&variant, child);
    dbus_message_iter_close_container(&kids, &variant);
  }
  dbus_message_iter_close_container(&strct, &kids);

  dbus_message_iter_close_container(dest, &strct);
}

// Serves com.canonical.dbusmenu by hand on the tray's own object/
// connection -- NOT via libdbusmenu-glib's DbusmenuServer, see the file
// header for why that was tried first and rejected (wrong D-Bus
// connection/bus-name pairing, confirmed broken by a real end-to-end
// check). Registered as a second object path per tray (/MenuBar/<id>)
// alongside the SNI object (/StatusNotifierItem/<id>), same
// DBusConnection.
DBusHandlerResult HandleMenuObjectMessage(DBusConnection* conn,
                                         DBusMessage* msg, void* user_data) {
  int64_t id = static_cast<int64_t>(reinterpret_cast<intptr_t>(user_data));

  if (dbus_message_is_method_call(msg, "com.canonical.dbusmenu",
                                  "GetLayout")) {
    int32_t parent_id = 0;
    DBusMessageIter args;
    dbus_message_iter_init(msg, &args);
    dbus_message_iter_get_basic(&args, &parent_id);
    // recursionDepth/propertyNames (args 2 and 3) are accepted but not
    // honored -- v1 always serializes the full subtree with a fixed
    // property set, matching every property this tray's menus can
    // actually carry (see bunium_system_menu_linux.cc); a real client
    // asking for a depth-limited or property-filtered view still gets a
    // strict superset of what it asked for, which every dbusmenu client
    // tolerates (unrequested properties are just ignored).
    DbusmenuMenuitem* root = nullptr;
    DbusmenuMenuitem* target = nullptr;
    {
      std::lock_guard<std::mutex> lock(g_mtx);
      auto it = g_trays.find(id);
      if (it != g_trays.end()) root = it->second.menu_root;
    }
    if (root) {
      target = (parent_id == dbusmenu_menuitem_get_id(root))
                  ? root
                  : dbusmenu_menuitem_find_id(root, parent_id);
    }
    DBusMessage* reply = dbus_message_new_method_return(msg);
    DBusMessageIter iter;
    dbus_message_iter_init_append(reply, &iter);
    uint32_t revision = 1;
    dbus_message_iter_append_basic(&iter, DBUS_TYPE_UINT32, &revision);
    if (target) {
      SerializeMenuItem(&iter, target);
    } else {
      // No menu (or bad parentId) -- an empty id-0/no-children node is a
      // valid, harmless "nothing to show" layout rather than an error
      // reply, matching how a real dbusmenu server responds to a
      // menu-less/racing-teardown query.
      DbusmenuMenuitem* empty = dbusmenu_menuitem_new_with_id(parent_id);
      SerializeMenuItem(&iter, empty);
      g_object_unref(empty);
    }
    dbus_connection_send(conn, reply, nullptr);
    dbus_message_unref(reply);
    return DBUS_HANDLER_RESULT_HANDLED;
  }

  if (dbus_message_is_method_call(msg, "com.canonical.dbusmenu", "Event")) {
    DBusMessageIter args;
    dbus_message_iter_init(msg, &args);
    int32_t item_id = 0;
    dbus_message_iter_get_basic(&args, &item_id);
    dbus_message_iter_next(&args);
    const char* event_id = "";
    dbus_message_iter_get_basic(&args, &event_id);
    // "clicked" is the real click-delivery event id every dbusmenu client
    // (GNOME Shell's AppIndicator extension included) sends on selection
    // -- other event ids exist (opened/closed, hover) but v1 only cares
    // about the one that maps to Menu.onItemClicked().
    if (event_id && strcmp(event_id, "clicked") == 0) {
      char buf[64];
      snprintf(buf, sizeof(buf), "{\"id\":%d}", (int)item_id);
      PushSystemEvent("bunium-menu-click", buf);
    }
    DBusMessage* reply = dbus_message_new_method_return(msg);
    dbus_connection_send(conn, reply, nullptr);
    dbus_message_unref(reply);
    return DBUS_HANDLER_RESULT_HANDLED;
  }

  if (dbus_message_is_method_call(msg, "com.canonical.dbusmenu",
                                  "AboutToShow")) {
    // v1 menus are static once attached (no live "about to show" rebuild
    // hook exposed to JS yet) -- always answer "no update needed", which
    // every dbusmenu client treats as "render what GetLayout already gave
    // you".
    DBusMessage* reply = dbus_message_new_method_return(msg);
    dbus_bool_t need_update = FALSE;
    dbus_message_append_args(reply, DBUS_TYPE_BOOLEAN, &need_update,
                             DBUS_TYPE_INVALID);
    dbus_connection_send(conn, reply, nullptr);
    dbus_message_unref(reply);
    return DBUS_HANDLER_RESULT_HANDLED;
  }

  if (dbus_message_is_method_call(msg, "org.freedesktop.DBus.Properties",
                                  "Get") ||
      dbus_message_is_method_call(msg, "org.freedesktop.DBus.Properties",
                                  "GetAll")) {
    // The dbusmenu root object's own properties (Version/TextDirection/
    // Status/IconThemePath) -- fixed values, v1 has no per-menu text
    // direction or icon-theme-path override.
    DBusMessage* reply = dbus_message_new_method_return(msg);
    DBusMessageIter iter, dict;
    dbus_message_iter_init_append(reply, &iter);
    if (dbus_message_has_member(msg, "GetAll")) {
      dbus_message_iter_open_container(&iter, DBUS_TYPE_ARRAY, "{sv}", &dict);
      uint32_t version = 3;
      {
        DBusMessageIter entry, variant;
        dbus_message_iter_open_container(&dict, DBUS_TYPE_DICT_ENTRY,
                                         nullptr, &entry);
        const char* key = "Version";
        dbus_message_iter_append_basic(&entry, DBUS_TYPE_STRING, &key);
        dbus_message_iter_open_container(&entry, DBUS_TYPE_VARIANT, "u",
                                         &variant);
        dbus_message_iter_append_basic(&variant, DBUS_TYPE_UINT32, &version);
        dbus_message_iter_close_container(&entry, &variant);
        dbus_message_iter_close_container(&dict, &entry);
      }
      AppendStringVariant(&dict, "TextDirection", "ltr");
      AppendStringVariant(&dict, "Status", "normal");
      dbus_message_iter_close_container(&iter, &dict);
    } else {
      const char* prop = nullptr;
      dbus_message_get_args(msg, nullptr, DBUS_TYPE_STRING, nullptr,
                            DBUS_TYPE_STRING, &prop, DBUS_TYPE_INVALID);
      DBusMessageIter variant;
      if (prop && strcmp(prop, "Version") == 0) {
        uint32_t version = 3;
        dbus_message_iter_open_container(&iter, DBUS_TYPE_VARIANT, "u",
                                         &variant);
        dbus_message_iter_append_basic(&variant, DBUS_TYPE_UINT32, &version);
        dbus_message_iter_close_container(&iter, &variant);
      } else if (prop && strcmp(prop, "TextDirection") == 0) {
        const char* v = "ltr";
        dbus_message_iter_open_container(&iter, DBUS_TYPE_VARIANT, "s",
                                         &variant);
        dbus_message_iter_append_basic(&variant, DBUS_TYPE_STRING, &v);
        dbus_message_iter_close_container(&iter, &variant);
      } else if (prop && strcmp(prop, "Status") == 0) {
        const char* v = "normal";
        dbus_message_iter_open_container(&iter, DBUS_TYPE_VARIANT, "s",
                                         &variant);
        dbus_message_iter_append_basic(&variant, DBUS_TYPE_STRING, &v);
        dbus_message_iter_close_container(&iter, &variant);
      }
    }
    dbus_connection_send(conn, reply, nullptr);
    dbus_message_unref(reply);
    return DBUS_HANDLER_RESULT_HANDLED;
  }

  if (dbus_message_is_method_call(msg, "org.freedesktop.DBus.Introspectable",
                                  "Introspect")) {
    static const char* kXml =
        "<node><interface name=\"com.canonical.dbusmenu\">"
        "<method name=\"GetLayout\">"
        "<arg type=\"i\" name=\"parentId\" direction=\"in\"/>"
        "<arg type=\"i\" name=\"recursionDepth\" direction=\"in\"/>"
        "<arg type=\"as\" name=\"propertyNames\" direction=\"in\"/>"
        "<arg type=\"u\" name=\"revision\" direction=\"out\"/>"
        "<arg type=\"(ia{sv}av)\" name=\"layout\" direction=\"out\"/>"
        "</method>"
        "<method name=\"Event\">"
        "<arg type=\"i\" name=\"id\" direction=\"in\"/>"
        "<arg type=\"s\" name=\"eventId\" direction=\"in\"/>"
        "<arg type=\"v\" name=\"data\" direction=\"in\"/>"
        "<arg type=\"u\" name=\"timestamp\" direction=\"in\"/>"
        "</method>"
        "<method name=\"AboutToShow\">"
        "<arg type=\"i\" name=\"id\" direction=\"in\"/>"
        "<arg type=\"b\" name=\"needUpdate\" direction=\"out\"/>"
        "</method>"
        "<property name=\"Version\" type=\"u\" access=\"read\"/>"
        "<property name=\"TextDirection\" type=\"s\" access=\"read\"/>"
        "<property name=\"Status\" type=\"s\" access=\"read\"/>"
        "</interface></node>";
    DBusMessage* reply = dbus_message_new_method_return(msg);
    dbus_message_append_args(reply, DBUS_TYPE_STRING, &kXml, DBUS_TYPE_INVALID);
    dbus_connection_send(conn, reply, nullptr);
    dbus_message_unref(reply);
    return DBUS_HANDLER_RESULT_HANDLED;
  }

  return DBUS_HANDLER_RESULT_NOT_YET_HANDLED;
}

const DBusObjectPathVTable kMenuVTable = {
    nullptr,                  // unregister_function
    HandleMenuObjectMessage,  // message_function
    nullptr, nullptr, nullptr, nullptr,
};

const DBusObjectPathVTable kVTable = {
    nullptr,               // unregister_function
    HandleObjectMessage,   // message_function
    nullptr, nullptr, nullptr, nullptr,
};

void DispatchLoop() {
  while (g_conn && dbus_connection_read_write_dispatch(g_conn, 200)) {
  }
}

bool EnsureConnection() {
  std::lock_guard<std::mutex> lock(g_mtx);
  if (g_connect_attempted) return g_conn != nullptr;
  g_connect_attempted = true;

  dbus_threads_init_default();
  DBusError err;
  dbus_error_init(&err);
  g_conn = dbus_bus_get_private(DBUS_BUS_SESSION, &err);
  if (dbus_error_is_set(&err)) {
    fprintf(stderr, "[bunium] tray: no session D-Bus (%s), tray disabled\n",
            err.message);
    dbus_error_free(&err);
    g_conn = nullptr;
    return false;
  }
  dbus_connection_set_exit_on_disconnect(g_conn, FALSE);
  std::thread(DispatchLoop).detach();
  return true;
}

// Best-effort, fire-and-forget registration with the watcher -- if none is
// running (this dev container has none), the call simply fails and the
// item stays unregistered but harmless, same degrade-gracefully contract
// as everything else in this file. dbus_connection_send (not *_and_block)
// throughout this file -- see the RequestName comment below for why.
void RegisterWithWatcher(const std::string& bus_name) {
  DBusMessage* msg = dbus_message_new_method_call(
      "org.kde.StatusNotifierWatcher", "/StatusNotifierWatcher",
      "org.kde.StatusNotifierWatcher", "RegisterStatusNotifierItem");
  if (!msg) return;
  const char* name = bus_name.c_str();
  dbus_message_append_args(msg, DBUS_TYPE_STRING, &name, DBUS_TYPE_INVALID);
  dbus_connection_send(g_conn, msg, nullptr);
  dbus_message_unref(msg);
}

// Asks the bus daemon for a well-known name via a plain non-blocking send,
// NOT dbus_bus_request_name() -- a real deadlock was hit here first:
// dbus_bus_request_name() is a *_and_block-style call that does its own
// synchronous read loop waiting for the RequestName reply, which races the
// background DispatchLoop thread also reading/dispatching the same
// connection (confirmed via a hang reproducing every time, fixed by
// switching to fire-and-forget send here -- we don't need the reply
// synchronously anyway, same spirit as RegisterWithWatcher above).
void RequestNameAsync(const std::string& bus_name) {
  DBusMessage* msg = dbus_message_new_method_call(
      "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus",
      "RequestName");
  if (!msg) return;
  const char* name = bus_name.c_str();
  uint32_t flags = DBUS_NAME_FLAG_DO_NOT_QUEUE;
  dbus_message_append_args(msg, DBUS_TYPE_STRING, &name, DBUS_TYPE_UINT32,
                           &flags, DBUS_TYPE_INVALID);
  dbus_connection_send(g_conn, msg, nullptr);
  dbus_message_unref(msg);
}

}  // namespace

extern "C" __attribute__((visibility("default"))) void*
bunium_system_tray_create(const char* title) {
  if (!EnsureConnection()) return nullptr;

  int64_t id;
  {
    std::lock_guard<std::mutex> lock(g_mtx);
    id = g_next_id++;
    TrayState tray;
    tray.id = id;
    tray.title = title ? title : "";
    g_trays[id] = tray;
  }

  std::string path = ObjectPathFor(id);
  dbus_connection_try_register_object_path(
      g_conn, path.c_str(), &kVTable,
      reinterpret_cast<void*>(static_cast<intptr_t>(id)), nullptr);

  std::string bus_name = BusNameFor(id);
  RequestNameAsync(bus_name);
  RegisterWithWatcher(bus_name);

  return reinterpret_cast<void*>(static_cast<intptr_t>(id));
}

extern "C" __attribute__((visibility("default"))) void
bunium_system_tray_set_title(void* tray_handle, const char* title) {
  int64_t id = static_cast<int64_t>(reinterpret_cast<intptr_t>(tray_handle));
  std::lock_guard<std::mutex> lock(g_mtx);
  auto it = g_trays.find(id);
  if (it != g_trays.end()) it->second.title = title ? title : "";
}

// is_template is macOS-idiom-only (an NSImage "template" tints itself to
// match the menu-bar's current appearance) -- ignored here, same
// "platform interprets its own idiom" precedent as everywhere else in
// this file; SNI has no equivalent concept and every panel does its own
// icon-theme-aware rendering regardless.
extern "C" __attribute__((visibility("default"))) void
bunium_system_tray_set_icon(void* tray_handle, const char* image_path,
                            int32_t /*is_template*/) {
  if (!image_path) return;
  int32_t w = 0, h = 0;
  std::vector<uint8_t> argb;
  if (!DecodeIconFile(image_path, &w, &h, &argb)) return;

  int64_t id = static_cast<int64_t>(reinterpret_cast<intptr_t>(tray_handle));
  std::string path;
  {
    std::lock_guard<std::mutex> lock(g_mtx);
    auto it = g_trays.find(id);
    if (it == g_trays.end()) return;
    it->second.icon_w = w;
    it->second.icon_h = h;
    it->second.icon_argb = std::move(argb);
    path = ObjectPathFor(id);
  }

  if (g_conn) {
    DBusMessage* sig = dbus_message_new_signal(
        path.c_str(), "org.kde.StatusNotifierItem", "NewIcon");
    if (sig) {
      dbus_connection_send(g_conn, sig, nullptr);
      dbus_message_unref(sig);
    }
  }
}

extern "C" __attribute__((visibility("default"))) void
bunium_system_tray_set_symbol(void* tray_handle, const char* symbol_name) {
  int64_t id = static_cast<int64_t>(reinterpret_cast<intptr_t>(tray_handle));
  std::lock_guard<std::mutex> lock(g_mtx);
  auto it = g_trays.find(id);
  if (it != g_trays.end()) it->second.icon_name = symbol_name ? symbol_name : "";
}

extern "C" __attribute__((visibility("default"))) void
bunium_system_tray_set_click(void* tray_handle, int32_t enabled) {
  int64_t id = static_cast<int64_t>(reinterpret_cast<intptr_t>(tray_handle));
  std::lock_guard<std::mutex> lock(g_mtx);
  auto it = g_trays.find(id);
  if (it != g_trays.end()) it->second.click_enabled = enabled != 0;
}

extern "C" __attribute__((visibility("default"))) int64_t
bunium_system_tray_get_id(void* tray_handle) {
  return static_cast<int64_t>(reinterpret_cast<intptr_t>(tray_handle));
}

// Attaches a menu tree (menu_handle is a DbusmenuMenuitem* root built by
// bunium_system_menu_linux.cc's bunium_system_menu_create/add_item/
// add_submenu/add_separator) to this tray. Registers /MenuBar/<id> on the
// tray's OWN DBusConnection (served by HandleMenuObjectMessage above) and
// flips the SNI Menu/ItemIsMenu properties to point at it -- see the file
// header for why this (not libdbusmenu-glib's DbusmenuServer, and not an
// in-window menu bar) is the real, wired-up Linux menu path. Called on
// the same thread as every other exported function here (never the
// background DispatchLoop thread) -- see bunium_system_menu_linux.cc's
// header for the GLib-threading hazard this avoids.
extern "C" __attribute__((visibility("default"))) void
bunium_system_tray_set_menu(void* tray_handle, void* menu_handle) {
  if (!menu_handle || !g_conn) return;
  int64_t id = static_cast<int64_t>(reinterpret_cast<intptr_t>(tray_handle));
  DbusmenuMenuitem* root = static_cast<DbusmenuMenuitem*>(menu_handle);

  std::string menu_path = MenuObjectPathFor(id);
  std::lock_guard<std::mutex> lock(g_mtx);
  auto it = g_trays.find(id);
  if (it == g_trays.end()) return;

  // Idempotent: dbus_connection_try_register_object_path is a no-op (with
  // an error, ignored) if this path is already registered -- calling
  // setMenu() more than once on the same tray (e.g. to swap in a new
  // Menu) just re-registers the same path with the same handler, which is
  // harmless; only menu_root actually needs updating on repeat calls.
  dbus_connection_try_register_object_path(
      g_conn, menu_path.c_str(), &kMenuVTable,
      reinterpret_cast<void*>(static_cast<intptr_t>(id)), nullptr);

  it->second.menu_root = root;
  it->second.menu_path = menu_path;
}

extern "C" __attribute__((visibility("default"))) void
bunium_system_tray_destroy(void* tray_handle) {
  int64_t id = static_cast<int64_t>(reinterpret_cast<intptr_t>(tray_handle));
  if (!g_conn) return;
  std::string path = ObjectPathFor(id);
  dbus_connection_unregister_object_path(g_conn, path.c_str());
  dbus_connection_unregister_object_path(g_conn, MenuObjectPathFor(id).c_str());
  // Async ReleaseName, not dbus_bus_release_name() -- same *_and_block
  // deadlock-with-the-dispatch-thread hazard as RequestNameAsync's comment
  // explains for creation; ReleaseName is fire-and-forget for the same
  // reason (we don't need its reply, and process exit releases the name
  // anyway if this never lands).
  std::string bus_name = BusNameFor(id);
  DBusMessage* msg = dbus_message_new_method_call(
      "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus",
      "ReleaseName");
  if (msg) {
    const char* name = bus_name.c_str();
    dbus_message_append_args(msg, DBUS_TYPE_STRING, &name, DBUS_TYPE_INVALID);
    dbus_connection_send(g_conn, msg, nullptr);
    dbus_message_unref(msg);
  }
  std::lock_guard<std::mutex> lock(g_mtx);
  // menu_root is a DbusmenuMenuitem* owned by the JS-side Menu handle, not
  // by the tray -- never unref it here.
  g_trays.erase(id);
}
