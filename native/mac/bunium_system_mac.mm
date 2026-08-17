// Native Cocoa menu bar (NSMenu) + system tray (NSStatusItem) backing for
// bunium. Kept as its own .mm translation unit (Objective-C++) -- Phase 5's
// "each system feature is its own small vertical slice" -- and linked into
// the same dylib as bunium_shim.cpp / bunium_window_mac.mm.
//
// Events (menu-item clicks, tray clicks) are pushed into a thread-safe inbox
// and drained from JS's pump loop via bunium_poll_system_event -- the exact
// same producer/consumer envelope pattern as bunium_poll_message (renderer
// -> main webview messages), just for app-level system callbacks instead of
// per-view messages. No bun:ffi function-callback surface needed.
#include <Cocoa/Cocoa.h>

#include <cstdint>
#include <cstdio>
#include <deque>
#include <mutex>
#include <string>
#include <unordered_map>
#include <utility>

#include "bunium_common.h"
#include "bunium_system_events.h"
#include "include/cef_parser.h"
#include "include/cef_values.h"

// Thread-safe inbox for system events, produced on Cocoa's main thread (menu
// item clicks, tray clicks) and drained by the JS pump loop. Mirrors
// MessageInbox in bunium_common.h, but app-level rather than per-view.
static std::mutex g_system_mtx;
static std::deque<std::pair<std::string, std::string>> g_system_events;
static std::string g_system_export;  // scratch copy for bunium_poll_system_event

// Defined here (see bunium_system_events.h): the other Phase 5 slices push
// into the same mutex-guarded inbox the menu/tray code uses, so
// bunium_poll_system_event drains everything uniformly.
void PushSystemEvent(const char* name, const std::string& payload) {
  std::lock_guard<std::mutex> lock(g_system_mtx);
  g_system_events.emplace_back(name, payload);
}

// A single shared target for every menu item, identified by NSMenuItem.tag
// (the app-assigned numeric id). NSMenuItem.target is not retained by the
// item, so a per-item target would need manual lifetime management; a single
// long-lived dispatcher sidesteps that entirely. Clicks become
// bunium-menu-click events with the item's id as the payload.
@interface BuniumMenuDispatcher : NSObject
+ (instancetype)sharedDispatcher;
- (void)menuItemClicked:(id)sender;
@end

@implementation BuniumMenuDispatcher
+ (instancetype)sharedDispatcher {
  static BuniumMenuDispatcher* instance;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    instance = [[BuniumMenuDispatcher alloc] init];
  });
  return instance;
}
- (void)menuItemClicked:(id)sender {
  NSMenuItem* item = (NSMenuItem*)sender;
  long long idVal = (long long)item.tag;
  char buf[64];
  snprintf(buf, sizeof(buf), "{\"id\":%lld}", idVal);
  PushSystemEvent("bunium-menu-click", buf);
}

// Tray item clicks (menu-less trays): NSStatusBarButton target/action. The
// button's tag carries the tray handle (set by bunium_system_tray_set_click,
// the only thing that wires this up), so the one shared dispatcher can also
// report which tray was clicked.
- (void)trayClicked:(id)sender {
  NSControl* control = (NSControl*)sender;
  long long idVal = (long long)control.tag;
  char buf[64];
  snprintf(buf, sizeof(buf), "{\"id\":%lld}", idVal);
  PushSystemEvent("bunium-tray-click", buf);
}
@end

// Tray items must be retained by us -- NSStatusBar does not retain the
// NSStatusItem it hands out. Handles are small sequential integers (not the
// ObjC pointer) so JS never deals with a raw Cocoa pointer for trays.
static std::unordered_map<void*, void*> g_tray_items;  // handle -> retained NSStatusItem
static int64_t g_tray_seq = 1;

static NSMenu* MenuFromHandle(void* handle) {
  return (__bridge NSMenu*)handle;
}

