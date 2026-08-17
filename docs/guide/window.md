# Window

`BuniumWindow` is the main-process handle to one native window + one CEF view,
painted into a `CAMetalLayer`. Typed per the standing requirement — every option,
getter, and event is exported.

```ts
import { BuniumWindow } from "bunium";

const win = new BuniumWindow({ url: "bunium://app/" });
```

## Constructor options

`BuniumWindowOptions` (all optional except `url`):

| Option        | Type      | Default | Notes                                                                  |
| ------------- | --------- | ------- | ---------------------------------------------------------------------- |
| `url`         | `string`  | —       | Initial URL.                                                           |
| `width`       | `number`  | `800`   | Logical (CSS px) content width.                                        |
| `height`      | `number`  | `600`   | Logical content height.                                                |
| `title`       | `string`  | `bunium`| Window title.                                                          |
| `transparent` | `boolean` | `false` | Clear background — the desktop shows through wherever the page paints transparent pixels. |
| `frame`       | `boolean` | `true`  | `false` hides native chrome (title bar / traffic-light buttons). Frameless windows need a CSS drag region to move — see below. |
| `resizable`   | `boolean` | `true`  | `false` disables user resize entirely.                                 |
| `minWidth`/`minHeight` | `number` | unset | Minimum content size for user resize.                        |
| `maxWidth`/`maxHeight` | `number` | unset | Maximum content size for user resize.                        |

Native ABI note: window creation and constraints are deliberately two separate
calls — bun:ffi on arm64 corrupts the 9th+ argument of a single call, so every
native function stays at ≤ 8 args. No action needed from you; design constraint
only.

## Methods

| Method | Signature | Notes |
| ------ | --------- | ----- |
| `loadURL(url)` | `(url: string) => void` | Navigate the window's view to a new URL. |
| `resize(width, height)` | `(w, h) => void` | Programmatic resize (logical px). |
| `captureScreenshot()` | `() => Screenshot` | Raw BGRA pixels of the latest frame at physical size. No PNG encoder bundled — pick your own image lib. |
| `onClose(listener)` | `(cb: () => void) => void` | Fires on user close (red button) or `.close()`. |
| `on(name, listener)` | renderer → main IPC | See [Typed IPC](/guide/ipc). |
| `emit(name, payload)` | main → renderer IPC | See [Typed IPC](/guide/ipc). |
| `close()` | `() => void` | Double-close is a safe no-op. |

## Getters

- `frameCount` — `bigint`, frames painted by the view.
- `innerSize` — logical (CSS px) size, what the page sees.
- `renderedSize` — physical pixel size of the paint buffer
  (`innerSize * devicePixelRatio`).
- `devicePixelRatio` — the window's backing scale factor (2.0 on Retina).
- `resizable` — whether the user can resize; `sizeConstraints` — current
  min/max content constraints.

## Screenshot

```ts
export interface Size {
  width: number;
  height: number;
}

export interface Screenshot {
  width: number;
  height: number;
  data: Uint8Array; // raw BGRA, top-left origin, width * height * 4 bytes
}
```

## Transparency

`transparent: true` enables CEF's windowless alpha painting (binary, not a
translucency slider). Verified behavior: a page painting an opaque red square in
one corner produces alpha=255 at the square and alpha=0 everywhere else, read back
via `captureScreenshot()`.

## Frameless windows

`frame: false` uses `NSWindowStyleMaskBorderless`; the native resize bar is gone,
so AppKit's free edge-drag resizing is lost too. bunium reimplements 6px edge
hit-testing natively for `frame: false` + `resizable: true` windows (titled and
non-resizable windows are completely unaffected). To move a frameless window, mark
page elements with CSS `-webkit-app-region: drag` — bunium scans automatically.
Note: a drag region is fully non-interactive (no Electron-style `no-drag` override
for buttons inside one yet).

## Shutdown

One `app` singleton per process. `app.init()` is called implicitly by the first
`BuniumWindow`; call `app.shutdown()` to stop the pump loop and tear down CEF.

```ts
import { app } from "bunium";

app.setAppRoot("/abs/path/to/dist"); // once, before any bunium:// loadURL
app.shutdown();                      // clean exit; also before relaunch
```

(Phase 9's `relaunchApp()` calls `app.shutdown()` internally — see
[Auto-update](/guide/updates).)
