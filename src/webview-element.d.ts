/**
 * Renderer-side type augmentation for the `<bunium-webview>` custom element.
 *
 * The element itself is injected into every page by the native bootstrap (see
 * `WEBVIEW_ELEMENT_JS` in `native/mac/bunium_common.h`) -- this file only adds
 * compiler/editor awareness of it for app code that runs *inside* a bunium
 * window and uses `<bunium-webview>` in its HTML.
 *
 * This file deliberately references DOM types (`HTMLElement`,
 * `HTMLElementTagNameMap`): it is meant to be shipped to renderer consumers
 * with a DOM-aware `tsconfig` (`lib: ["DOM", ...]`). It is kept out of the
 * root `src/` typecheck (which has no DOM lib) via `skipLibCheck`.
 *
 * Importing `bunium` once (e.g. `import "bunium"` side effect, or the main
 * process entry) pulls this augmentation in; alternatively
 * `import "bunium/webview-element"`.
 */

declare global {
  /** A `<bunium-webview>` element -- an embedded CEF page, positioned like a
   *  real DOM element and receiving its own input. See WEBVIEW_ELEMENT_JS. */
  interface HTMLBuniumWebviewElement extends HTMLElement {
    /**
     * The URL of the embedded page. Setting it after connect navigates the
     * webview's own CEF view (the value sent when the element is created is
     * also taken from this attribute). `null` when the attribute is absent.
     */
    src: string | null;
  }

  interface HTMLElementTagNameMap {
    "bunium-webview": HTMLBuniumWebviewElement;
  }
}

export {};
