# Window

`BuniumWindow` is the main-process handle to one native window and one CEF view.
Typed per the standing requirement — every option, getter, and event is exported.

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
| `titleBarStyle` | `"default" \| "hidden" \| "hiddenInset"` | `"default"` | macOS only. `"hidden"` extends the page under the title bar while keeping the traffic-light buttons in place; `"hiddenInset"` also nudges them to a standard inset position. Ignored on Windows/Linux and on `frame: false` windows. |
| `trafficLightPosition` | `{ x: number; y: number }` | unset | macOS only. Explicit traffic-light position (logical px from the title bar's top-left corner). Only applies with `titleBarStyle: "hidden"`/`"hiddenInset"`. |

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

`frame: false` removes the native title bar/border, including the OS's own
edge-drag resizing — bunium reimplements 6px edge hit-testing for
`frame: false` + `resizable: true` windows (titled and non-resizable windows are
unaffected). To move a frameless window, mark page elements with CSS
`-webkit-app-region: drag` — bunium scans automatically. Note: a drag region is
fully non-interactive (no Electron-style `no-drag` override for buttons inside
one yet).

## Custom title bar (macOS)

```ts
const win = new BuniumWindow({
  url: "bunium://app/",
  titleBarStyle: "hiddenInset",
  trafficLightPosition: { x: 16, y: 16 },
});
```

Lets your page draw its own title bar while keeping the native traffic-light
buttons (close/minimize/zoom) — the same look Electron's `titleBarStyle` +
`trafficLightPosition` produce on macOS. There's no Windows/Linux equivalent
(both platforms ignore these options); use `frame: false` plus a CSS drag
region there instead, same as any other frameless window.

## Shutdown

One `app` singleton per process. `app.init()` is called implicitly by the first
`BuniumWindow`; call `app.shutdown()` to stop the pump loop and tear down CEF.

```ts
import { app } from "bunium";

app.setAppRoot("/abs/path/to/dist"); // once, before any bunium:// loadURL
app.shutdown();                      // clean exit; also before relaunch
```

(`relaunchApp()` calls `app.shutdown()` internally — see
[Auto-update](/guide/updates).)
