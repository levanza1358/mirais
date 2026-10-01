import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import fs from "node:fs";

const rootPkg = JSON.parse(
  fs
    .readFileSync(path.resolve(__dirname, "..", "package.json"), "utf8")
    .replace(/^\uFEFF/, ""),
) as { version: string };

const BUILD_TIME_ISO = new Date().toISOString();
const BUILD_VERSION = rootPkg.version;

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  define: {
    __APP_BUILD_TIME__: JSON.stringify(BUILD_TIME_ISO),
    __APP_BUILD_VERSION__: JSON.stringify(BUILD_VERSION),
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