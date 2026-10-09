import { cloudflareTest } from "@cloudflare/vitest-plugin"
import { defineConfig } from "vitest/config"

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
  test: {
    include: ["test/**/*.test.ts"],
    // The first test in each file pays for module transformation inside workerd; keep generous timeouts.
    testTimeout: 30_000,
    hookTimeout: 30_000
  }
})
