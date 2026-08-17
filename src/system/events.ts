import { CString } from "bun:ffi";
import { lib } from "../native";

// App-level system event bus (menu-item clicks, tray clicks). Produced by
// native Cocoa code and pushed into a native inbox; drained from here each
// app pump tick via bunium_poll_system_event -- the same envelope
// ({"name", "payload"}) and drain-loop-until-null pattern as per-view
// window.__bunium.send() messages, just for main-process system callbacks
// instead of renderer->main webview messages.
//
// `payload` is whatever JSON the native side pushed (e.g. {"id":7} for a
// menu click); callers narrow it via a cast in their own `.on(name, ...)`
// listener, keeping this bus itself payload-agnostic.

export interface SystemEventEnvelope {
  name: string;
  payload: string;
}

type SystemListener = (payload: unknown) => void;

class SystemEventBus {
  private listeners = new Map<string, Set<SystemListener>>();

  on(name: string, listener: SystemListener): () => void {
    let set = this.listeners.get(name);
    if (!set) {
      set = new Set();
      this.listeners.set(name, set);
    }
    set.add(listener);
    return () => {
      set?.delete(listener);
    };
  }

  off(name: string, listener: SystemListener): void {
    this.listeners.get(name)?.delete(listener);
  }

  /** Drains every queued system event, dispatched to matching listeners. */
  drain(): void {
    for (;;) {
      // bunium_poll_system_event returns a JSON envelope string, or NULL when
      // the inbox is empty. Reading it via FFIType.ptr + explicit null check
      // (NOT FFIType.cstring) matches the documented FFI gotcha: cstring
      // returns a truthy wrapper even for a NULL native pointer.
      const ptr = lib.symbols.bunium_poll_system_event();
      if (ptr === null) break;

      const envelope = JSON.parse(
        new CString(ptr).toString(),
      ) as SystemEventEnvelope;
      const listeners = this.listeners.get(envelope.name);
      if (!listeners) continue;
      const payload: unknown = JSON.parse(envelope.payload);
      for (const listener of [...listeners]) listener(payload);
    }
  }
}

export const systemEvents = new SystemEventBus();
