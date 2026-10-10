/**
 * Credentials synthesised from `api-keys.claude` config entries.
 *
 * Go source: internal/watcher/synthesizer/config.go (synthesizeClaudeKeys), sdk/cliproxy/service_models.go
 * (buildClaudeConfigModels). Only the config-only test stand-ins use it (`static-picker.ts`, `ModelProviders.configLayer`),
 * so only explicitly configured models are listed; production routing goes through the model registry
 * (`registry/credential-models.ts`), where keys without `models` serve the static Claude catalog like Go.
 */
import type { ApiKeyGroup } from "../../config/schema.ts";
import type { ConfigCredential } from "../config-credentials.ts";

const headerAttributes = (
  headers: Readonly<Record<string, string>> | undefined,
): Record<string, string> => {
  const out: Record<string, string> = {};

  for (const [name, value] of Object.entries(headers ?? {})) {
    const key = name.trim();
    const val = value.trim();

    if (key !== "" && val !== "") out[`header:${key}`] = val;
  }

  return out;
};

const modelIds = (
  group: ApiKeyGroup,
  entryModels: ApiKeyGroup["models"],
  prefix: string,
  forcePrefix: boolean,
): string[] => {
  const ids: string[] = [];

  const add = (id: string) => {
    if (id !== "" && !ids.includes(id)) ids.push(id);
  };

  for (const model of entryModels ?? group.models ?? []) {
    const id = (model.alias ?? "").trim() || model.name.trim();

    if (id === "") continue;

    if (prefix === "") {
      add(id);
      continue;
    }

    if (!forcePrefix || prefix === id) add(id);
    add(`${prefix}/${id}`);
  }

  return ids;
};

export const claudeConfigCredentials = (
  groups: ReadonlyArray<ApiKeyGroup>,
  forceModelPrefix: boolean,
): ConfigCredential[] => {
  const out: ConfigCredential[] = [];
  groups.forEach((group, groupIndex) => {
    group.keys.forEach((entry, keyIndex) => {
      const apiKey = entry["api-key"].trim();

      if (apiKey === "") return;
      const prefix = (entry.prefix ?? group.prefix ?? "").trim();
      const priority = entry.priority ?? group.priority ?? 0;
      const profile = (entry["fingerprint-profile"] ?? "").trim().toLowerCase();

      const attributes: Record<string, string> = {
        api_key: apiKey,
        auth_kind: "apikey",
        source: `config:claude[${groupIndex}.${keyIndex}]`,
        config_index: `${groupIndex}.${keyIndex}`,
        ...(priority !== 0 ? { priority: String(priority) } : {}),
        ...(entry.weight !== undefined ? { weight: String(entry.weight) } : {}),
        ...(profile !== "" ? { fingerprint_profile: profile } : {}),
        ...(entry["rebuild-mid-system-message"] === true
          ? { rebuild_mid_system_message: "true" }
          : {}),
        ...headerAttributes(group.headers),
        ...headerAttributes(entry.headers),
      };

      const baseUrl = (group["base-url"] ?? "").trim();

      if (baseUrl !== "") attributes.base_url = baseUrl;
      out.push({
        credential: {
          id: `claude#${groupIndex}.${keyIndex}`,
          provider: "claude",
          kind: "apikey",
          label: "claude-apikey",
          ...(prefix !== "" ? { prefix } : {}),
          attributes,
          metadata: {},
        },
        models: new Set(modelIds(group, entry.models, prefix, forceModelPrefix)),
        priority,
      });
    });
  });

  return out;
};
