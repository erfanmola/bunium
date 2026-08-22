// Phase 5: native dialogs for bunium on Linux -- GtkFileChooserDialog
// (open/save) and GtkMessageDialog (message box). Own translation unit,
// same vertical-slice pattern as mac's bunium_system_dialogs_mac.mm.
//
// GTK is not thread-safe for UI calls from arbitrary threads -- every
// widget must be created/driven from the thread that called gtk_init().
// This does NOT need its own dedicated thread, though: bunium runs CEF
// with multi_threaded_message_loop=false (bunium_shim.cpp), meaning CEF's
// own browser-process UI thread IS the same thread bunium_do_message_loop_
// work() (and therefore this file's exported functions) already run on --
// and on Linux, CEF's UI-thread message pump (base::MessagePumpGlib) is
// itself GLib-based, driving the process's default GMainContext already.
// A real crash was hit here first: spawning a second thread that called
// gtk_init()+gtk_main() (its own loop on the SAME default GMainContext)
// raced GLib's single-owner-per-context rule against CEF's own pump --
// GLib detects two threads trying to acquire the same default context and
// aborts (SIGTRAP inside base::MessagePumpGlib::Run, confirmed via gdb).
// Calling gtk_init() once directly on this (CEF's UI) thread and creating
// widgets synchronously -- no gtk_main()/g_main_loop_run() of our own --
// lets CEF's already-running GLib pump dispatch GTK's events for free.
// Still never blocks the JS pump: no gtk_dialog_run(), dialogs are shown
// and return immediately, driven asynchronously by the "response" signal.
//
// v1 simplification: mac's open panel can have canChooseFiles and
// canChooseDirectories both true at once (a single panel picking either);
// GTK's GtkFileChooserAction is one enum value, not independent flags, so
// can_choose_dirs selects GTK_FILE_CHOOSER_ACTION_SELECT_FOLDER outright
// instead of a mixed files+folders picker. Documented here, not silently
// different behavior.
#include <gtk/gtk.h>

#include <cstdint>
#include <cstdio>
#include <mutex>
#include <string>

#include "bunium_system_events_linux.h"
#include "include/cef_parser.h"
#include "include/cef_values.h"

namespace {

std::once_flag g_gtk_once;

// Initializes GTK exactly once, on whichever thread first calls a dialog
// function -- expected to always be CEF's UI thread (see file header). No
// gtk_main()/g_main_loop_run() of our own: CEF's own GLib-based message
// pump already dispatches this process's default GMainContext every
// CefDoMessageLoopWork() tick, which is what actually delivers GTK's
// widget events and fires the "response" signal handlers below.
void EnsureGtkInit() {
  std::call_once(g_gtk_once, [] {
    int argc = 0;
    gtk_init(&argc, nullptr);
  });
}

void PushDialogResult(int64_t request_id, CefRefPtr<CefDictionaryValue> fields) {
  auto dict = CefDictionaryValue::Create();
  dict->SetInt("requestId", static_cast<int>(request_id));
  dict->SetDictionary("result", fields);
  auto value = CefValue::Create();
  value->SetDictionary(dict);
  std::string json = CefWriteJSON(value, JSON_WRITER_DEFAULT).ToString();
  PushSystemEvent("bunium-dialog-result", json);
}

// Builds+shows the open/save panel and wires its "response" signal to push
// the result and destroy itself. `open` selects OPEN/SELECT_FOLDER vs. SAVE
// action + result shape
// (paths list vs. single path), mirroring BuildPanelResult on mac.
// Alias needed because the C preprocessor's macro-argument scanner only
// balances parentheses, not braces -- a raw `std::pair<int64_t, bool>`
// template-argument comma inside a G_CALLACK(...)-wrapped lambda BODY
// (braces, not parens) still splits the macro call. Same fix applied
// everywhere else below that needs this pair inside a signal callback.
using RequestOpenCtx = std::pair<int64_t, bool>;

void ShowFileChooser(const char* title, GtkFileChooserAction action,
                    bool allow_multiple, const char* ok_label,
                    const char* default_name, int64_t request_id, bool open) {
  GtkWidget* dialog = gtk_file_chooser_dialog_new(
      title, nullptr, action, "_Cancel", GTK_RESPONSE_CANCEL,
      (ok_label && *ok_label) ? ok_label : (open ? "_Open" : "_Save"),
      GTK_RESPONSE_ACCEPT, nullptr);
  if (open && allow_multiple) {
    gtk_file_chooser_set_select_multiple(GTK_FILE_CHOOSER(dialog), TRUE);
  }
  if (!open && default_name) {
    gtk_file_chooser_set_current_name(GTK_FILE_CHOOSER(dialog), default_name);
  }

  g_signal_connect(
      dialog, "response",
      G_CALLBACK(+[](GtkDialog* self, int response, gpointer user_data) {
        auto* ctx = static_cast<RequestOpenCtx*>(user_data);
        int64_t request_id = ctx->first;
        bool open = ctx->second;
        delete ctx;

        auto fields = CefDictionaryValue::Create();
        bool canceled = response != GTK_RESPONSE_ACCEPT;
        fields->SetBool("canceled", canceled);
        if (!canceled) {
          GtkFileChooser* chooser = GTK_FILE_CHOOSER(self);
          if (open) {
            auto list = CefListValue::Create();
            GSList* uris = gtk_file_chooser_get_filenames(chooser);
            int i = 0;
            for (GSList* it = uris; it; it = it->next) {
              list->SetString(i++, static_cast<char*>(it->data));
              g_free(it->data);
            }
            g_slist_free(uris);
            fields->SetList("paths", list);
          } else {
            char* fn = gtk_file_chooser_get_filename(chooser);
            fields->SetString("path", fn ? fn : "");
            if (fn) g_free(fn);
          }
        }
        PushDialogResult(request_id, fields);
        gtk_widget_destroy(GTK_WIDGET(self));
      }),
      (new RequestOpenCtx(request_id, open)));

  gtk_widget_show_all(dialog);
}

}  // namespace

