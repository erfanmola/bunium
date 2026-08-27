# Getting started

bunium is an Electron-like framework: Bun drives a main process, and every window
is rendered by CEF (Chromium Embedded Framework) painted into a native layer — not
a system WebView. Pages get real Chromium behavior, `prefers-color-scheme` included.

Requires [Bun](https://bun.sh) ≥ 1.x, on macOS, Linux, or Windows. The right native
CEF binaries for your platform install automatically as part of `bunium` — nothing
to build yourself.

## Quickstart

```sh
bunx --bun create-bunium-app my-app --template=solid-ts
cd my-app
bun install
bun dev
```

Templates: `react-ts`, `react-js`, `solid-ts`, `solid-js`, `vue-ts`, `vue-js` — all
Vite-based.

## Install into an existing project

```sh
bun add bunium
```

## Minimal app

```ts
import { app, BuniumWindow } from "bunium";

const win = new BuniumWindow({
  url: "https://example.com",
  width: 1024,
  height: 700,
  title: "Hello",
});

win.onClose(() => {
  console.log("window closed");
  app.shutdown();
});
```

`new BuniumWindow(...)` starts the app automatically. One `bunium` app per
process — don't try to run two.

## Dev vs prod

Dev: `loadURL(http://localhost:5173/)` against a running Vite dev server. HMR works
for free — a bunium window is a real Chromium tab.

Prod: point at built static output, then load over the custom `bunium://` scheme:

```ts
import { app, BuniumWindow } from "bunium";

app.setAppRoot(`${import.meta.dir}/../dist`);
const win = new BuniumWindow({ url: "bunium://app/" });
```

`bunium://app/<path>` resolves against the app root with real MIME types, relative
`<script src>`/`fetch()`/`<link>` support, and clean 404s. Call `setAppRoot` once,
before any window `loadURL()`s a `bunium://` URL.

## The scaffold template

Scaffolded apps get a `bunium/main.{ts,js}` with exactly that dev/prod branch
(keyed on `NODE_ENV`), scripts for `dev` (concurrently), `build`
(`tsc -b && vite build`), and `start`. See the template's own README comments for
details.

## Shipping your app

See [Packaging](/guide/packaging) for producing a distributable `.app`/`.exe`/
`.deb`/AppImage, and [Auto-update](/guide/updates) for shipping updates to it.

Related: [Window](/guide/window), [Typed IPC](/guide/ipc),
[`<bunium-webview>`](/guide/webview), [System features](/guide/system).
