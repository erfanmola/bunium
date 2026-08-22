/* Dev/test-only fake org.kde.StatusNotifierWatcher + verifier. Not shipped,
 * not built by native/linux/build.sh -- exists purely to verify bunium's
 * real StatusNotifierItem D-Bus service end-to-end inside the headless
 * Docker container, which has no real desktop panel/watcher (no GNOME/KDE
 * session). Owns the well-known watcher name so
 * RegisterStatusNotifierItem() lands somewhere, captures the registered
 * bus name, then calls Properties.GetAll and Activate back on the item
 * itself to prove the whole round trip -- not just "didn't crash".
 *
 * Build: gcc $(pkg-config --cflags --libs dbus-1) -o fake_sni_watcher \
 *   fake_sni_watcher.c
 */
#include <dbus/dbus.h>
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
    fprintf(stderr, "fake-sni-watcher: connect failed: %s\n", err.message);
    return 1;
  }

  int rc = dbus_bus_request_name(conn, "org.kde.StatusNotifierWatcher",
                                 DBUS_NAME_FLAG_DO_NOT_QUEUE, &err);
  if (dbus_error_is_set(&err) || rc != DBUS_REQUEST_NAME_REPLY_PRIMARY_OWNER) {
    fprintf(stderr, "fake-sni-watcher: request_name failed: %s\n",
            err.message ? err.message : "(name taken)");
    return 1;
  }
  dbus_bus_add_match(conn, "type='method_call'", &err);
  fprintf(stderr, "fake-sni-watcher: ready\n");

  char registered_bus_name[256] = {0};
  int verified = 0;

  while (1) {
    dbus_connection_read_write(conn, 100);
    DBusMessage *msg = dbus_connection_pop_message(conn);
    if (msg) {
      if (dbus_message_is_method_call(msg, "org.kde.StatusNotifierWatcher",
                                      "RegisterStatusNotifierItem")) {
        const char *name = NULL;
        dbus_message_get_args(msg, NULL, DBUS_TYPE_STRING, &name,
                              DBUS_TYPE_INVALID);
        if (name) {
          strncpy(registered_bus_name, name, sizeof(registered_bus_name) - 1);
          fprintf(stderr, "fake-sni-watcher: item registered: %s\n", name);
        }
        DBusMessage *reply = dbus_message_new_method_return(msg);
        dbus_connection_send(conn, reply, NULL);
        dbus_message_unref(reply);
      }
      dbus_message_unref(msg);
    }

    if (registered_bus_name[0] && !verified) {
      verified = 1;
      /* Object path convention bunium uses: /StatusNotifierItem/<id>; try
       * id=1 (first tray created in a fresh process). */
      DBusMessage *getall = dbus_message_new_method_call(
          registered_bus_name, "/StatusNotifierItem/1",
          "org.freedesktop.DBus.Properties", "GetAll");
      const char *iface = "org.kde.StatusNotifierItem";
      dbus_message_append_args(getall, DBUS_TYPE_STRING, &iface,
                               DBUS_TYPE_INVALID);
      DBusMessage *reply = dbus_connection_send_with_reply_and_block(
          conn, getall, 2000, &err);
      dbus_message_unref(getall);
      if (reply) {
        DBusMessageIter iter, dict;
        dbus_message_iter_init(reply, &iter);
        dbus_message_iter_recurse(&iter, &dict);
        while (dbus_message_iter_get_arg_type(&dict) == DBUS_TYPE_DICT_ENTRY) {
          DBusMessageIter entry, variant;
          dbus_message_iter_recurse(&dict, &entry);
          const char *key = NULL;
          dbus_message_iter_get_basic(&entry, &key);
          dbus_message_iter_next(&entry);
          dbus_message_iter_recurse(&entry, &variant);
          if (dbus_message_iter_get_arg_type(&variant) == DBUS_TYPE_STRING) {
            const char *val = NULL;
            dbus_message_iter_get_basic(&variant, &val);
            fprintf(stderr, "fake-sni-watcher: property %s = %s\n", key, val);
          }
          dbus_message_iter_next(&dict);
        }
        dbus_message_unref(reply);

        /* Now call Activate(0,0) to simulate a real click. */
        DBusMessage *activate = dbus_message_new_method_call(
            registered_bus_name, "/StatusNotifierItem/1",
            "org.kde.StatusNotifierItem", "Activate");
        int32_t x = 0, y = 0;
        dbus_message_append_args(activate, DBUS_TYPE_INT32, &x,
                                 DBUS_TYPE_INT32, &y, DBUS_TYPE_INVALID);
        dbus_connection_send(conn, activate, NULL);
        dbus_message_unref(activate);
        fprintf(stderr, "fake-sni-watcher: sent Activate(0,0)\n");
      } else {
        fprintf(stderr, "fake-sni-watcher: GetAll failed: %s\n",
                err.message ? err.message : "(no reply)");
        if (dbus_error_is_set(&err)) dbus_error_free(&err);
      }
    }
  }
  return 0;
}
