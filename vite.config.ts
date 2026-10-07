import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { resolve } from "node:path";

/**
 * "@luck-cays/shared" points at src/shared: the API contract (zod schemas, response types,
 * chip formatting) copied from the original monorepo so this app runs on its own.
 */
export default defineConfig({
  plugins: [vue()],

  resolve: {
    alias: {
      "@": resolve(import.meta.dirname, "src"),
      "@luck-cays/shared": resolve(import.meta.dirname, "src/shared/index.ts"),
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
