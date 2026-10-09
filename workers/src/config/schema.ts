/**
 * Config schema: the v8 YAML/JSON layout, restricted to the keys that apply on Workers.
 *
 * Go source: internal/config/config_types.go, sdk_config.go, config_v8.go (layout), docs/workers-port/research/
 * config-management-oauth.md §1. Keys that cannot exist on Workers (listener/TLS/mDNS, filesystem logging, pprof,
 * plugins, Home mode, WebRTC relay, outbound proxies, AI Studio relay) are not modelled and are dropped when a
 * document is decoded.
 *
 * The decoded value (`Config`) always has every section and every defaulted field present, so consumers never
 * handle missing values. Tri-state Go pointer fields (`*bool`, `*int`) stay optional. Keys keep their kebab-case YAML
 * spelling so the stored document is the same as the YAML/management representation.
 */
import { Effect, Schema } from "effect"
import { PayloadConfig } from "./payload/schema.ts"

// --- field helpers -------------------------------------------------------------------------------------------------

const flag = (value: boolean) => Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(value)))
const text = (value = "") => Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed(value)))
const whole = (value: number) => Schema.Int.pipe(Schema.withDecodingDefaultKey(Effect.succeed(value)))
const section = <const Fields extends Schema.Struct.Fields>(fields: Fields) =>
  // `{}` is valid because every field of a section carries a decoding default.
  Schema.Struct(fields).pipe(Schema.withDecodingDefaultKey(Effect.succeed({} as never)))
const list = <S extends Schema.Constraint>(item: S) =>
  Schema.Array(item).pipe(Schema.withDecodingDefaultKey(Effect.succeed([] as never)))
const optional = Schema.optionalKey

const Strings = Schema.Array(Schema.String)
const StringMap = Schema.Record(Schema.String, Schema.String)
/** Credential weight (internal/credentialweight): any integer, but at most 1,000,000. */
const Weight = Schema.Int.check(Schema.isLessThanOrEqualTo(1_000_000))

// --- shared pieces -------------------------------------------------------------------------------------------------

export const RequestScopedErrorRule = Schema.Struct({
  status: optional(Schema.Int),
  match: optional(Strings),
  "match-regexr": optional(Strings),
  /** `stop`, `stop-and-cooldown`, `continue` or `continue-and-cooldown`. */
  action: optional(Schema.String)
})
export type RequestScopedErrorRule = typeof RequestScopedErrorRule.Type

export const ThinkingSupport = Schema.Struct({
  min: optional(Schema.Int),
  max: optional(Schema.Int),
  "zero-allowed": optional(Schema.Boolean),
  "dynamic-allowed": optional(Schema.Boolean),
  levels: optional(Strings)
})
export type ThinkingSupport = typeof ThinkingSupport.Type

/** Model entry of an API-key group (the union of the per-provider Go model structs). */
export const ModelEntry = Schema.Struct({
  /** Upstream model name. */
  name: Schema.String,
  /** Client-visible alias. */
  alias: optional(Schema.String),
  "display-name": optional(Schema.String),
  "max-context-length": optional(Schema.Int),
  "force-mapping": optional(Schema.Boolean),
  "is-compat": optional(Schema.Boolean),
  thinking: optional(ThinkingSupport),
  /** Codex only. */
  "support-configuration-update": optional(Schema.Boolean),
  /** OpenAI-compatibility only. */
  image: optional(Schema.Boolean),
  "input-modalities": optional(Strings),
  "output-modalities": optional(Strings),
  "use-max-completion-tokens": optional(Schema.Boolean)
})
export type ModelEntry = typeof ModelEntry.Type

export const CloakConfig = Schema.Struct({
  mode: optional(Schema.String),
  "strict-mode": optional(Schema.Boolean),
  "sensitive-words": optional(Strings),
  "cache-user-id": optional(Schema.Boolean)
})
export type CloakConfig = typeof CloakConfig.Type

/** Settings shared by a group and (as overrides) by its keys. A missing key inherits the group value. */
const sharedKeyFields = {
  priority: optional(Schema.Int),
  prefix: optional(Schema.String),
  "proxy-url": optional(Schema.String),
  headers: optional(StringMap),
  models: optional(Schema.Array(ModelEntry)),
  "excluded-models": optional(Strings),
  "disable-cooling": optional(Schema.Boolean),
  "request-retry": optional(Schema.Int),
  "request-scoped-errors": optional(Schema.Array(RequestScopedErrorRule))
}

