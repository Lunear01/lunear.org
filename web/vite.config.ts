import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// wrangler dev serves the API on 8787 by default; Vite proxies /api to it in dev,
// while production serves web/dist through the Worker's static assets binding.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // `ws: true` also proxies the /api/tables/:tableId/ws upgrade requests
      // the game table screen opens (S8b) — without it Vite's dev proxy
      // forwards the initial HTTP request but never upgrades the connection.
      "/api": { target: "http://localhost:8787", ws: true },
    },
  },
});
