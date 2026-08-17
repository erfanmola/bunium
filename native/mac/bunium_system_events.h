#pragma once
#include <string>

// Shared inbox push for app-level system events (menu clicks, tray clicks,
// notification clicks, dialog results). Defined in bunium_system_mac.mm,
// used by the other Phase 5 vertical slices (notifications, dialogs) so
// every slice delivers into the same native inbox that app.ts drains via
// bunium_poll_system_event -> SystemEventBus in src/system/events.ts --
// one event channel for the whole system surface, never per-feature
// bespoke bridges.
void PushSystemEvent(const char* name, const std::string& payload);
