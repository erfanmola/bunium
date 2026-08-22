/* Dev/test-only fake org.freedesktop.Notifications service. Not shipped, not
 * built by native/linux/build.sh -- exists purely to verify bunium's real
 * D-Bus notify path end-to-end inside the headless Docker container, which
 * has no real notification daemon (no GNOME/KDE session running). Owns the
 * well-known name, replies to Notify() with a fixed id, then emits
 * ActionInvoked("default") shortly after to simulate a user click -- lets
 * examples/system-notifications-test.ts prove the full round trip (not just
 * "didn't crash") the same way the rest of this project's Phase 5 work
 * verifies with real value checks, not just absence-of-crash.
 *
 * Build: gcc $(pkg-config --cflags --libs dbus-1) -o fake_notify_daemon \
 *   fake_notify_daemon.c
 */
#include <dbus/dbus.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

int main(void) {
  DBusError err;
  dbus_error_init(&err);
  DBusConnection *conn = dbus_bus_get(DBUS_BUS_SESSION, &err);
  if (!conn) {
    fprintf(stderr, "fake-notify-daemon: connect failed: %s\n", err.message);
    return 1;
  }

  int rc = dbus_bus_request_name(conn, "org.freedesktop.Notifications",
                                 DBUS_NAME_FLAG_DO_NOT_QUEUE, &err);
  if (dbus_error_is_set(&err) || rc != DBUS_REQUEST_NAME_REPLY_PRIMARY_OWNER) {
    fprintf(stderr, "fake-notify-daemon: request_name failed: %s\n",
            err.message ? err.message : "(name taken)");
    return 1;
  }
  fprintf(stderr, "fake-notify-daemon: ready\n");

  const uint32_t fixed_id = 42;
  int notified = 0;
  int click_sent = 0;
  struct timespec notified_at = {0};

  while (1) {
    dbus_connection_read_write(conn, 100);
    DBusMessage *msg = dbus_connection_pop_message(conn);
    if (msg) {
      if (dbus_message_is_method_call(msg, "org.freedesktop.Notifications",
                                      "Notify")) {
        DBusMessage *reply = dbus_message_new_method_return(msg);
        DBusMessageIter iter;
        dbus_message_iter_init_append(reply, &iter);
        dbus_message_iter_append_basic(&iter, DBUS_TYPE_UINT32, &fixed_id);
        dbus_connection_send(conn, reply, NULL);
        dbus_message_unref(reply);
        notified = 1;
        clock_gettime(CLOCK_MONOTONIC, &notified_at);
        fprintf(stderr, "fake-notify-daemon: Notify() received, replied id=%u\n",
                fixed_id);
      }
      dbus_message_unref(msg);
    }

    if (notified && !click_sent) {
      struct timespec now;
      clock_gettime(CLOCK_MONOTONIC, &now);
      double elapsed_ms = (now.tv_sec - notified_at.tv_sec) * 1000.0 +
                         (now.tv_nsec - notified_at.tv_nsec) / 1e6;
      if (elapsed_ms > 300) {
        DBusMessage *sig = dbus_message_new_signal(
            "/org/freedesktop/Notifications", "org.freedesktop.Notifications",
            "ActionInvoked");
        DBusMessageIter iter;
        dbus_message_iter_init_append(sig, &iter);
        dbus_message_iter_append_basic(&iter, DBUS_TYPE_UINT32, &fixed_id);
        const char *action = "default";
        dbus_message_iter_append_basic(&iter, DBUS_TYPE_STRING, &action);
        dbus_connection_send(conn, sig, NULL);
        dbus_message_unref(sig);
        click_sent = 1;
        fprintf(stderr, "fake-notify-daemon: emitted ActionInvoked(default)\n");
      }
    }
  }
  return 0;
}
