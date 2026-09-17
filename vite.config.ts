import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const board = `127.0.0.1:${process.env.BOARD_PORT ?? 3170}`;

// The board UI lives in web/ and is built into dist/web, which the server serves.
// `npm run dev:web` runs Vite with hot reload and proxies the server routes
// (to BOARD_PORT, default 3170).
export default defineConfig({
  root: "web",
  plugins: [react()],
  build: { outDir: "../dist/web", emptyOutDir: true, chunkSizeWarningLimit: 5000 },
  server: {
    port: Number(process.env.WEB_PORT ?? 5173),
    proxy: {
      "/api": `http://${board}`,
      "/ws": { target: `ws://${board}`, ws: true },
    },
  },
});
