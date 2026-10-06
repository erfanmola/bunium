# Guest views

`BuniumWindow.createGuest()` composites an untrusted page into a native window. The guest does not receive Bunium host IPC or `window.__bunium`; use the document-start bridge to provide only the page capability it needs.

```ts
const guest = win.createGuest({
  url: "https://example.com/",
  width: 390,
  height: 700,
  x: 0,
  y: 0,
  bridgeScript: `function (post) {
    window.TelegramWebviewProxy = { postEvent: post };
    return (data) => window.dispatchEvent(
      new MessageEvent("message", { data })
    );
  }`,
});

guest.onEvent((event) => {
  if (event.type === "load") console.log(event.generation, event.url);
});
guest.onMessage(({ generation, data }) => {
  console.log(generation, data);
});

guest.navigate("https://example.com/next");
guest.reload();
guest.setBounds({ x: 0, y: 0, width: 390, height: 700 });
guest.setClip({ x: 24, y: 24, width: 342, height: 652, cornerRadius: 20 });
guest.dispose();
```

On the macOS native candidate, a trusted simulator may set a mock location on
one Guest with `guest.setGeolocationOverride({ latitude, longitude, accuracy
})` and remove it with `guest.clearGeolocationOverride()`. The override uses
that Guest's CEF DevTools Protocol target and its permission handler grants
only geolocation for the Guest's current top-level origin while the override
is active; it does not query or change host operating-system location
permission. Chromium's Permissions Policy blocks cross-origin iframe access
by default. A Guest page can explicitly delegate geolocation with an iframe
`allow` attribute, in which case the frame uses that Guest's mock. The
override is restored after a page reload or renderer recovery. These methods
are runtime candidate APIs and are not present in the currently pinned public
Bunium package; other operating systems remain unsupported and unqualified.

`setClip()` applies a native rectangular or uniform rounded clip in
window-local CSS pixels. Passing `null` clears it. Rounded corner clipping and
clip-aware pointer routing are currently implemented on macOS. Host DOM menus
that overlap native guests are still covered by the guest layers; host overlay
compositing is not yet supported.

`url` and later navigation targets must be credential-free HTTP or HTTPS URLs. The bridge is injected into each main-frame document before page scripts run; subframes do not receive its native `post` capability. The supplied function body receives `post(string)` and may return a receiver function for host-to-guest messages. Keep that receiver narrow: guest page content is untrusted.

Each committed document has a monotonically increasing `generation`. Messages carry that generation. `guest.post(generation, data)` returns `false` for stale or disposed documents, so asynchronous replies cannot be sent into a later navigation by mistake. `GuestEvent` reports `document`, `load`, `load-error`, `crashed` and `disposed`. `GuestMessage` carries the source generation and data.

Pass a `BuniumSession` in `session` to bind the guest to a storage partition; omitted `session` uses the shared global context. The window pumps guest events and disposes its guests when it closes. Call `dispose()` when a guest is removed earlier.
