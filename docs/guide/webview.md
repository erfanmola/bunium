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

## Current gaps

- `border-radius` / CSS `clip-path` on clipping ancestors (rect only today).
- Full stacking-context semantics (see above).
- Drag-region `no-drag` overrides inside a drag region.

Related: [Typed IPC](/guide/ipc), [Window](/guide/window).
