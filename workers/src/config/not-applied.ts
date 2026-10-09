/**
 * Config keys that the Workers schema accepts (so Go documents import unchanged) but that have no effect on Workers.
 * New in the Workers port; the list is documented in docs/workers-port/MIGRATION.md ("Not applied on Workers") and
 * a warning naming the keys that are set is logged when a config document is stored.
 */
import type { ApiKeyEntry, Config } from "./schema.ts"

interface NotAppliedRule {
  readonly key: string
  readonly isSet: (config: Config) => boolean
}

const claudeKeys = (config: Config): ReadonlyArray<ApiKeyEntry> =>
  config["api-keys"].claude.flatMap((group) => group.keys)

const RULES: ReadonlyArray<NotAppliedRule> = [
  { key: "access.api-keys", isSet: (config) => config.access["api-keys"].length > 0 },
  { key: "requests.proxy-url", isSet: (config) => config.requests["proxy-url"].trim() !== "" },
  {
    key: "requests.nonstream-keepalive-interval",
    isSet: (config) => config.requests["nonstream-keepalive-interval"] > 0
  },
  { key: "upstream.codex.response-steering", isSet: (config) => config.upstream.codex["response-steering"] },
  {
    key: "upstream.claude.header-defaults.stabilize-device-profile",
    isSet: (config) => config.upstream.claude["header-defaults"]["stabilize-device-profile"] !== undefined
  },
  {
    key: "api-keys.claude[].keys[].experimental-cch-signing",
    isSet: (config) => claudeKeys(config).some((key) => key["experimental-cch-signing"] !== undefined)
  },
  {
    key: "api-keys.claude[].keys[].rebuild-mid-system-message",
    isSet: (config) => claudeKeys(config).some((key) => key["rebuild-mid-system-message"] === true)
  },
  { key: "observability.logs.debug", isSet: (config) => config.observability.logs.debug },
  { key: "observability.logs.request-log", isSet: (config) => config.observability.logs["request-log"] },
  {
    key: "observability.usage.usage-statistics-enabled",
    isSet: (config) => config.observability.usage["usage-statistics-enabled"]
  },
  {
    key: "observability.usage.redis-usage-queue-retention-seconds",
    isSet: (config) => config.observability.usage["redis-usage-queue-retention-seconds"] !== 60
  }
]

/** Keys of {@link RULES} that `config` sets to a non-default value, in a stable order. */
export const notAppliedSettings = (config: Config): ReadonlyArray<string> =>
  RULES.filter((rule) => rule.isSet(config)).map((rule) => rule.key)