extern "C" __attribute__((visibility("default"))) void
bunium_system_dialog_open(const char* title, int32_t allow_multiple,
                          int32_t can_choose_dirs, int32_t /*can_create_dirs*/,
                          const char* ok_label, int64_t request_id) {
  EnsureGtkInit();
  GtkFileChooserAction action = can_choose_dirs
                                    ? GTK_FILE_CHOOSER_ACTION_SELECT_FOLDER
                                    : GTK_FILE_CHOOSER_ACTION_OPEN;
  ShowFileChooser(title ? title : "", action, allow_multiple != 0,
                  ok_label ? ok_label : "", nullptr, request_id, true);
}

extern "C" __attribute__((visibility("default"))) void
bunium_system_dialog_save(const char* title, const char* default_name,
                          const char* ok_label, int64_t request_id) {
  EnsureGtkInit();
  ShowFileChooser(title ? title : "", GTK_FILE_CHOOSER_ACTION_SAVE, false,
                  ok_label ? ok_label : "",
                  (default_name && *default_name) ? default_name : nullptr,
                  request_id, false);
}

extern "C" __attribute__((visibility("default"))) void
bunium_system_dialog_message(const char* message, const char* detail,
                             const char* ok_label, const char* cancel_label,
                             int64_t request_id) {
  EnsureGtkInit();
  GtkWidget* dialog =
      gtk_message_dialog_new(nullptr, GTK_DIALOG_MODAL, GTK_MESSAGE_INFO,
                             GTK_BUTTONS_NONE, "%s", message ? message : "");
  if (detail && *detail) {
    gtk_message_dialog_format_secondary_text(GTK_MESSAGE_DIALOG(dialog), "%s",
                                             detail);
  }
  gtk_dialog_add_button(GTK_DIALOG(dialog),
                        (ok_label && *ok_label) ? ok_label : "_OK",
                        GTK_RESPONSE_OK);
  if (cancel_label && *cancel_label) {
    gtk_dialog_add_button(GTK_DIALOG(dialog), cancel_label,
                          GTK_RESPONSE_CANCEL);
  }

  g_signal_connect(
      dialog, "response",
      G_CALLBACK(+[](GtkDialog* self, int response, gpointer user_data) {
        int64_t request_id =
            static_cast<int64_t>(reinterpret_cast<intptr_t>(user_data));
        auto fields = CefDictionaryValue::Create();
        int resp = (response == GTK_RESPONSE_OK) ? 0 : 1;
        fields->SetInt("response", resp);
        PushDialogResult(request_id, fields);
        gtk_widget_destroy(GTK_WIDGET(self));
      }),
      reinterpret_cast<gpointer>(static_cast<intptr_t>(request_id)));

  gtk_widget_show_all(dialog);
}
