/// <reference types="vitest/config" />
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

// Same policy as infra/Caddyfile (minus upgrade-insecure-requests, since preview is
// plain http). `pnpm e2e` runs the production build under it, so any CSP break fails.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "font-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

const api = { "/api": { target: "http://127.0.0.1:8000", changeOrigin: false } };

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: "autoUpdate",
      // External registerSW.js (no inline script), so the strict CSP holds.
      injectRegister: "script",
      includeAssets: ["icons/*.png", "icons/*.svg"],
      manifest: {
        name: "Arc Zero",
        short_name: "Arc Zero",
        description: "Ad-free puzzle games. No ads, no tracking.",
        start_url: "/",
        scope: "/",
        display: "standalone",
        orientation: "portrait",
        background_color: "#0b1020",
        theme_color: "#0b1020",
        icons: [
          { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,wasm,png,svg,webmanifest}"],
        // Never cache or fall back for the API: progress always comes from the server.
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [],
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
      },
    }),
  ],
  worker: { format: "es" },
  build: { target: "es2022", sourcemap: false, assetsInlineLimit: 0 },
  server: {
    port: 5173,
    strictPort: true,
    proxy: api,
  },
  preview: {
    port: 4173,
    strictPort: true,
    proxy: api,
    headers: { "Content-Security-Policy": CSP, "X-Content-Type-Options": "nosniff" },
  },
  test: { environment: "node", include: ["src/**/*.test.ts"] },
});
