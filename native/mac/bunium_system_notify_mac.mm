// Phase 5: OS notifications for bunium. Own translation unit, same
// vertical-slice pattern as the menu/tray module.
//
// Two backends, chosen per-process:
// - UNUserNotificationCenter (current API) when the process has a bundle
//   identifier -- i.e. a packaged app (Phase 8). Without a bundle, touching
//   UNUserNotificationCenter at all throws an NSInternalInconsistencyException
//   (the process can even be terminated by it -- observed crashing the whole
//   Bun runtime in this dev environment), so it's never even referenced in
//   that case.
// - NSUserNotification (deprecated since 10.14, still functional) for
//   unbundled dev binaries -- it's the fallback that lets `bun run` dev
//   sessions actually show banners and deliver clicks.
//
// Click delivery reuses the shared system event bus (bunium_system_events.h):
// whatever path delivered the banner, the delegate pushes a
// bunium-notification-click {"id":N} event with the app-assigned numeric id.
#include <Foundation/Foundation.h>
#include <UserNotifications/UserNotifications.h>

#include <cstdint>
#include <cstdio>
#include <cstdlib>

#include "bunium_system_events.h"

@class BuniumNotificationDelegate;

static bool HasBundleIdentifier() {
  return [NSBundle mainBundle].bundleIdentifier.length > 0;
}

// One delegate serves both centers (they're mutually exclusive per process,
// but a single conforming class keeps the click path identical).
@interface BuniumNotificationDelegate
    : NSObject <UNUserNotificationCenterDelegate, NSUserNotificationCenterDelegate>
@end

@implementation BuniumNotificationDelegate
// Modern path: user clicked/banner-actioned a delivered UN notification. The
// request identifier is the app-assigned numeric id; parse it back out.
- (void)userNotificationCenter:(UNUserNotificationCenter*)center
    didReceiveNotificationResponse:(UNNotificationResponse*)response
            withCompletionHandler:(void (^)(void))completionHandler {
  UNNotificationRequest* request = response.notification.request;
  long long idVal = strtoll(request.identifier.UTF8String ?: "", nullptr, 10);
  char buf[64];
  snprintf(buf, sizeof(buf), "{\"id\":%lld}", idVal);
  PushSystemEvent("bunium-notification-click", buf);
  completionHandler();
}

// Foreground (focused app) UN notifications are silent by default -- show the
// banner anyway, matching how Electron surfaces notifications when focused.
- (void)userNotificationCenter:(UNUserNotificationCenter*)center
       willPresentNotification:(UNNotification*)notification
         withCompletionHandler:(void (^)(UNNotificationPresentationOptions options))
                                   completionHandler {
  completionHandler(UNNotificationPresentationOptionBanner);
}

// Legacy path: click on a delivered NSUserNotification; the id rides in
// userInfo (set by bunium_system_notify below).
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
- (void)userNotificationCenter:(NSUserNotificationCenter*)center
       didActivateNotification:(NSUserNotification*)notification {
  NSNumber* nid = notification.userInfo[@"buniumId"];
  long long idVal = nid ? nid.longLongValue : 0;
  char buf[64];
  snprintf(buf, sizeof(buf), "{\"id\":%lld}", idVal);
  PushSystemEvent("bunium-notification-click", buf);
}
#pragma clang diagnostic pop
@end

static BuniumNotificationDelegate* g_notify_delegate;  // strong: center delegates are weak
static bool g_auth_requested = false;

static void EnsureNotifyDelegate() {
  if (!g_notify_delegate) {
    g_notify_delegate = [[BuniumNotificationDelegate alloc] init];
  }
  if (HasBundleIdentifier()) {
    [UNUserNotificationCenter currentNotificationCenter].delegate =
        g_notify_delegate;
  } else {
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
    [NSUserNotificationCenter defaultUserNotificationCenter].delegate =
        g_notify_delegate;
#pragma clang diagnostic pop
  }
}

// Legacy fallback: deliver immediately with the legacy center (no permission
// prompt, no bundle required -- the whole point of this path for dev).
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
static void PostLegacyNotification(const char* title, const char* body,
                                   int32_t id) {
  NSUserNotification* n = [[NSUserNotification alloc] init];
  n.title = [NSString stringWithUTF8String:title];
  if (body && *body) {
    n.informativeText = [NSString stringWithUTF8String:body];
  }
  n.userInfo = @{@"buniumId" : @(id)};
  n.soundName = NSUserNotificationDefaultSoundName;
  [[NSUserNotificationCenter defaultUserNotificationCenter]
      deliverNotification:n];
}
#pragma clang diagnostic pop

// Posts a banner notification with `id` as its identity. Fire-and-forget:
// never blocks the JS pump. Chooses the backend by bundle presence (see file
// comment). First UN notify of a process requests permission and defers
// delivery to the auth completion handler; later calls deliver immediately.
extern "C" __attribute__((visibility("default"))) void
bunium_system_notify(const char* title, const char* body, int32_t id) {
  @autoreleasepool {
    if (!HasBundleIdentifier()) {
      EnsureNotifyDelegate();
      PostLegacyNotification(title, body, id);
      return;
    }

    @try {
      UNUserNotificationCenter* center = [UNUserNotificationCenter currentNotificationCenter];
      EnsureNotifyDelegate();

      UNMutableNotificationContent* content = [[UNMutableNotificationContent alloc] init];
      content.title = [NSString stringWithUTF8String:title];
      content.body = [NSString stringWithUTF8String:body];
      content.sound = [UNNotificationSound defaultSound];

      // Id doubles as the request identifier, giving the delegate something
      // parseable and making a re-notify with the same id replace the pending
      // request instead of stacking duplicates.
      NSString* ident = [NSString stringWithFormat:@"%lld", (long long)id];
      UNNotificationRequest* request = [UNNotificationRequest
          requestWithIdentifier:ident
                        content:content
                        trigger:nil];

      if (g_auth_requested) {
        [center addNotificationRequest:request withCompletionHandler:nil];
      } else {
        g_auth_requested = true;
        [center requestAuthorizationWithOptions:(UNAuthorizationOptionAlert |
                                                  UNAuthorizationOptionSound |
                                                  UNAuthorizationOptionBadge)
                              completionHandler:^(BOOL granted, NSError* error) {
                                // request is retained by this block (ARC);
                                // only delivered if the user granted permission.
                                [center addNotificationRequest:request
                                         withCompletionHandler:nil];
                              }];
      }
    } @catch (NSException* e) {
      // Belt-and-braces: UN on a misbehaving (unsigned/unbundled-localized)
      // process can still throw here -- degrade to a silent no-op rather than
      // propagate a C++ exception into the Bun runtime (which crashes the
      // whole process).
      fprintf(stderr, "[bunium] notify: UNUserNotificationCenter threw: %s: %s\n",
              e.name.UTF8String, e.reason.UTF8String);
    }
  }
}
