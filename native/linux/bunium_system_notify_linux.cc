// Phase 5: OS notifications for bunium on Linux, via the freedesktop.org
// org.freedesktop.Notifications D-Bus service (the de-facto standard
// notification daemon interface across GNOME/KDE/etc -- no GTK/libnotify
// dependency needed, raw libdbus-1 is enough). Own translation unit, same
// vertical-slice pattern as mac's bunium_system_notify_mac.mm.
//
// Never blocks the JS pump: the Notify method call is sent
// non-blocking (dbus_connection_send_with_reply, not the *_and_block
// variant) and a background thread owns the connection's read/write/
// dispatch loop for its whole lifetime, matching the "detached worker
// thread" pattern native/win/bunium_system_win.cc already uses for its own
// never-block-the-pump dialogs.
//
// Click delivery: bunium_system_notify's `id` param is bunium's own
// app-assigned identity (matches every other platform's ABI). The D-Bus
// Notify call replies asynchronously with the daemon's own UINT32
// notification id, which is what ActionInvoked/NotificationClosed signals
// key on -- so a dbus-id -> app-id map is kept to translate incoming
// signals back into the id JS actually knows about.
#include <dbus/dbus.h>

#include <cstdint>
#include <cstdio>
#include <cstring>
#include <mutex>
#include <string>
#include <thread>
#include <unordered_map>

#include "bunium_system_events_linux.h"

namespace {

std::mutex g_mtx;
DBusConnection* g_conn = nullptr;
bool g_connect_attempted = false;
bool g_dispatch_started = false;
std::unordered_map<uint32_t, int32_t> g_dbus_id_to_app_id;

// DBusPendingCall completion: pulls the daemon-assigned notification id out
// of the Notify reply and remembers it against the app-assigned id passed
// in as user_data, so a later ActionInvoked signal (keyed by the daemon id)
// can be translated back to the id JS is expecting.
void OnNotifyReply(DBusPendingCall* pending, void* user_data) {
  int32_t app_id = static_cast<int32_t>(reinterpret_cast<intptr_t>(user_data));
  DBusMessage* reply = dbus_pending_call_steal_reply(pending);
  if (reply) {
    if (dbus_message_get_type(reply) == DBUS_MESSAGE_TYPE_METHOD_RETURN) {
      uint32_t dbus_id = 0;
      if (dbus_message_get_args(reply, nullptr, DBUS_TYPE_UINT32, &dbus_id,
                                 DBUS_TYPE_INVALID)) {
        std::lock_guard<std::mutex> lock(g_mtx);
        g_dbus_id_to_app_id[dbus_id] = app_id;
      }
    }
    dbus_message_unref(reply);
  }
  dbus_pending_call_unref(pending);
}

// Filter callback for every signal on the connection -- picks out
// org.freedesktop.Notifications.ActionInvoked ("default" action key is the
// spec's convention for "the user clicked the notification body itself",
// which is what bunium's single notify-click event models across every
// platform).
DBusHandlerResult HandleSignal(DBusConnection*, DBusMessage* msg, void*) {
  if (!dbus_message_is_signal(msg, "org.freedesktop.Notifications",
                              "ActionInvoked")) {
    return DBUS_HANDLER_RESULT_NOT_YET_HANDLED;
  }
  uint32_t dbus_id = 0;
  const char* action_key = nullptr;
  if (!dbus_message_get_args(msg, nullptr, DBUS_TYPE_UINT32, &dbus_id,
                             DBUS_TYPE_STRING, &action_key,
                             DBUS_TYPE_INVALID)) {
    return DBUS_HANDLER_RESULT_NOT_YET_HANDLED;
  }
  int32_t app_id = 0;
  bool found = false;
  {
    std::lock_guard<std::mutex> lock(g_mtx);
    auto it = g_dbus_id_to_app_id.find(dbus_id);
    if (it != g_dbus_id_to_app_id.end()) {
      app_id = it->second;
      found = true;
    }
  }
  if (found) {
    char buf[64];
    snprintf(buf, sizeof(buf), "{\"id\":%d}", app_id);
    PushSystemEvent("bunium-notification-click", buf);
  }
  return DBUS_HANDLER_RESULT_HANDLED;
}

void DispatchLoop() {
  // read_write_dispatch both flushes queued outgoing sends (the Notify
  // call) and delivers incoming signals/replies to the filter/pending-call
  // callbacks above -- one loop covers both directions. 200ms timeout keeps
  // this thread responsive to process exit without busy-spinning.
  while (g_conn && dbus_connection_read_write_dispatch(g_conn, 200)) {
  }
}

// Lazily connects to the session bus and starts the background dispatch
// thread. Returns false (leaving notify a silent no-op) if no session bus
// is reachable -- expected in a bare container/CI environment with no
// DBUS_SESSION_BUS_ADDRESS, same "degrade gracefully" contract mac's
// UNUserNotificationCenter try/catch uses for its own unsupported-context
// case.
bool EnsureConnection() {
  std::lock_guard<std::mutex> lock(g_mtx);
  if (g_connect_attempted) return g_conn != nullptr;
  g_connect_attempted = true;

  dbus_threads_init_default();

  DBusError err;
  dbus_error_init(&err);
  g_conn = dbus_bus_get_private(DBUS_BUS_SESSION, &err);
  if (dbus_error_is_set(&err)) {
    fprintf(stderr, "[bunium] notify: no session D-Bus (%s), notifications disabled\n",
            err.message);
    dbus_error_free(&err);
    g_conn = nullptr;
    return false;
  }
  dbus_connection_set_exit_on_disconnect(g_conn, FALSE);

  dbus_bus_add_match(g_conn,
                     "type='signal',interface='org.freedesktop.Notifications'",
                     &err);
  if (dbus_error_is_set(&err)) dbus_error_free(&err);
  dbus_connection_add_filter(g_conn, HandleSignal, nullptr, nullptr);

  std::thread(DispatchLoop).detach();
  g_dispatch_started = true;
  return true;
}

}  // namespace

