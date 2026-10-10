/**
 * Per-credential model resolution: prefix stripping and API-key model aliases (incl. OpenAI-compatible pools).
 *
 * Go source: sdk/cliproxy/auth/conductor_models.go (rewriteModelForAuth, executionModelCandidates,
 * resolveOpenAICompatUpstreamModelPool, resolveOpenAICompatConfig), sdk/cliproxy/auth/oauth_model_alias.go
 * (resolveModelAliasPoolFromConfigModels, modelAliasLookupCandidates), internal/runtime/executor/
 * openai_compat_executor.go (resolveCompatConfig), internal/util/provider.go (OpenAICompatibleProviderKey).
 *
 * Not yet ported: OAuth model aliases (`oauth.model-alias`), API-key aliases of the non-compat families, and the
 * round-robin rotation of model pools (the conductor slice owns the rotation cursor; candidates are returned in
 * configuration order).
 */
import type { Config, OpenAICompatGroup } from "../config/schema.ts";
import { resolveClaudeKeyConfig } from "./claude/credentials.ts";
import type { CredentialSnapshot } from "./picker.ts";
import { parseSuffix, preserveSuffix } from "./suffix.ts";

const OPENAI_COMPATIBLE_PREFIX = "openai-compatible-";

/** `util.OpenAICompatibleProviderKey`: `openai-compatible-<lower name>` (already-prefixed names are kept). */
export const openAICompatibleProviderKey = (name: string): string => {
  const lower = name.trim().toLowerCase();

  if (lower === "") return "openai-compatibility";

  if (lower === "openai-compatibility" || lower.startsWith(OPENAI_COMPATIBLE_PREFIX)) return lower;

  return OPENAI_COMPATIBLE_PREFIX + lower;
};

/** `rewriteModelForAuth`: strips `<prefix>/` when it matches the credential's prefix. */
export const stripCredentialPrefix = (model: string, credential: CredentialSnapshot): string => {
  const prefix = credential.prefix?.trim() ?? "";

  if (prefix === "" || model === "") return model;
  const needle = `${prefix}/`;

  return model.startsWith(needle) ? model.slice(needle.length) : model;
};

/** The `api-keys.openai-compatibility` entry backing a credential (`config_index`, then name/provider key). */
export const resolveCompatConfig = (
  config: Config,
  credential: CredentialSnapshot,
): OpenAICompatGroup | undefined => {
  const groups = config["api-keys"]["openai-compatibility"];
  const rawIndex = credential.attributes["config_index"]?.trim() ?? "";

  if (rawIndex !== "" && /^\d+$/.test(rawIndex)) {
    const group = groups[Number(rawIndex)];

    if (group !== undefined && group.disabled !== true) return group;
  }

  const candidates = [
    credential.attributes["compat_name"],
    credential.attributes["provider_key"],
    credential.provider,
  ]
    .map((value) => value?.trim() ?? "")
    .filter((value) => value !== "");

  return groups.find(
    (group) =>
      group.disabled !== true &&
      candidates.some((candidate) => candidate.toLowerCase() === group.name.trim().toLowerCase()),
  );
};

/** Whether the credential is a configured OpenAI-compatible key. */
export const isOpenAICompatCredential = (credential: CredentialSnapshot): boolean =>
  (credential.attributes["compat_name"] ?? "").trim() !== "";

interface AliasEntry {
  readonly name?: string | undefined;
  readonly alias?: string | undefined;
}

/** `resolveModelAliasPoolFromConfigModels`: upstream names whose alias matches `[requested, base]`. */
export const resolveModelAliasPool = (
  requestedModel: string,
  models: ReadonlyArray<AliasEntry>,
): string[] => {
  const requested = requestedModel.trim();

  if (requested === "" || models.length === 0) return [];
  const suffix = parseSuffix(requested);
  const base = suffix.modelName === "" ? requested : suffix.modelName;
  const candidates = base !== requested ? [requested, base] : [requested];

  for (const candidate of candidates) {
    const out: string[] = [];
    const seen = new Set<string>();

    for (const model of models) {
      const name = model.name?.trim() ?? "";
      const alias = model.alias?.trim() ?? "";

      if (alias === "" || alias.toLowerCase() !== candidate.toLowerCase()) continue;
      const resolved = preserveSuffix(name !== "" ? name : candidate, suffix);
      const lower = resolved.toLowerCase();

      if (resolved === "" || seen.has(lower)) continue;
      seen.add(lower);
      out.push(resolved);
    }

    if (out.length > 0) return out;
  }

  return [];
};

/**
 * `executionModelCandidates`: upstream model(s) to try for `routeModel` on this credential, suffix preserved.
 * Falls back to the prefix-stripped route model.
 */
export const executionModelCandidates = (
  config: Config,
  credential: CredentialSnapshot,
  routeModel: string,
): string[] => {
  const requested = stripCredentialPrefix(routeModel.trim(), credential);

  if (credential.provider === "claude") {
    const match = resolveClaudeKeyConfig(config, credential);

    const pool =
      match === undefined
        ? []
        : resolveModelAliasPool(requested, match.entry.models ?? match.group.models ?? []);

    if (pool.length > 0) return pool;
  }

  if (isOpenAICompatCredential(credential)) {
    const group = resolveCompatConfig(config, credential);
    const pool = group === undefined ? [] : resolveModelAliasPool(requested, group.models ?? []);

    if (pool.length > 0) return pool;
  }

  return [requested];
};
