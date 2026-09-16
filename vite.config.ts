import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The board UI lives in web/ and is built into dist/web, which the server serves.
// `npm run dev:web` runs Vite with hot reload and proxies the server routes.
export default defineConfig({
  root: "web",
  plugins: [react()],
  build: { outDir: "../dist/web", emptyOutDir: true, chunkSizeWarningLimit: 5000 },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:3170",
      "/ws": { target: "ws://127.0.0.1:3170", ws: true },
    },
  },
});
