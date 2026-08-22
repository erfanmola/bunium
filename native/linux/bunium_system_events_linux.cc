// Shared app-level system-event inbox for Linux's Phase 5 vertical slices
// (notify, dialogs, tray, menu) -- mirrors native/mac/bunium_system_mac.mm's
// g_system_events/PushSystemEvent/bunium_poll_system_event exactly, split
// into its own translation unit here since Linux's slices each live in
// their own file (notify is D-Bus, dialogs are GTK, tray will be D-Bus
// StatusNotifierItem) rather than mac's single bunium_system_mac.mm.
#include <cstdint>
#include <deque>
#include <mutex>
#include <string>
#include <utility>

#include "bunium_system_events_linux.h"
#include "include/cef_parser.h"
#include "include/cef_values.h"

static std::mutex g_system_mtx;
static std::deque<std::pair<std::string, std::string>> g_system_events;
static std::string g_system_export;  // scratch copy for bunium_poll_system_event

void PushSystemEvent(const char* name, const std::string& payload) {
  std::lock_guard<std::mutex> lock(g_system_mtx);
  g_system_events.emplace_back(name, payload);
}

// Drains one pending system event. Returns a JSON envelope
// {"name":"...","payload":"..."} (payload is itself JSON) or null if empty
// -- same encoding as bunium_poll_message and the mac/win implementations,
// so src/system/events.ts needs zero platform branching.
extern "C" __attribute__((visibility("default"))) const char*
bunium_poll_system_event() {
  std::string name, payload;
  {
    std::lock_guard<std::mutex> lock(g_system_mtx);
    if (g_system_events.empty()) return nullptr;
    auto front = std::move(g_system_events.front());
    g_system_events.pop_front();
    name = front.first;
    payload = front.second;
  }

  auto dict = CefDictionaryValue::Create();
  dict->SetString("name", name);
  dict->SetString("payload", payload);
  auto value = CefValue::Create();
  value->SetDictionary(dict);
  g_system_export = CefWriteJSON(value, JSON_WRITER_DEFAULT).ToString();
  return g_system_export.c_str();
}
