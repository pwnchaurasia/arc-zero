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

// Where /api is proxied. Docker e2e sets API_PROXY_TARGET=http://api:8000.
const api = {
  "/api": { target: process.env.API_PROXY_TARGET ?? "http://127.0.0.1:8000", changeOrigin: false },
};

// Host names `vite preview` accepts besides localhost (Docker e2e reaches it as "web").
const previewHosts = process.env.PREVIEW_ALLOWED_HOSTS?.split(",").filter(Boolean);

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      // A new version waits until the player is on the home screen (src/state/updates.ts),
      // so an update never reloads the page in the middle of a level.
      registerType: "prompt",
      // Registered from our own bundle (no inline script), so the strict CSP holds.
      injectRegister: false,
      includeAssets: ["icons/*.png", "icons/*.svg", "games/*.webp"],
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
        // Hashed files only. The page itself is never served from the precache: it
        // always comes from the network first (below), so a deploy shows on the next open.
        globPatterns: ["**/*.{js,css,wasm,png,svg,webp,webmanifest}"],
        navigateFallback: null,
        runtimeCaching: [
          {
            // Never the API: progress always comes from the server.
            urlPattern: ({ request, url }) => request.mode === "navigate" && !url.pathname.startsWith("/api/"),
            handler: "NetworkFirst",
            // The saved copy is only for opening the installed app offline.
            options: { cacheName: "pages", networkTimeoutSeconds: 4, expiration: { maxEntries: 4 } },
          },
        ],
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
      },
    }),
  ],
  worker: { format: "es" },
  build: { target: "es2022", sourcemap: false, assetsInlineLimit: 0 },
  server: {
    // 5173 belongs to the always-on local arcade (`make local-up`).
    port: 5174,
    strictPort: true,
    proxy: api,
    // `make share`: let friends in through any ngrok address (local dev only).
    ...(process.env.ARC_DEV_TUNNEL === "true"
      ? { allowedHosts: [".ngrok-free.app", ".ngrok.app", ".ngrok.io"] }
      : {}),
  },
  preview: {
    port: 4173,
    strictPort: true,
    proxy: api,
    ...(previewHosts?.length ? { allowedHosts: previewHosts } : {}),
    headers: { "Content-Security-Policy": CSP, "X-Content-Type-Options": "nosniff" },
  },
  test: { environment: "node", include: ["src/**/*.test.ts"] },
});
