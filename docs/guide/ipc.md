# Typed IPC

bunium's renderer ↔ main communication is one generic transport with typed
message maps — no per-feature bespoke bridges.

- **Renderer → main:** your page calls `window.__bunium.send(name, payload)`; the
  main process dispatches to whatever `win.on(name, listener)` registered.
- **Main → renderer:** `win.emit(name, payload)`; the page's
  `window.__bunium.on(name, handler)` receives it.

## Message maps

Type the contract once, checked on both sides:

```ts
interface MyMessages {
  "user-clicked-thing": { id: string };
  // declare payload shapes per message name — a discriminated union works too
}

const win = new BuniumWindow<MyMessages>({ url: "bunium://app/" });

// payload is typed: { id: string }
win.on("user-clicked-thing", (payload) => {
  console.log(payload.id);
});

// typed push to the page:
win.emit("user-clicked-thing", { id: "42" });
```

On the page side the same names/payloads are agreed by convention — there is no
runtime schema validation, `JSON.parse` is trusted. Both ends (this class and
whatever calls `window.__bunium.send()` in the page) need to agree on the shape.

## In the page

The bootstrap injected into every page provides:

```js
window.__bunium.send("user-clicked-thing", JSON.stringify({ id: "42" }));

window.__bunium.on("my-event", (payload) => {
  // pushed from main via win.emit("my-event", ...)
});
```

## Reserved names

`__bunium_drag_regions`, `__bunium_webview_create/_bounds/_navigate/_destroy/
_clip/_order` are intercepted before the typed `.on()` dispatch — they power the
automatic draggable-region scanner and the `<bunium-webview>` element. Don't
listen for or send them from app code.

## Draggable regions

No manual reporting API. Mark elements with CSS
`-webkit-app-region: drag` (Electron's property) and bunium scans automatically —
on load, resize, and DOM mutation. Known v1 limitation: the whole region is
non-interactive, so don't put clickable buttons inside one yet.

Related: [Window](/guide/window), [System features](/guide/system).
