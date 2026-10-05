import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { resolve } from "node:path";

/**
 * The shared package is consumed as TypeScript source rather than a built artefact, so
 * editing a zod schema is reflected in the web app without a build step. Vite transpiles it
 * like any other source file.
 */
export default defineConfig({
  plugins: [vue()],

  resolve: {
    alias: {
      "@": resolve(import.meta.dirname, "src"),
      "@luck-cays/shared": resolve(import.meta.dirname, "../../packages/shared/src/index.ts"),
    },
  },

  server: {
    port: 5173,
    strictPort: true,
    /**
     * The API is proxied under /api, so the browser only ever talks to one origin. That
     * keeps the refresh cookie first-party - a `SameSite=Strict` cookie would not be sent
     * cross-origin, so without this the refresh endpoint could not work in development.
     */
    proxy: {
      "/api": { target: "http://localhost:4000", changeOrigin: false },
      "/socket.io": { target: "http://localhost:4000", ws: true, changeOrigin: false },
    },
  },

  build: {
    target: "es2022",
    sourcemap: true,

    rollupOptions: {
      // Two entry points. The main site and the embeddable game share the renderer and the
      // API client but ship as separate pages, so a host embedding one game does not pull
      // down the lobby, the sportsbook or the poker table.
      input: {
        main: resolve(import.meta.dirname, "index.html"),
        game: resolve(import.meta.dirname, "game.html"),
      },
    },
  },
});
