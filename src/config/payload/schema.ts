/**
 * Schema for `requests.payload` (legacy top-level `payload`).
 *
 * Go source: internal/config/config_types.go (PayloadConfig, PayloadRule, PayloadFilterRule, PayloadModelRule).
 * Every field is optional like the Go zero values; the engine treats missing values as empty.
 */
import { Effect, Schema } from "effect"

/** Parameter values are arbitrary JSON (`null` is a meaningful value for `override`). */
const ParamValue = Schema.MutableJson

export const PayloadModelRule = Schema.Struct({
  /** Model name or `*` wildcard pattern (`gpt-*`, `*-5`, `gemini-*-pro`). */
  name: Schema.optionalKey(Schema.String),
  /** Target (provider) protocol, case-insensitive. */
  protocol: Schema.optionalKey(Schema.String),
  /** Header name -> wildcard pattern; every entry must match. */
  headers: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  /** Source (client) protocol; `openai-response(s)`/`response` normalise to `responses`. */
  "from-protocol": Schema.optionalKey(Schema.String),
  /** Every `path: value` pair must be present and equal. */
  match: Schema.optionalKey(Schema.Array(Schema.Record(Schema.String, ParamValue))),
  /** No `path: value` pair may match. */
  "not-match": Schema.optionalKey(Schema.Array(Schema.Record(Schema.String, ParamValue))),
  /** Paths that must exist and not be null. */
  exist: Schema.optionalKey(Schema.Array(Schema.String)),
  /** Paths that must be missing or null. */
  "not-exist": Schema.optionalKey(Schema.Array(Schema.String))
})

export type PayloadModelRule = typeof PayloadModelRule.Type

export const PayloadRule = Schema.Struct({
  models: Schema.optionalKey(Schema.Array(PayloadModelRule)),
  /** gjson/sjson path -> value (`*-raw` rules: raw JSON text or any JSON value). */
  params: Schema.optionalKey(Schema.Record(Schema.String, ParamValue))
})

export type PayloadRule = typeof PayloadRule.Type

export const PayloadFilterRule = Schema.Struct({
  models: Schema.optionalKey(Schema.Array(PayloadModelRule)),
  /** Paths to delete. */
  params: Schema.optionalKey(Schema.Array(Schema.String))
})

export type PayloadFilterRule = typeof PayloadFilterRule.Type

const RuleList = Schema.Array(PayloadRule).pipe(Schema.withDecodingDefaultKey(Effect.succeed([])))

const FilterRuleList = Schema.Array(PayloadFilterRule).pipe(Schema.withDecodingDefaultKey(Effect.succeed([])))

export const PayloadConfig = Schema.Struct({
  default: RuleList,
  "default-raw": RuleList,
  override: RuleList,
  "override-raw": RuleList,
  filter: FilterRuleList
})

export type PayloadConfig = typeof PayloadConfig.Type
