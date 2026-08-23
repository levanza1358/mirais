import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import fs from "node:fs";
import path from "node:path";
// Read the workspace package.json so the sidebar can show the real version.
// (dashboard/ has no own version field; the project version lives at the root.)
const rootPkg = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "..", "package.json"), "utf8"),
) as { version: string };

// Inject at build time so the sidebar shows the exact moment the bundle was
// produced. We pass an ISO timestamp and let main.tsx format it — that keeps
// the displayed time stable across browsers and avoids SSR/locale drift.
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