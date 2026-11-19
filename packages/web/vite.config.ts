import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { createHubDevProxy } from "./dev-proxy";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": createHubDevProxy("http://127.0.0.1:7788"),
      "/ws": createHubDevProxy("http://127.0.0.1:7788"),
    },
  },
});