extern "C" __attribute__((visibility("default"))) void*
bunium_system_menu_create() {
  @autoreleasepool {
    NSMenu* menu = [[NSMenu alloc] initWithTitle:@""];
    // Retain once; the JS side owns the handle for the process lifetime
    // (menus aren't torn down per-request today).
    return (void*)CFBridgingRetain(menu);
  }
}

extern "C" __attribute__((visibility("default"))) void*
bunium_system_menu_add_item(void* menu_handle, const char* label, int32_t id) {
  @autoreleasepool {
    NSMenu* menu = MenuFromHandle(menu_handle);
    NSMenuItem* item = [[NSMenuItem alloc]
        initWithTitle:[NSString stringWithUTF8String:label]
               action:@selector(menuItemClicked:)
        keyEquivalent:@""];
    item.target = [BuniumMenuDispatcher sharedDispatcher];
    item.tag = (NSInteger)id;
    [menu addItem:item];
    return (__bridge void*)item;  // informational; menu retains it
  }
}

extern "C" __attribute__((visibility("default"))) void*
bunium_system_menu_add_submenu(void* menu_handle, const char* label) {
  @autoreleasepool {
    NSMenu* menu = MenuFromHandle(menu_handle);
    std::string s(label);
    NSString* title = [NSString stringWithUTF8String:s.c_str()];
    NSMenuItem* item =
        [[NSMenuItem alloc] initWithTitle:title action:NULL keyEquivalent:@""];
    NSMenu* submenu = [[NSMenu alloc] initWithTitle:title];
    item.submenu = submenu;  // submenu retained by item, item retained by menu
    [menu addItem:item];
    return (void*)CFBridgingRetain(submenu);
  }
}

extern "C" __attribute__((visibility("default"))) void
bunium_system_menu_add_separator(void* menu_handle) {
  @autoreleasepool {
    NSMenu* menu = MenuFromHandle(menu_handle);
    [menu addItem:[NSMenuItem separatorItem]];
  }
}

// Sets `menu_handle` as the application-wide menu bar (NSApp.mainMenu). macOS
// has one menu bar per app, not per window, regardless of how many windows
// are open.
extern "C" __attribute__((visibility("default"))) void
bunium_system_set_application_menu(void* menu_handle) {
  @autoreleasepool {
    [NSApplication sharedApplication];
    NSMenu* menu = MenuFromHandle(menu_handle);
    NSApp.mainMenu = menu;
  }
}

extern "C" __attribute__((visibility("default"))) void*
bunium_system_tray_create(const char* title) {
  @autoreleasepool {
    NSStatusItem* item =
        [[NSStatusBar systemStatusBar] statusItemWithLength:NSVariableStatusItemLength];
    // button.title, not the deprecated NSStatusItem.title forwarding property.
    item.button.title = [NSString stringWithUTF8String:title];
    void* handle = (void*)(intptr_t)g_tray_seq++;
    void* retained = (__bridge_retained void*)item;  // we own it
    g_tray_items[handle] = retained;
    return handle;
  }
}

extern "C" __attribute__((visibility("default"))) void
bunium_system_tray_set_title(void* tray_handle, const char* title) {
  auto it = g_tray_items.find(tray_handle);
  if (it == g_tray_items.end()) return;
  @autoreleasepool {
    NSStatusItem* item = (__bridge NSStatusItem*)it->second;
    item.button.title = [NSString stringWithUTF8String:title];
  }
}

// Icon from a file (Electron-compatible tray.setImage). `is_template`
// renders the image monochrome so the system can adapt it to the current
// menu bar appearance -- the usual choice for menu bar icons.
extern "C" __attribute__((visibility("default"))) void
bunium_system_tray_set_icon(void* tray_handle, const char* image_path,
                            int32_t is_template) {
  auto it = g_tray_items.find(tray_handle);
  if (it == g_tray_items.end()) return;
  @autoreleasepool {
    NSImage* image = [[NSImage alloc]
        initWithContentsOfFile:[NSString stringWithUTF8String:image_path]];
    if (!image) {
      fprintf(stderr, "[bunium] tray: failed to load icon at %s\n", image_path);
      return;
    }
    // setTemplate:, not dot-syntax: `template` is a C++ keyword, so
    // `image.template` won't parse in an Objective-C++ (.mm) TU.
    [image setTemplate:(is_template != 0)];
    NSStatusItem* item = (__bridge NSStatusItem*)it->second;
    item.button.image = image;
  }
}

