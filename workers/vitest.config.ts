import { cloudflareTest } from "@cloudflare/vitest-plugin"
import { defineConfig } from "vitest/config"

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // End-to-end tests through `exports.default.fetch` authenticate with the dev bypass, which only applies to
      // loopback hosts (`http://localhost/...`) while ACCESS_TEAM_DOMAIN/ACCESS_AUD stay empty; other hosts still fail
      // closed (`https://proxy.test/...` answers 500 without Access settings).
      miniflare: { bindings: { ACCESS_DEV_BYPASS: "true" } }
    })
  ],
  test: {
    include: ["test/**/*.test.ts"],
    // The first test in each file pays for module transformation inside workerd; keep generous timeouts.
    testTimeout: 30_000,
    hookTimeout: 30_000
  }
})