extern "C" __attribute__((visibility("default"))) void bunium_system_notify(
    const char* title, const char* body, int32_t id) {
  if (!EnsureConnection()) return;

  DBusMessage* msg = dbus_message_new_method_call(
      "org.freedesktop.Notifications", "/org/freedesktop/Notifications",
      "org.freedesktop.Notifications", "Notify");
  if (!msg) return;

  const char* app_name = "bunium";
  uint32_t replaces_id = 0;
  const char* app_icon = "";
  const char* summary = title ? title : "";
  const char* body_str = body ? body : "";
  int32_t expire_timeout = -1;  // daemon default

  DBusMessageIter iter;
  dbus_message_iter_init_append(msg, &iter);
  dbus_message_iter_append_basic(&iter, DBUS_TYPE_STRING, &app_name);
  dbus_message_iter_append_basic(&iter, DBUS_TYPE_UINT32, &replaces_id);
  dbus_message_iter_append_basic(&iter, DBUS_TYPE_STRING, &app_icon);
  dbus_message_iter_append_basic(&iter, DBUS_TYPE_STRING, &summary);
  dbus_message_iter_append_basic(&iter, DBUS_TYPE_STRING, &body_str);

  // actions: as[] -- empty array of strings. A non-empty "default" action
  // would need an explicit entry in some daemons to fire ActionInvoked on a
  // plain click; leaving it empty matches most modern daemons' behavior of
  // still emitting ActionInvoked("default") for a body click regardless.
  DBusMessageIter actions_iter;
  dbus_message_iter_open_container(&iter, DBUS_TYPE_ARRAY, "s", &actions_iter);
  dbus_message_iter_close_container(&iter, &actions_iter);

  // hints: a{sv} -- empty dict, no urgency/category hints in v1.
  DBusMessageIter hints_iter;
  dbus_message_iter_open_container(&iter, DBUS_TYPE_ARRAY, "{sv}", &hints_iter);
  dbus_message_iter_close_container(&iter, &hints_iter);

  dbus_message_iter_append_basic(&iter, DBUS_TYPE_INT32, &expire_timeout);

  DBusPendingCall* pending = nullptr;
  {
    std::lock_guard<std::mutex> lock(g_mtx);
    if (!g_conn ||
        !dbus_connection_send_with_reply(g_conn, msg, &pending, -1)) {
      dbus_message_unref(msg);
      return;
    }
  }
  dbus_message_unref(msg);
  if (!pending) return;
  dbus_pending_call_set_notify(
      pending, OnNotifyReply,
      reinterpret_cast<void*>(static_cast<intptr_t>(id)), nullptr);
}
