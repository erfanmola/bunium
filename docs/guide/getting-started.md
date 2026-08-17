# Getting started

bunium is an Electron-like framework: Bun drives a main process, and every window
is rendered by CEF (Chromium Embedded Framework) painted into a native
`CAMetalLayer` — not a WebView. Pages get real Chromium behavior, `prefers-color-scheme`
included.

Requires macOS on Apple Silicon and [Bun](https://bun.sh) ≥ 1.x. The native shim,
CEF framework, and Bun are resolved at runtime from explicit paths — see [Packaging]
(/guide/packaging) for how a packaged app pins its own copies.

## Install

There is no published npm package yet (see [Publishing](/guide/publishing)). Development
consumes `bunium` directly from this repo — either via a `file:` dependency:

```json
{
  "dependencies": {
    "bunium": "file:../bunium"
  }
}
```

or, inside this repo, by importing the source directly. The fast path is the
scaffolder:

```sh
bunx --bun create-bunium-app my-app --template=solid-ts
```

`create-bunium-app` offers `react-ts`, `react-js`, `solid-ts`, `solid-js`,
`vue-ts`, and `vue-js` templates, all Vite-based. Running the scaffolder requires
the native shim built first (`bun run build:native:mac` in the bunium repo).

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

`new BuniumWindow(...)` calls `app.init()` implicitly, which starts the CEF + Cocoa
pump loop. One process = one `BuniumApp`, ever (CEF's singleton process model).

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

Scaffolded apps get an `electron/main.{ts,js}` with exactly that dev/prod branch
(keyed on `NODE_ENV`), scripts for `dev` (concurrently), `build`
(`tsc -b && vite build`), and `start`. See the template's own README comments for
details.

## Verification

The repo ships headless end-to-end examples under `examples/` (exit 0 = pass,
pixel readback via `captureScreenshot()` rather than just "didn't crash"). Run them
sequentially — CEF's per-profile `ProcessSingleton` aborts concurrent processes:

```sh
bun run --cwd examples webview-element-test.ts
```

Related: [Window](/guide/window), [Typed IPC](/guide/ipc), [System features](/guide/system).
