// Plain object config (no `import { defineConfig } from "vite"`) -- this
// fixture intentionally has no package.json/node_modules of its own and
// runs via a cold `bunx vite`, so importing "vite" here for defineConfig's
// type-hint-only wrapper would need it resolvable from this directory,
// which it isn't. Fixed, non-default port + strictPort so the test script
// can hardcode the URL it loadURL()s rather than scraping vite's stdout
// for the chosen port.
export default {
  server: {
    port: 5199,
    strictPort: true,
  },
};
