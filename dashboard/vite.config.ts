import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  define: {
    __APP_BUILD_TIME__: JSON.stringify(new Date().toLocaleString("sv-SE", { hour12: false }).replace(" ", " ")),
    __APP_BUILD_VERSION__: JSON.stringify(new Date().toISOString().replace(/[.:]/g, "-") ),
  },
  plugins: [react(), tailwindcss()],
  server: {
    port: 5463,
    proxy: {
      "/api": "http://localhost:1463",
      "/health": "http://localhost:1463",
    },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
  },
});
