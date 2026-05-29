import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  root: "frontend",
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      // Ship the SVG + generated PNG icons as static assets.
      includeAssets: ["icon.svg", "apple-touch-icon.png"],
      manifest: {
        name: "HyperGPT",
        short_name: "HyperGPT",
        description: "A personal knowledge graph made of AI conversations.",
        start_url: "/",
        display: "standalone",
        background_color: "#111111",
        theme_color: "#111111",
        icons: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
          {
            src: "/icon-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      workbox: {
        // Network-first, not precache. We're always online and deploy often;
        // a cache-first precache made deploys invisible until the SW updated
        // (which Safari does sluggishly). Precache nothing; serve same-origin
        // requests network-first so online always gets the latest build, with
        // the cache only as an offline fallback. /api is left untouched so it
        // always hits the network (SSE streaming included).
        globPatterns: [],
        // vite-plugin-pwa defaults this to index.html (SPA precache nav);
        // null disables it so navigations go through the NetworkFirst route.
        navigateFallback: null,
        runtimeCaching: [
          {
            urlPattern: ({ url }) =>
              url.origin === self.location.origin &&
              !url.pathname.startsWith("/api"),
            handler: "NetworkFirst",
            options: {
              cacheName: "hypergpt-app",
              networkTimeoutSeconds: 4, // fall back to cache if offline/slow
              expiration: { maxEntries: 100 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
      // Keep the service worker out of dev so it doesn't fight HMR.
      devOptions: { enabled: false },
    }),
  ],
  server: {
    // Loopback-only by default (safe on any network). Set HOST_LAN=1 to bind
    // 0.0.0.0 for phone testing — only do that on a trusted network, since
    // the dev server has no auth and proxies to the API.
    host: process.env.HOST_LAN === "1" ? true : "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": "http://localhost:3000",
    },
  },
  build: {
    outDir: "../dist/frontend",
    emptyOutDir: true,
  },
});