// SF Symbol convenience: menu bar icons are frequently system symbols, and
// this keeps smoke tests asset-free (no PNG to ship). Always rendered as a
// template image, which is what status items want.
extern "C" __attribute__((visibility("default"))) void
bunium_system_tray_set_symbol(void* tray_handle, const char* symbol_name) {
  auto it = g_tray_items.find(tray_handle);
  if (it == g_tray_items.end()) return;
  @autoreleasepool {
    NSImage* image =
        [NSImage imageWithSystemSymbolName:[NSString stringWithUTF8String:symbol_name]
                 accessibilityDescription:@""];
    if (!image) {
      fprintf(stderr, "[bunium] tray: unknown SF Symbol %s\n", symbol_name);
      return;
    }
    [image setTemplate:YES];
    NSStatusItem* item = (__bridge NSStatusItem*)it->second;
    item.button.image = image;
  }
}

// Opt-in click delivery for menu-less trays: wires the status button's
// target/action to the shared dispatcher, which pushes bunium-tray-click
// {"id":T} with the tray's handle as the id. Calling setMenu() afterwards
// supersedes this (a status item with a menu shows the menu on click instead
// of firing the button action -- matches Electron).
extern "C" __attribute__((visibility("default"))) void
bunium_system_tray_set_click(void* tray_handle, int32_t enabled) {
  auto it = g_tray_items.find(tray_handle);
  if (it == g_tray_items.end()) return;
  @autoreleasepool {
    NSStatusItem* item = (__bridge NSStatusItem*)it->second;
    NSStatusBarButton* button = item.button;
    if (enabled) {
      button.target = [BuniumMenuDispatcher sharedDispatcher];
      button.action = @selector(trayClicked:);
      button.tag = (NSInteger)(intptr_t)tray_handle;
    } else {
      button.target = nil;
      button.action = NULL;
    }
  }
}

// Tray handles are sequential ints cast to pointers; bun's ffi Pointer type
// exposes no numeric accessor, so JS gets the id back through the ABI instead
// (the same int that bunium-tray-click {"id":N} delivers).
extern "C" __attribute__((visibility("default"))) int64_t
bunium_system_tray_get_id(void* tray_handle) {
  return (int64_t)(intptr_t)tray_handle;
}

// Attaching a menu makes the tray item behave like a status-menu: clicking it
// shows `menu_handle`. No separate tray-click event is emitted in this case
// (the menu items' own bunium-menu-click events carry the actual payload).
extern "C" __attribute__((visibility("default"))) void
bunium_system_tray_set_menu(void* tray_handle, void* menu_handle) {
  auto it = g_tray_items.find(tray_handle);
  if (it == g_tray_items.end()) return;
  @autoreleasepool {
    NSStatusItem* item = (__bridge NSStatusItem*)it->second;
    item.menu = MenuFromHandle(menu_handle);
  }
}

extern "C" __attribute__((visibility("default"))) void
bunium_system_tray_destroy(void* tray_handle) {
  auto it = g_tray_items.find(tray_handle);
  if (it == g_tray_items.end()) return;
  @autoreleasepool {
    NSStatusItem* item = (__bridge_transfer NSStatusItem*)it->second;  // release
    [[NSStatusBar systemStatusBar] removeStatusItem:item];
  }
  g_tray_items.erase(it);
}

// Drains one pending system event (menu-item click, ...). Returns a JSON
// envelope like {"name":"...","payload":"..."} (payload is itself JSON: e.g.
// {"id":7}) or null if the inbox is empty. Poll in a loop until null to drain
// everything queued since the last call. Same envelope encoding as
// bunium_poll_message (CefValue/CefWriteJSON, so names can't break it).
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
