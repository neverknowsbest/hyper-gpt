import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "frontend",
  plugins: [react()],
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
