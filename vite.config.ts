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
        // Precache the build assets; SPA fallback for client routes. Never
        // cache the API — those requests must always hit the network.
        navigateFallback: "/index.html",
        navigateFallbackDenylist: [/^\/api/],
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
