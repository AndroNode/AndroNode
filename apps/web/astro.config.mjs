import { defineConfig } from "astro/config";
import react from "@astrojs/react";
import sitemap from "@astrojs/sitemap";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  site: process.env.SITE_URL ?? "https://andronode.example",
  output: "static",
  trailingSlash: "never",
  build: { format: "file" },
  integrations: [react(), sitemap()],
  // Never inline page scripts: the client router re-runs inline module scripts as data: URLs, which the CSP blocks.
  vite: { plugins: [tailwindcss()], build: { assetsInlineLimit: 0 } },
  prefetch: { prefetchAll: true, defaultStrategy: "hover" },
});
