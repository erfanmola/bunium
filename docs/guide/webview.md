# `<bunium-webview>` tag

Embed another page as a real DOM element, composited as a native sublayer — not a
windowed child view (that's what makes Electron's own `<webview>` janky).

## Usage

```html
<bunium-webview src="https://example.com"></bunium-webview>
```

That's it. Declaring the element in a page's HTML creates and paints a native
view at the element's exact position, tracking scroll/resize/reflow live.
Changing `src` navigates the embedded view.

Each element is a separate CEF view and native compositor surface. This matters
when it overlaps a `BuniumGuest`: the outer page is delivered as one flattened
CEF paint, so CSS `z-index` cannot lift part of that page above a native guest.
If host-authored content must paint or receive input above a guest, render that
content in its own `<bunium-webview>` and order it above the guest. The native
compositor and hit tester then target the same topmost surface. A native desktop
fixture verifies this with an overlapping menu, two guests, resize and pointer
coordinates.

`<bunium-webview>` contents do not inherit the Bunium host bridge. Keep native
capabilities and privileged actions in the trusted host page; validate any
messages used to coordinate a separate surface.

## Trusted host overlays

For host-authored chrome that must overlap native guests, use a trusted
`BuniumOverlay`. It creates an independent transparent CEF surface and inherits
the parent window's exact `trustedOrigins` allowlist and storage session. The
initial URL and later `navigate()` calls must stay within that allowlist.

```ts
const menu = window.createOverlay({
  url: "bunium://app/chrome/menu.html",
  x: 24,
  y: 48,
  width: 280,
  height: 160,
});
menu.on("menu-action", (payload) => handleMenuAction(payload));
```

Bounds and rectangular clips use window-local logical pixels. Hit testing uses
the overlay's visible rect/clip; transparent pixels inside that area still
receive input, so keep bounds tight. Overlay IPC is independent from the
primary page's queue. Because its origin is trusted, its renderer has the same
native bridge authority as the host page; do not use this API for untrusted
content. Transparent trusted overlays are currently supported on macOS only;
Windows and Linux remain unqualified.

TypeScript/editor awareness comes built in: `HTMLBuniumWebviewElement` (with
`src`) augments `HTMLElementTagNameMap`.

## What works

- **Independent hit-testing** — a click inside the webview's rect routes to the
  embedded page only; outside routes to the outer page.
- **Keyboard routing** — keys go to whichever view most recently received a
  click.
- **Overflow clipping** — an ancestor with `overflow: hidden`/`auto`/`scroll`
  visually clips the webview to the intersection of the element's rect and every
  clipping ancestor up to `<body>` (same semantics as a real child element). Only
  the ancestor's rectangular bounding box is used — `border-radius`/`clip-path`
  shape support is still open.
- **Clip-aware hit-testing** — clicks landing in a clipped-away portion of the
  nominal rect fall through to whatever is visually underneath, matching real DOM
  behavior.
- **Stacking/z-order** — sibling webviews sync to `getComputedStyle(el).zIndex`.
  This is a deliberate approximation: full CSS stacking-context semantics
  (nesting, sibling-only comparison within a context) are a larger,
  lower-priority open item.
- **Host/guest composition** — the native host menu path requires an independent
  surface. A DOM element painted into the primary CEF surface remains below
  guest surfaces, regardless of its CSS z-index.
- **Trusted overlay platform support** — the explicit `BuniumOverlay` API is
  macOS-only until native alpha composition and input order pass on Windows and
  Linux.

## Current gaps

- `border-radius` / CSS `clip-path` on clipping ancestors (rect only today).
- Full stacking-context semantics (see above).
- Drag-region `no-drag` overrides inside a drag region.

Related: [Typed IPC](/guide/ipc), [Window](/guide/window).
