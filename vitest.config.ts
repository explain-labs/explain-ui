import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

// Unit tests run against plain TS modules (services, schemas), so this config
// only carries the path aliases — not the dev-server plugins in vite.config.ts,
// which need .env.local and a MongoDB.
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "@explain": fileURLToPath(new URL("./explain-engine", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
