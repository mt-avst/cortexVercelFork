// Local-only preview config for the PiP spike verification: serves the
// production build (the shape that actually runs on Kubera, where nginx does
// this proxying) because the raw Vite dev server trips over the shared
// environment module's bare process.env references.
import { defineConfig } from "vite";

export default defineConfig({
  build: { outDir: "dist" },
  preview: {
    port: 3100,
    strictPort: true,
    proxy: {
      "/api": "http://localhost:3001",
      "/auth": "http://localhost:3001"
    }
  }
});
