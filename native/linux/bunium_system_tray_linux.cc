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
// v1 scope: IconName only (a freedesktop icon-theme name, set via
// bunium_system_tray_set_symbol -- matches how the mac SF-Symbol names
// passed by cross-platform example code won't resolve to anything real on
// Linux either, same "platform interprets its own idiom" precedent
// Windows already established for setSymbol). bunium_system_tray_set_icon
// (arbitrary image file path) is NOT implemented -- IconPixmap would need
// decoding the file into raw ARGB32 via GdkPixbuf and building the SNI
// a(iiay) variant, real work not attempted this pass; it logs a warning
// and no-ops rather than silently doing nothing. set_menu is a no-op
// because native menu creation itself is stub-only on Linux (see PLAN.md
// Phase 6) -- there is never a real menu handle to attach.
#include <dbus/dbus.h>

#include <unistd.h>

#include <cstdint>
#include <cstdio>
#include <cstring>
#include <mutex>
#include <string>
#include <thread>
#include <unordered_map>

#include "bunium_system_events_linux.h"

namespace {

struct TrayState {
  int64_t id;
  std::string title;
  std::string icon_name;
  bool click_enabled = false;
};

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
  } else if (strcmp(prop, "ItemIsMenu") == 0) {
    dbus_bool_t v = FALSE;
    dbus_message_iter_open_container(iter, DBUS_TYPE_VARIANT, "b", &variant);
    dbus_message_iter_append_basic(&variant, DBUS_TYPE_BOOLEAN, &v);
    dbus_message_iter_close_container(iter, &variant);
  } else if (strcmp(prop, "Menu") == 0) {
    const char* v = "/";
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
        AppendBoolVariant(&dict, "ItemIsMenu", FALSE);
        AppendObjectPathVariant(&dict, "Menu", "/");
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
    // No real menu handle exists yet (native menu is stub-only on Linux,
    // see file header) -- acknowledge and no-op rather than leaving the
    // caller hanging without a reply.
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

extern "C" __attribute__((visibility("default"))) void
bunium_system_tray_set_icon(void* /*tray_handle*/, const char* image_path,
                            int32_t /*is_template*/) {
  fprintf(stderr,
         "[bunium] tray: setIcon(%s) not supported on Linux yet -- use "
         "setSymbol with a freedesktop icon-theme name instead\n",
         image_path ? image_path : "");
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

// No-op: native menu creation is stub-only on Linux (see file header), so
// there is never a real menu handle to attach.
extern "C" __attribute__((visibility("default"))) void
bunium_system_tray_set_menu(void* /*tray_handle*/, void* /*menu_handle*/) {}

extern "C" __attribute__((visibility("default"))) void
bunium_system_tray_destroy(void* tray_handle) {
  int64_t id = static_cast<int64_t>(reinterpret_cast<intptr_t>(tray_handle));
  if (!g_conn) return;
  std::string path = ObjectPathFor(id);
  dbus_connection_unregister_object_path(g_conn, path.c_str());
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
  g_trays.erase(id);
}
