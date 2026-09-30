/// <reference types="vite/client" />

// Set by vite.config.ts `define`: true when the dev server has MONGODB_URI.
declare const __EXPLAIN_DEV_DB__: boolean;

declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent<{}, {}, any>;
  export default component;
}
