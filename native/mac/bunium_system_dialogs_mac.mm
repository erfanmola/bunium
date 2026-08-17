// Phase 5: native dialogs for bunium -- open/save file panels (NSOpenPanel /
// NSSavePanel) and message boxes (NSAlert). Own translation unit, same
// vertical-slice pattern as the menu/tray module.
//
// Everything is driven with completion-handler APIs (panel
// beginWithCompletionHandler:, alert sheet) so a dialog call NEVER blocks the
// JS pump loop (the old runModal-style modal loop would freeze CEF pumping
// for the whole interaction). Results come back as bunium-dialog-result
// {"requestId":N, ...} events on the shared system event bus (see
// bunium_system_events.h); the TS wrapper in src/system/dialogs.ts matches on
// requestId to resolve its promise.
#include <Cocoa/Cocoa.h>

#include <cstdint>
#include <string>

#include "bunium_system_events.h"
#include "include/cef_parser.h"
#include "include/cef_values.h"

static std::string g_dialog_export;  // scratch for the JSON envelope string

// Encode + push a bunium-dialog-result envelope. `fields` carries the
// per-dialog-kind keys ("canceled", "paths", "path", "response"); the
// requestId discriminator lives at the top level so the TS wrapper can match
// a result to the call that started it.
static void PushDialogResult(int64_t request_id,
                             CefRefPtr<CefDictionaryValue> fields) {
  auto dict = CefDictionaryValue::Create();
  dict->SetInt("requestId", (int)request_id);
  dict->SetDictionary("result", fields);
  auto value = CefValue::Create();
  value->SetDictionary(dict);
  g_dialog_export = CefWriteJSON(value, JSON_WRITER_DEFAULT).ToString();
  PushSystemEvent("bunium-dialog-result", g_dialog_export);
}

// Shared result builder for open/save panels: a canceled:bool plus either a
// paths list or a single path string -- CefWriteJSON encodes it (paths need
// real JSON escaping; snprintf string concatenation would be wrong here).
static CefRefPtr<CefDictionaryValue> BuildPanelResult(
    NSModalResponse response, NSSavePanel* panel, bool open) {
  auto fields = CefDictionaryValue::Create();
  fields->SetBool("canceled", response != NSModalResponseOK);
  if (response != NSModalResponseOK) return fields;
  if (open) {
    NSOpenPanel* openPanel = (NSOpenPanel*)panel;
    auto list = CefListValue::Create();
    NSUInteger i = 0;
    for (NSURL* url in openPanel.URLs) {
      const char* p = url.path ? url.path.UTF8String : "";
      list->SetString((int)i++, p ? p : "");
    }
    fields->SetList("paths", list);
  } else {
    const char* p = panel.URL ? panel.URL.path.UTF8String : "";
    fields->SetString("path", p ? p : "");
  }
  return fields;
}

// Modal open-file dialog. Shows app-modal (not a sheet) and returns
// immediately; the result lands on the event bus when the user acts.
extern "C" __attribute__((visibility("default"))) void
bunium_system_dialog_open(const char* title, int32_t allow_multiple,
                          int32_t can_choose_dirs, int32_t can_create_dirs,
                          const char* ok_label, int64_t request_id) {
  @autoreleasepool {
    NSOpenPanel* panel = [NSOpenPanel openPanel];
    panel.title = [NSString stringWithUTF8String:title];
    panel.canChooseFiles = YES;
    panel.canChooseDirectories = can_choose_dirs != 0;
    panel.allowsMultipleSelection = allow_multiple != 0;
    panel.canCreateDirectories = can_create_dirs != 0;
    if (ok_label && *ok_label) {
      panel.prompt = [NSString stringWithUTF8String:ok_label];
    }
    [panel beginWithCompletionHandler:^(NSModalResponse result) {
      PushDialogResult(request_id, BuildPanelResult(result, panel, true));
    }];
  }
}

// Modal save-file dialog (same non-blocking shape as the open panel).
extern "C" __attribute__((visibility("default"))) void
bunium_system_dialog_save(const char* title, const char* default_name,
                          const char* ok_label, int64_t request_id) {
  @autoreleasepool {
    NSSavePanel* panel = [NSSavePanel savePanel];
    panel.title = [NSString stringWithUTF8String:title];
    if (default_name && *default_name) {
      panel.nameFieldStringValue = [NSString stringWithUTF8String:default_name];
    }
    if (ok_label && *ok_label) {
      panel.prompt = [NSString stringWithUTF8String:ok_label];
    }
    [panel beginWithCompletionHandler:^(NSModalResponse result) {
      PushDialogResult(request_id, BuildPanelResult(result, panel, false));
    }];
  }
}

// Message box: persistent alert. Prefers an app-modal sheet attached to the
// key/main window (non-blocking). With no window to attach a sheet to, an
// app-modal runModal would freeze the JS pump, so report canceled instead and
// let the caller close the window then retry. Response index: 0 = ok button,
// 1 = cancel button (NSAlert button ordering matches how we add them).
extern "C" __attribute__((visibility("default"))) void
bunium_system_dialog_message(const char* message, const char* detail,
                             const char* ok_label, const char* cancel_label,
                             int64_t request_id) {
  @autoreleasepool {
    NSAlert* alert = [[NSAlert alloc] init];
    alert.messageText = [NSString stringWithUTF8String:message];
    if (detail && *detail) {
      alert.informativeText = [NSString stringWithUTF8String:detail];
    }
    [alert addButtonWithTitle:[NSString stringWithUTF8String:ok_label]];
    bool has_cancel = cancel_label && *cancel_label;
    if (has_cancel) {
      [alert addButtonWithTitle:[NSString stringWithUTF8String:cancel_label]];
    }

    NSWindow* parent = [NSApp keyWindow] ? [NSApp keyWindow] : NSApp.mainWindow;
    if (!parent) {
      auto fields = CefDictionaryValue::Create();
      fields->SetInt("response", 1);  // no cancel button actual, but canceled
      PushDialogResult(request_id, fields);
      return;
    }
    [alert beginSheetModalForWindow:parent
                  completionHandler:^(NSModalResponse result) {
                    auto fields = CefDictionaryValue::Create();
                    int response = (result == NSAlertFirstButtonReturn) ? 0 : 1;
                    fields->SetInt("response", response);
                    PushDialogResult(request_id, fields);
                  }];
  }
}
