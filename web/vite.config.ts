// Vite config of the control panel (web/). `pnpm web:build` writes `public/index.html` and `public/assets/*`, which the
// Worker serves at `/` (src/management/web-panel.ts) next to `public/management.html` (the upstream panel, installed by
// `pnpm panel:sync`). `pnpm web:dev` serves the panel with hot reload and forwards `/v8` to a running `pnpm dev` Worker.
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const outDir = fileURLToPath(new URL("../public", import.meta.url));

/** `pnpm dev` Worker the dev server forwards API calls to. */
const workerUrl = process.env["CLIPROXY_DEV_URL"] ?? "http://localhost:1337";

/**
 * `public/` also holds `management.html`, so the build cannot empty its output directory: remove only the previous
 * panel build (stale hashed bundles would otherwise be deployed).
 */
const cleanPreviousBuild = (): Plugin => ({
  name: "cliproxy:clean-previous-build",
  apply: "build",
  async buildStart() {
    await rm(`${outDir}/assets`, { recursive: true, force: true });
    await rm(`${outDir}/index.html`, { force: true });
  },
});

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  publicDir: false,
  plugins: [react(), cleanPreviousBuild()],
  build: {
    outDir,
    emptyOutDir: false,
    assetsDir: "assets",
    target: "es2023",
    sourcemap: true,
    // Effect, React and the router make one ~165 kB (gzip) bundle; the panel is a single admin page, so it is not split.
    chunkSizeWarningLimit: 800,
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // The Worker refuses management calls whose Origin is another host (src/access/csrf.ts); present the Worker's
      // own origin, as the deployed panel does.
      "/v8": {
        target: workerUrl,
        changeOrigin: true,
        headers: { origin: workerUrl },
      },
    },
  },
});
