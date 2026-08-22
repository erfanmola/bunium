#pragma once
#include <string>

// Shared inbox push for app-level system events (menu clicks, tray clicks,
// notification clicks, dialog results). Defined in
// bunium_system_events_linux.cc, used by every Phase 5 vertical-slice file
// (notify, dialogs, tray, menu) so they all deliver into the same native
// inbox that app.ts drains via bunium_poll_system_event ->
// SystemEventBus in src/system/events.ts -- one event channel for the whole
// system surface, matching the mac/win pattern (see
// native/mac/bunium_system_events.h / native/win/bunium_system_win.cc).
void PushSystemEvent(const char* name, const std::string& payload);
