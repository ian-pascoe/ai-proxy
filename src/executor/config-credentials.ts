/**
 * Credentials synthesised from config API keys (currently `api-keys.openai-compatibility`) and the model ids they
 * serve.
 *
 * Go source: internal/watcher/synthesizer/config.go (synthesizeOpenAICompat), internal/watcher/synthesizer/helpers.go
 * (addConfigHeadersToAttrs), sdk/cliproxy/service_models.go (buildOpenAICompatibilityConfigModels,
 * buildConfiguredModelInfo, applyModelPrefixes). Ids are derived from config positions (never from key material).
 */
import type { Config, OpenAICompatGroup, RequestScopedErrorRule } from "../config/schema.ts";
import type { JsonObject } from "../json/index.ts";
import { claudeConfigCredentials } from "./claude/config-credentials.ts";
import { openAICompatibleProviderKey } from "./models.ts";
import type { CredentialSnapshot } from "./picker.ts";

export interface ConfigCredential {
  readonly credential: CredentialSnapshot;
  /** Client-visible model ids this credential serves (alias or name, plus `<prefix>/<id>`). */
  readonly models: ReadonlySet<string>;
  readonly priority: number;
}

/** `buildConfiguredModelInfo` ids + `applyModelPrefixes`. */
export const openAICompatModelIds = (
  group: OpenAICompatGroup,
  forceModelPrefix: boolean,
): string[] => {
  const prefix = (group.prefix ?? "").trim();
  const ids: string[] = [];

  const add = (id: string) => {
    if (id !== "" && !ids.includes(id)) ids.push(id);
  };

  for (const model of group.models ?? []) {
    const id = (model.alias ?? "").trim() || model.name.trim();

    if (id === "") continue;

    if (prefix === "") {
      add(id);
      continue;
    }

    if (!forceModelPrefix || prefix === id) add(id);
    add(`${prefix}/${id}`);
  }

  return ids;
};

const headerAttributes = (headers: Readonly<Record<string, string>> | undefined) =>
  Object.fromEntries(
    Object.entries(headers ?? {}).flatMap(([name, value]) => {
      const key = name.trim();
      const val = value.trim();

      return key !== "" && val !== "" ? [[`header:${key}`, val] as const] : [];
    }),
  );

/** Request-scoped error rules as credential metadata (plain JSON, fields kept as configured). */
const ruleMetadata = (rule: RequestScopedErrorRule): JsonObject => {
  const out: JsonObject = {};

  if (rule.status !== undefined) out["status"] = rule.status;

  if (rule.match !== undefined) out["match"] = [...rule.match];

  if (rule["match-regexr"] !== undefined) out["match-regexr"] = [...rule["match-regexr"]];

  if (rule.action !== undefined) out["action"] = rule.action;

  return out;
};

/** All config-backed credentials in configuration order. */
export const configCredentials = (config: Config): ConfigCredential[] => {
  const forceModelPrefix = config.routing["force-model-prefix"];
  const out: ConfigCredential[] = [];
  config["api-keys"]["openai-compatibility"].forEach((group, index) => {
    if (group.disabled === true) return;
    const providerName = group.name.trim().toLowerCase() || "openai-compatibility";
    const provider = openAICompatibleProviderKey(providerName);
    const models = new Set(openAICompatModelIds(group, forceModelPrefix));
    const priority = group.priority ?? 0;

    const base = {
      base_url: group["base-url"].trim(),
      compat_name: group.name,
      provider_key: provider,
      config_index: String(index),
      ...(priority !== 0 ? { priority: String(priority) } : {}),
      ...headerAttributes(group.headers),
    };

    const metadata: JsonObject = {
      ...(group["disable-cooling"] !== undefined
        ? { disable_cooling: group["disable-cooling"] }
        : {}),
      ...(group["request-retry"] !== undefined ? { request_retry: group["request-retry"] } : {}),
      ...(group["request-scoped-errors"] !== undefined
        ? { request_scoped_errors: group["request-scoped-errors"].map(ruleMetadata) }
        : {}),
    };

    const prefix = (group.prefix ?? "").trim();

    const make = (
      keyIndex: number,
      apiKey: string,
      weight: number | undefined,
    ): ConfigCredential => ({
      credential: {
        id: `${provider}#${index}.${keyIndex}`,
        provider,
        kind: "apikey",
        label: group.name,
        ...(prefix !== "" ? { prefix } : {}),
        attributes: {
          ...base,
          source: `config:${providerName}[${index}.${keyIndex}]`,
          ...(weight !== undefined ? { weight: String(weight) } : {}),
          ...(apiKey !== "" ? { api_key: apiKey } : {}),
        },
        metadata,
      },
      models,
      priority,
    });

    if (group.keys.length === 0) {
      out.push(make(0, "", undefined));

      return;
    }

    group.keys.forEach((key, keyIndex) => {
      out.push(make(keyIndex, key["api-key"].trim(), key.weight));
    });
  });
  out.push(...claudeConfigCredentials(config["api-keys"].claude, forceModelPrefix));

  return out;
};
