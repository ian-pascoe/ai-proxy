/**
 * Credentials synthesised from config API keys (currently `api-keys.openai-compatibility`) and the model ids they
 * serve.
 *
 * Go source: internal/watcher/synthesizer/config.go (synthesizeOpenAICompat), internal/watcher/synthesizer/helpers.go
 * (addConfigHeadersToAttrs), sdk/cliproxy/service_models.go (buildOpenAICompatibilityConfigModels,
 * buildConfiguredModelInfo, applyModelPrefixes). Ids are derived from config positions (never from key material).
 */
import type { Config, OpenAICompatGroup } from "../config/schema.ts"
import { claudeConfigCredentials } from "./claude/config-credentials.ts"
import { openAICompatibleProviderKey } from "./models.ts"
import type { CredentialSnapshot } from "./picker.ts"

export interface ConfigCredential {
  readonly credential: CredentialSnapshot
  /** Client-visible model ids this credential serves (alias or name, plus `<prefix>/<id>`). */
  readonly models: ReadonlySet<string>
  readonly priority: number
}

/** `buildConfiguredModelInfo` ids + `applyModelPrefixes`. */
export const openAICompatModelIds = (group: OpenAICompatGroup, forceModelPrefix: boolean): string[] => {
  const prefix = (group.prefix ?? "").trim()
  const ids: string[] = []

  const add = (id: string) => {
    if (id !== "" && !ids.includes(id)) ids.push(id)
  }

  for (const model of group.models ?? []) {
    const id = (model.alias ?? "").trim() || model.name.trim()

    if (id === "") continue

    if (prefix === "") {
      add(id)
      continue
    }

    if (!forceModelPrefix || prefix === id) add(id)
    add(`${prefix}/${id}`)
  }

  return ids
}

const headerAttributes = (headers: Readonly<Record<string, string>> | undefined): Record<string, string> => {
  const out: Record<string, string> = {}

  for (const [name, value] of Object.entries(headers ?? {})) {
    const key = name.trim()
    const val = value.trim()

    if (key !== "" && val !== "") out[`header:${key}`] = val
  }

  return out
}

/** All config-backed credentials in configuration order. */
export const configCredentials = (config: Config): ConfigCredential[] => {
  const forceModelPrefix = config.routing["force-model-prefix"]
  const out: ConfigCredential[] = []
  config["api-keys"]["openai-compatibility"].forEach((group, index) => {
    if (group.disabled === true) return
    const providerName = group.name.trim().toLowerCase() || "openai-compatibility"
    const provider = openAICompatibleProviderKey(providerName)
    const models = new Set(openAICompatModelIds(group, forceModelPrefix))
    const priority = group.priority ?? 0

    const base: Record<string, string> = {
      base_url: group["base-url"].trim(),
      compat_name: group.name,
      provider_key: provider,
      config_index: String(index),
      ...(priority !== 0 ? { priority: String(priority) } : {}),
      ...headerAttributes(group.headers)
    }

    const metadata: Record<string, unknown> = {
      ...(group["disable-cooling"] !== undefined ? { disable_cooling: group["disable-cooling"] } : {}),
      ...(group["request-retry"] !== undefined ? { request_retry: group["request-retry"] } : {}),
      ...(group["request-scoped-errors"] !== undefined ? { request_scoped_errors: group["request-scoped-errors"] } : {})
    }

    const prefix = (group.prefix ?? "").trim()

    const make = (keyIndex: number, apiKey: string, weight: number | undefined): ConfigCredential => ({
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
          ...(apiKey !== "" ? { api_key: apiKey } : {})
        },
        metadata
      },
      models,
      priority
    })

    if (group.keys.length === 0) {
      out.push(make(0, "", undefined))

      return
    }

    group.keys.forEach((key, keyIndex) => {
      out.push(make(keyIndex, key["api-key"].trim(), key.weight))
    })
  })
  out.push(...claudeConfigCredentials(config["api-keys"].claude, forceModelPrefix))

  return out
}
