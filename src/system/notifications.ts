import { cstr, lib } from "../native";
import { systemEvents } from "./events";

// Phase 5: OS notifications (UNUserNotificationCenter on macOS). A
// Notification is an immutable description plus an id; `show()` hands it to
// the native side and clicking the delivered banner fires the per-instance
// onClick handler via the shared system event bus (bunium-notification-click
// {"id":N}).
//
// Delivery caveat: macOS only actually displays banners for processes with a
// bundle identifier -- an unbundled dev binary can silently drop them until
// packaging (Phase 8) gives the app a real bundle. The click pipeline itself
// still works end-to-end once a banner is delivered.

const NOTIFICATION_CLICK_EVENT = "bunium-notification-click";

let nextNotificationId = 1;

export interface NotificationOptions {
  title: string;
  /** Optional secondary text shown under the title. */
  body?: string;
  /**
   * App-assigned id, reported back on click so a handler can tell
   * notifications apart. Defaults to a unique per-process counter.
   */
  id?: number;
}

export class Notification {
  readonly id: number;
  readonly title: string;
  readonly body: string;

  constructor(options: NotificationOptions) {
    this.title = options.title;
    this.body = options.body ?? "";
    // Explicit ids don't advance the counter (and may collide with a later
    // auto-assigned one) -- document that choice in the handler, same
    // caveat as Menu item ids.
    this.id = options.id ?? nextNotificationId++;
  }

  /** Posts the notification. Requires the app pump to be running, like everything else. */
  show(): this {
    lib.symbols.bunium_system_notify(
      cstr(this.title),
      cstr(this.body),
      this.id,
    );
    return this;
  }

  /** Registers a click handler scoped to this specific notification's id. */
  onClick(listener: () => void): this {
    systemEvents.on(NOTIFICATION_CLICK_EVENT, (payload) => {
      const { id } = payload as { id: number };
      if (id === this.id) listener();
    });
    return this;
  }
}
