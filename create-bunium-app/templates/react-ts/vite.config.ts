import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Base "/" matters for prod: the bunium main process serves the built
// output through the custom "bunium://app/" scheme (see
// app.setAppRoot() + BuniumSchemeHandlerFactory), so asset URLs must
// resolve relative to that scheme root, same as they would for any
// normal static site -- no special base needed beyond Vite's default.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
  },
});
