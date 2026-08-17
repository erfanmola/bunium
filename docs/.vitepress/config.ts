import { defineConfig } from "vitepress";

// Typed per the standing cross-cutting requirement: all public API
// surfaces are typed in `src/`, docs transpose them rather than invent.
export default defineConfig({
  title: "bunium",
  description: "Electron-like framework: Bun + CEF + TypeScript",
  // GitHub Pages serves project pages under /<repo>/ (here /bunium/). The
  // Docs workflow sets BUNIUM_DOCS_BASE accordingly; unset locally means
  // the default site root is correct (dev server, or a root-domain site).
  base: process.env.BUNIUM_DOCS_BASE ?? "/",
  themeConfig: {
    nav: [
      { text: "Guide", link: "/guide/getting-started" },
      { text: "API", link: "/api/" },
    ],
    sidebar: [
      {
        text: "Guide",
        items: [
          { text: "Getting started", link: "/guide/getting-started" },
          { text: "Window", link: "/guide/window" },
          { text: "Typed IPC", link: "/guide/ipc" },
          { text: "<bunium-webview> tag", link: "/guide/webview" },
          { text: "System features", link: "/guide/system" },
          { text: "Packaging", link: "/guide/packaging" },
          { text: "Auto-update", link: "/guide/updates" },
          { text: "Publishing", link: "/guide/publishing" },
        ],
      },
      {
        text: "API reference",
        items: [{ text: "Exports", link: "/api/" }],
      },
    ],
    // Trim archive is dark-mode friendly; leave the default theme alone.
    footer: {
      message:
        "macOS support only — Linux (Phase 6) and Windows (Phase 7) are planned.",
    },
  },
});
