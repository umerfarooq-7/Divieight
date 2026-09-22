import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Standalone test config — deliberately not the Lovable/TanStack vite config,
// which pulls in the full SSR/nitro build pipeline.
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
  },
});
