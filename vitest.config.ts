import { cloudflareTest } from "@cloudflare/vitest-plugin"
import { defineConfig } from "vitest/config"

// The test Worker mirrors the deployed one declared in alchemy.run.ts (same entry, compatibility settings and binding
// names); there is no Wrangler configuration file.
export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./src/index.ts",
      miniflare: {
        compatibilityDate: "2026-08-01",
        compatibilityFlags: ["nodejs_compat"],
        // Same module types as the deployed bundle (alchemy.run.ts): tokenizer ranks are `Data` modules (ArrayBuffer).
        modulesRules: [{ type: "Data", include: ["**/*.bin"] }],
        durableObjects: {
          CONTROL_PLANE: { className: "ControlPlane", useSQLite: true },
          SESSION_STATE: { className: "SessionState", useSQLite: true }
        },
        kvNamespaces: ["CACHE"],
        d1Databases: ["USAGE"],
        assets: {
          directory: "./public",
          binding: "ASSETS",
          routerConfig: { invoke_user_worker_ahead_of_assets: true }
        },
        bindings: {
          ACCESS_TEAM_DOMAIN: "",
          ACCESS_AUD: "",
          ACCESS_ADMIN_EMAILS: "",
          ACCESS_ADMIN_SERVICE_TOKENS: "",
          // End-to-end tests through `exports.default.fetch` authenticate with the dev bypass, which only applies to
          // loopback hosts (`http://localhost/...`) while ACCESS_TEAM_DOMAIN/ACCESS_AUD stay empty; other hosts still
          // fail closed (`https://proxy.test/...` answers 500 without Access settings).
          ACCESS_DEV_BYPASS: "true",
          USAGE_RETENTION_DAYS: "30",
          META_MINT_URL: ""
        }
      }
    })
  ],
  test: {
    include: ["test/**/*.test.ts"],
    // The first test in each file pays for module transformation inside workerd; keep generous timeouts.
    testTimeout: 30_000,
    hookTimeout: 30_000
  }
})
