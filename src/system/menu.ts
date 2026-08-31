import type { Pointer } from "bun:ffi";
import { asPointer, cstr, lib } from "../native";
import { systemEvents } from "./events";

// Phase 5: native macOS menu bar. A Menu is a builder over an NSMenu --
// flat items, nesting via submenus, and separators. Assign each clickable
// item a numeric `id` and register an `onItemClicked` handler; when the
// (single, application-wide) menu bar fires, the clicked item's id is
// delivered. Ids are only meaningful within their own click handler, so give
// every item you intend to react to a distinct id.
//
// Attach the finished menu to the app's menu bar with `setApplicationMenu()`
// (macOS has one menu bar per app, not per window). A Menu can also be handed
// to a Tray via `tray.setMenu(menu)` to become its status-menu.

export type MenuItemSpec =
  | { type: "separator" }
  | { type?: undefined; label: string; id?: number; submenu?: MenuItemSpec[] };

const MENU_CLICK_EVENT = "bunium-menu-click";

export class Menu {
  /** The native NSMenu handle this Menu wraps. Also reusable as a Tray's menu. */
  readonly handle: Pointer;

  private nextId = 1;

  constructor(items: MenuItemSpec[] = []) {
    this.handle = asPointer(lib.symbols.bunium_system_menu_create()!);
    for (const item of items) this.add(item);
  }

  /** Appends one item / submenu / separator to this menu (in place, returns this). */
  add(spec: MenuItemSpec): this {
    this.#addInto(this.handle, spec);
    return this;
  }

  #addInto(menuHandle: Pointer, spec: MenuItemSpec): void {
    if (spec.type === "separator") {
      lib.symbols.bunium_system_menu_add_separator(menuHandle);
      return;
    }
    if (spec.submenu) {
      const submenu = asPointer(
        lib.symbols.bunium_system_menu_add_submenu(
          menuHandle,
          cstr(spec.label),
        )!,
      );
      for (const child of spec.submenu) this.#addInto(submenu, child);
      return;
    }
    lib.symbols.bunium_system_menu_add_item(
      menuHandle,
      cstr(spec.label),
      spec.id ?? this.nextId++,
    );
  }

  /** Makes this menu the application-wide menu bar (macOS: one per app). */
  setApplicationMenu(): this {
    lib.symbols.bunium_system_set_application_menu(this.handle);
    return this;
  }

  /**
   * Register a handler for every clickable item's selection. Use each Menu's
   * own handler (not the shared systemEvents bus) so your ids stay scoped to
   * the menu they were declared in.
   */
  onItemClicked(listener: (id: number) => void): this {
    systemEvents.on(MENU_CLICK_EVENT, (payload) => {
      const { id } = payload as { id: number };
      if (typeof id === "number") listener(id);
    });
    return this;
  }
}