/** One credential inside an API-key group. */
export const ApiKeyEntry = Schema.Struct({
  "api-key": Schema.String,
  weight: optional(Weight),
  ...sharedKeyFields,
  /** Claude. */
  "rebuild-mid-system-message": optional(Schema.Boolean),
  cloak: optional(CloakConfig),
  "fingerprint-profile": optional(Schema.String),
  "experimental-cch-signing": optional(Schema.Boolean),
  /** Codex / xAI / Meta. */
  websockets: optional(Schema.Boolean),
  "alpha-search": optional(Schema.Boolean),
  "disable-codex-cloaking": optional(Schema.Boolean),
  /** Vertex. */
  interactions: optional(Schema.Boolean)
})
export type ApiKeyEntry = typeof ApiKeyEntry.Type

/** `api-keys.<provider>[]` group: one endpoint, shared settings and a list of keys. */
export const ApiKeyGroup = Schema.Struct({
  name: optional(Schema.String),
  "base-url": optional(Schema.String),
  ...sharedKeyFields,
  keys: Schema.Array(ApiKeyEntry)
})
export type ApiKeyGroup = typeof ApiKeyGroup.Type

export const OpenAICompatKey = Schema.Struct({
  "api-key": Schema.String,
  weight: optional(Weight),
  "proxy-url": optional(Schema.String)
})

/** `api-keys.openai-compatibility[]` group. */
export const OpenAICompatGroup = Schema.Struct({
  name: Schema.String,
  priority: optional(Schema.Int),
  disabled: optional(Schema.Boolean),
  prefix: optional(Schema.String),
  "base-url": Schema.String,
  headers: optional(StringMap),
  models: optional(Schema.Array(ModelEntry)),
  "support-prompt-cache-key": optional(Schema.Boolean),
  "disable-cooling": optional(Schema.Boolean),
  "request-retry": optional(Schema.Int),
  "request-scoped-errors": optional(Schema.Array(RequestScopedErrorRule)),
  keys: Schema.Array(OpenAICompatKey)
})
export type OpenAICompatGroup = typeof OpenAICompatGroup.Type

export const OAuthModelAlias = Schema.Struct({
  name: Schema.String,
  alias: Schema.String,
  fork: optional(Schema.Boolean),
  "display-name": optional(Schema.String),
  "force-mapping": optional(Schema.Boolean)
})
export type OAuthModelAlias = typeof OAuthModelAlias.Type

export const OAuthModelSetting = Schema.Struct({
  name: Schema.String,
  alias: optional(Schema.String),
  "max-context-length": optional(Schema.Int)
})
export type OAuthModelSetting = typeof OAuthModelSetting.Type

// --- sections ------------------------------------------------------------------------------------------------------

/** `routing.strategy` (aliases `wrr`, `ff`, ... are normalised before decoding). */
export const RoutingStrategy = Schema.Literals(["round-robin", "weighted-round-robin", "fill-first"])
export type RoutingStrategy = typeof RoutingStrategy.Type

const routing = section({
  strategy: RoutingStrategy.pipe(Schema.withDecodingDefaultKey(Effect.succeed("round-robin" as const))),
  "session-affinity": flag(false),
  /** Go duration string (`30m`, `1h`); invalid or non-positive values mean 1h (see accessors.ts). */
  "session-affinity-ttl": text("1h"),
  "session-affinity-subagents": flag(true),
  "force-model-prefix": flag(false),
  retry: section({
    "request-retry": whole(0),
    /** 0 = try every credential in a round. */
    "max-retry-credentials": whole(0),
    /** Seconds; non-positive never waits for a cooldown. */
    "max-retry-interval": whole(0)
  }),
  cooldown: section({
    "disable-cooling": flag(false),
    /** Persist cooldown state (in the ControlPlane DO on Workers). */
    "save-cooldown-status": flag(false),
    /** 0 = legacy 60 s, negative disables. */
    "transient-error-cooldown-seconds": whole(0)
  })
})

const requests = section({
  /** Accepted for compatibility; outbound proxies are not available on Workers and the value is ignored. */
  "proxy-url": text(),
  "passthrough-headers": flag(false),
  "nonstream-keepalive-interval": whole(0),
  streaming: section({
    "keepalive-seconds": whole(0),
    "bootstrap-retries": whole(0)
  }),
  payload: PayloadConfig.pipe(Schema.withDecodingDefaultKey(Effect.succeed({} as never)))
})

const claudeHeaderDefaults = section({
  "user-agent": text(),
  "package-version": text(),
  "runtime-version": text(),
  os: text(),
  arch: text(),
  timeout: text(),
  timezone: text(),
  "stabilize-device-profile": optional(Schema.Boolean)
})

