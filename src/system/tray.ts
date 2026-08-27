import type { Pointer } from "bun:ffi";
import { asPointer, cstr, lib } from "../native";
import { systemEvents } from "./events";
import type { Menu } from "./menu";

// Phase 5: native macOS system tray (NSStatusItem in the menu bar
// status area). v2: icon-capable (file or SF Symbol) with optional status
// menu and opt-in click delivery for menu-less trays.
//
// Presentation: setTitle() and setIcon()/setSymbol() are independent -- a
// tray can show text, an icon, or both. Backgrounds: an icon (especially a
// template image) adapts to menu bar appearance automatically; title-only
// trays get the same treatment via NSStatusBarButton.title.
//
// Interaction: attach a status menu via setMenu() -- clicking the tray then
// shows that menu and the menu's items fire their own click events
// (Electron's context-menu behavior; the button action never fires). For a
// tray with no menu, onClick() opts into bunium-tray-click delivery.

const TRAY_CLICK_EVENT = "bunium-tray-click";

export class Tray {
  readonly handle: Pointer;

  constructor(title = "") {
    this.handle = asPointer(lib.symbols.bunium_system_tray_create(cstr(title))!);
  }

  setTitle(title: string): this {
    lib.symbols.bunium_system_tray_set_title(this.handle, cstr(title));
    return this;
  }

  /** Shows an image icon loaded from `imagePath`. `template` renders it
   *  monochrome so the system adapts it to the current menu bar appearance --
   *  the usual choice for menu bar icons. */
  setIcon(imagePath: string, template = true): this {
    lib.symbols.bunium_system_tray_set_icon(
      this.handle,
      cstr(imagePath),
      template ? 1 : 0,
    );
    return this;
  }

  /** Shows an SF Symbol as the icon (e.g. "bell.fill"). Always template. */
  setSymbol(symbolName: string): this {
    lib.symbols.bunium_system_tray_set_symbol(this.handle, cstr(symbolName));
    return this;
  }

  /** Attach a status menu -- clicking the tray shows it. Items fire their own
   *  Menu.onItemClicked events. Supersedes any onClick() click delivery. */
  setMenu(menu: Menu): this {
    lib.symbols.bunium_system_tray_set_menu(this.handle, menu.handle);
    return this;
  }

  /**
   * Registers a click handler for a menu-less tray (setMenu takes precedence
   * if called after). The payload is the tray's own handle-derived id, so
   * multiple trays can share one handler function and still tell each other
   * apart. Only the first registration enables native click delivery.
   */
  onClick(listener: (id: number) => void): this {
    lib.symbols.bunium_system_tray_set_click(this.handle, 1);
    const trayId = Number(lib.symbols.bunium_system_tray_get_id(this.handle));
    systemEvents.on(TRAY_CLICK_EVENT, (payload) => {
      const { id } = payload as { id: number };
      if (id === trayId) listener(id);
    });
    return this;
  }

  /** Removes the item from the status bar permanently. */
  destroy(): void {
    lib.symbols.bunium_system_tray_destroy(this.handle);
  }
}
