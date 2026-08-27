# `<bunium-webview>` tag

Embed another page as a real DOM element, composited as a native sublayer — not a
windowed child view (that's what makes Electron's own `<webview>` janky). The
compositing primitive is per-platform (`CAMetalLayer` on macOS, an X11 pixmap
sublayer on Linux, a GDI-blitted child region on Windows); the DOM-facing API is
identical everywhere.

## Usage

```html
<bunium-webview src="https://example.com"></bunium-webview>
```

That's it. Declaring the element in a page's HTML alone causes a native sublayer +
CEF view to be created and painted at the element's exact
`getBoundingClientRect()`. Positioning updates live every animation frame (rAF
loop reading `getBoundingClientRect()`, so scroll/reflow-driven moves are covered,
not just size changes via `ResizeObserver`). Changing `src` navigates the embedded
view.

TypeScript/editor awareness: `src/webview-element.d.ts` declares
`HTMLBuniumWebviewElement` (with `src`) and augments `HTMLElementTagNameMap`.
The element itself is injected into every page at runtime by the same bootstrap
that provides `window.__bunium.*`.

## What works

- **Sublayer compositing** — two independent CEF views (separate renderer
  processes) paint as sibling native sublayers in one window.
- **Independent hit-testing** — a click inside the webview's rect routes to the
  embedded page only; outside routes to the outer page. Verified with synthetic
  clicks + per-view pixel readback (`examples/webview-hit-test.ts`).
- **Keyboard routing** — keys go to whichever view most recently received a click
  (`g_last_focused_target`).
- **Overflow clipping** — an ancestor with `overflow: hidden`/`auto`/`scroll`
  visually clips the sublayer to the intersection of the element's rect and every
  clipping ancestor up to `<body>` (same semantics as a real child). Only the
  ancestor's rectangular bounding box is used — `border-radius`/`clip-path` shape
  support is still open.
- **Clip-aware hit-testing** — clicks landing in a clipped-away portion of the
  nominal rect fall through to whatever is visually underneath, matching real DOM
  behavior.
- **Stacking/z-order** — sibling webviews sync to `getComputedStyle(el).zIndex`
  ascending order (unset = `0`, DOM/creation order via sort stability). This is a
  deliberate approximation: full CSS stacking-context semantics (nesting,
  sibling-only comparison within a context) are a much larger, lower-priority
  open item.

## Current gaps

- `border-radius` / CSS `clip-path` on clipping ancestors (rect only today).
- Full stacking-context semantics (see above).
- Drag-region `no-drag` overrides inside a drag region.

## How it works

The injected element sends reserved `__bunium_webview_*` messages over the generic
[typed IPC](/guide/ipc) channel; `BuniumWindow`'s private `WebviewManager` owns the
native sublayer/view pair per element (keyed by the element's generated id) and
tears down via the element's `disconnectedCallback` (or the window's close path).

Related: [Typed IPC](/guide/ipc), [Window](/guide/window),
examples `webview-element-test.ts`, `webview-clip-test.ts`,
`webview-clip-hit-test.ts`, `sublayer-hit-test.ts`.
