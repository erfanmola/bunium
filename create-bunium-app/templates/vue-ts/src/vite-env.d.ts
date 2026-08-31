/// <reference types="vite/client" />

declare module "*.vue" {
  import type { DefineComponent } from "vue";

  // biome-ignore lint/complexity/noBannedTypes: standard Vue SFC type shim (matches create-vue's own generated shim); the actual component type is inferred by vue-tsc.
  // biome-ignore lint/suspicious/noExplicitAny: standard Vue SFC type shim (matches create-vue's own generated shim); the actual component type is inferred by vue-tsc.
  const component: DefineComponent<{}, {}, any>;
  export default component;
}