const upstream = section({
  codex: section({
    "response-steering": flag(false),
    "disable-codex-cloaking": flag(false),
    "stream-bootstrap-buffering": flag(false),
    /** Go duration or integer seconds; `0`/`none`/`unlimited`/... mean unlimited. */
    "stream-bootstrap-timeout": text("0"),
    "orphan-delegation-compatibility": flag(false),
    "model-level-cooling": flag(false)
  }),
  claude: section({
    "model-level-cooling": flag(false),
    "disable-claude-cloak-mode": flag(false),
    "disable-cloaking-model-list": flag(false),
    "header-defaults": claudeHeaderDefaults
  }),
  xai: section({
    "inject-x-search": flag(false)
  })
})

const apiKeys = section({
  gemini: list(ApiKeyGroup),
  interactions: list(ApiKeyGroup),
  vertex: list(ApiKeyGroup),
  codex: list(ApiKeyGroup),
  claude: list(ApiKeyGroup),
  xai: list(ApiKeyGroup),
  meta: list(ApiKeyGroup),
  "openai-compatibility": list(OpenAICompatGroup)
})

const oauth = section({
  "auth-auto-refresh-workers": whole(0),
  /** channel -> aliases */
  "model-alias": Schema.Record(Schema.String, Schema.Array(OAuthModelAlias)).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed({}))
  ),
  settings: Schema.Record(Schema.String, Schema.Array(OAuthModelSetting)).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed({}))
  ),
  "excluded-models": Schema.Record(Schema.String, Strings).pipe(Schema.withDecodingDefaultKey(Effect.succeed({}))),
  "request-scoped-errors": Schema.Record(Schema.String, Schema.Array(RequestScopedErrorRule)).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed({}))
  ),
  providers: section({
    codex: section({
      "header-defaults": section({
        "user-agent": text(),
        "beta-features": text()
      })
    }),
    antigravity: section({
      "sensitive-words": list(Schema.String),
      "antigravity-credits": flag(false),
      /** Go pointer: missing means enabled. */
      "signature-cache-enabled": optional(Schema.Boolean),
      "signature-bypass-strict": optional(Schema.Boolean)
    }),
    devin: section({
      "sensitive-words": list(Schema.String)
    })
  })
})

/** `multimedia.disable-image-generation`: `false`, `true`, `"chat"` or `"passthrough"`. */
export const DisableImageGeneration = Schema.Union([Schema.Boolean, Schema.Literals(["chat", "passthrough"])])

const multimedia = section({
  "disable-image-generation": DisableImageGeneration.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
  "gpt-image-2-base-model": text(),
  "video-result-auth-cache-ttl": text("3h")
})

const observability = section({
  logs: section({
    debug: flag(false),
    "request-log": flag(false)
  }),
  usage: section({
    "usage-statistics-enabled": flag(false),
    /** Clamped to 1..3600 (<= 0 means 60). */
    "redis-usage-queue-retention-seconds": whole(60)
  })
})

export const Config = Schema.Struct({
  "config-version": Schema.Literal(8).pipe(Schema.withDecodingDefaultKey(Effect.succeed(8 as const))),
  models: section({
    /** http(s) URL of the general model catalog; empty = official source. File paths are not usable on Workers. */
    catalog: text(),
    "codex-catalog": text(),
    "devin-catalog": text()
  }),
  access: section({
    /** Legacy client API keys (migration only; Cloudflare Access is the real authentication). */
    "api-keys": list(Schema.String),
    /** Access user emails allowed to call the management API. */
    "admin-emails": list(Schema.String),
    /** Access service token client ids (`common_name`) allowed to call the management API. */
    "admin-service-tokens": list(Schema.String)
  }),
  routing,
  requests,
  client: section({
    codex: section({
      "enable-apply-patch": flag(false),
      "optimize-multi-agent-v2": flag(false)
    })
  }),
  upstream,
  "api-keys": apiKeys,
  oauth,
  multimedia,
  observability
})
export type Config = typeof Config.Type
export type ConfigEncoded = typeof Config.Encoded

/** The v8 provider family names that may appear under `api-keys`. */
export const API_KEY_FAMILIES = [
  "gemini",
  "interactions",
  "vertex",
  "codex",
  "claude",
  "xai",
  "meta",
  "openai-compatibility"
] as const
export type ApiKeyFamily = (typeof API_KEY_FAMILIES)[number]
