/**
 * Static model catalogs: parsing, validation, built-ins and static lookups.
 *
 * Go source: internal/registry/model_definitions.go (section getters, built-ins, `LookupStaticModelInfo*`),
 * model_updater.go (`validateModelsCatalog`, `publishCatalogBytes`, `detectChangedProviders`),
 * codex_client_models.go (`ValidateCodexClientModelsJSON`), devin_models.go (`GetDevinModels`).
 *
 * The embedded copies in `catalog/` come from `internal/registry/models/*.json` (`go run ./tools/fixturegen/
 * registry` refreshes them together with `builtins.json`, the hard-coded Go definitions). A refreshed catalog from KV
 * replaces them at runtime (see `catalog-store.ts`).
 */
import { Result, Schema } from "effect";
import { isJsonObject, type Json, type JsonObject } from "../json/index.ts";
import builtinsJson from "./catalog/builtins.json";
import codexClientJson from "./catalog/codex_client_models.json";
import devinJson from "./catalog/devin_models.json";
import modelsJson from "./catalog/models.json";
import { type CatalogResult, parseDevinCatalog } from "./devin.ts";
import { cloneModelInfo, fromWire, type ModelInfo, WireModel } from "./model-info.ts";

export type { CatalogResult } from "./devin.ts";

/** Sections of `models.json` (provider catalogs). */
export const SECTIONS = [
  "claude",
  "gemini",
  "vertex",
  "aistudio",
  "codex-free",
  "codex-team",
  "codex-plus",
  "codex-pro",
  "kimi",
  "antigravity",
  "xai",
  "devin",
  "meta",
] as const;

export type Section = (typeof SECTIONS)[number];

/** `validateModelsCatalog` checks every section but the optional `devin` fallback section. */
const isValidated = (section: Section): boolean => section !== "devin";

export type ModelsCatalog = { readonly [S in Section]: ReadonlyArray<ModelInfo> };

/** Everything the registry reads from the catalogs. */
export interface ModelCatalogs {
  readonly models: ModelsCatalog;
  /** Active Devin catalog (`devin_models.json`, already aggregated and with built-ins). Empty = use fallbacks. */
  readonly devin: ReadonlyArray<ModelInfo>;
  /** Codex client catalog (`codex_client_models.json`), validated JSON. Served by the Codex client listing. */
  readonly codexClient: Json;
}

const SectionList = Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.NullOr(WireModel))));

const ModelsFile = Schema.Struct(
  Object.fromEntries(SECTIONS.map((section) => [section, SectionList])),
);

const decodeModelsFile = Schema.decodeUnknownResult(ModelsFile);

/** Parses and validates a `models.json` payload (`validateModelsCatalog`). */
export const parseModelsCatalog = (parsed: Json | undefined): CatalogResult<ModelsCatalog> => {
  const decoded = decodeModelsFile(parsed);

  if (Result.isFailure(decoded))
    return { ok: false, error: `decode models catalog: ${String(decoded.failure)}` };

  // SAFETY: ModelsFile is built from SECTIONS with SectionList for each key (Object.fromEntries erased the key names).
  const file = decoded.success as Record<
    string,
    ReadonlyArray<WireModel | null> | null | undefined
  >;

  const out: Partial<Record<Section, ModelInfo[]>> = {};

  for (const section of SECTIONS) {
    const entries = file[section] ?? [];
    const seen = new Set<string>();
    const models: ModelInfo[] = [];

    for (const [index, wire] of entries.entries()) {
      if (wire === null) {
        if (section === "devin") continue;

        return { ok: false, error: `${section}[${index}] is null` };
      }

      if (isValidated(section)) {
        const id = wire.id.trim();

        if (id === "") return { ok: false, error: `${section}[${index}] has empty id` };

        if (seen.has(id))
          return {
            ok: false,
            error: `${section} contains duplicate model id ${JSON.stringify(id)}`,
          };
        seen.add(id);
      }

      models.push(fromWire(wire));
    }

    out[section] = models;
  }

  // SAFETY: the loop above assigns a model list to every section of SECTIONS, which are exactly the keys of ModelsCatalog.
  return { ok: true, value: out as ModelsCatalog };
};

/** `publishCatalogBytes`: a catalog without `meta` keeps the previous `meta` section. */
export const withMetaFallback = (
  next: ModelsCatalog,
  previous: ModelsCatalog | undefined,
): ModelsCatalog =>
  next.meta.length === 0 && previous !== undefined ? { ...next, meta: previous.meta } : next;

// --- codex client catalog ------------------------------------------------------------------------------------------

const requiredString = (model: JsonObject, field: string): string => {
  const value = model[field];

  if (typeof value !== "string" || value.trim() === "")
    throw new Error(`field "${field}" must be a non-empty string`);

  return value.trim();
};

const requiredInteger = (model: JsonObject, field: string, positive: boolean): number => {
  const value = model[field];

  if (typeof value !== "number" || !Number.isInteger(value))
    throw new Error(`field "${field}" must be an integer`);

  if (positive && value <= 0) throw new Error(`field "${field}" must be positive`);

  if (!positive && value < 0) throw new Error(`field "${field}" must not be negative`);

  return value;
};

const validateCodexClientModel = (model: JsonObject): void => {
  for (const field of [
    "display_name",
    "description",
    "base_instructions",
    "minimal_client_version",
    "visibility",
    "default_reasoning_level",
  ]) {
    requiredString(model, field);
  }

  const contextWindow = requiredInteger(model, "context_window", true);
  const maxContextWindow = requiredInteger(model, "max_context_window", true);

  if (contextWindow > maxContextWindow)
    throw new Error(
      `context_window ${contextWindow} exceeds max_context_window ${maxContextWindow}`,
    );
  requiredInteger(model, "priority", false);
  const levels = model.supported_reasoning_levels;

  if (!Array.isArray(levels) || levels.length === 0)
    throw new Error(`field "supported_reasoning_levels" must be a non-empty array`);
  const efforts = new Set<string>();

  for (const [index, level] of levels.entries()) {
    if (!isJsonObject(level))
      throw new Error(`field "supported_reasoning_levels" entry ${index} must be an object`);
    const effort = requiredString(level, "effort");

    if (efforts.has(effort))
      throw new Error(`field "supported_reasoning_levels" contains duplicate effort "${effort}"`);
    efforts.add(effort);
  }

  const defaultLevel = requiredString(model, "default_reasoning_level");

  if (!efforts.has(defaultLevel))
    throw new Error(
      `default_reasoning_level "${defaultLevel}" is not listed in supported_reasoning_levels`,
    );
};

/** `ValidateCodexClientModelsJSON`. */
export const validateCodexClientModels = (parsed: Json | undefined): CatalogResult<Json> => {
  try {
    if (!isJsonObject(parsed) || !Array.isArray(parsed.models) || parsed.models.length === 0)
      throw new Error("Codex client model catalog has no models");
    const models = parsed.models;
    const slugs = new Set<string>();

    for (const [index, model] of models.entries()) {
      if (!isJsonObject(model)) throw new Error(`models[${index}] must be an object`);
      const slug = requiredString(model, "slug");

      if (slugs.has(slug)) throw new Error(`duplicate slug "${slug}"`);
      slugs.add(slug);

      try {
        validateCodexClientModel(model);
      } catch (cause) {
        throw new Error(
          `model "${slug}": ${cause instanceof Error ? cause.message : String(cause)}`,
          { cause },
        );
      }
    }

    if (!slugs.has("gpt-5.5")) throw new Error(`missing default template "gpt-5.5"`);

    return { ok: true, value: parsed };
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
  }
};

// --- built-ins -----------------------------------------------------------------------------------------------------

const decodeBuiltins = Schema.decodeUnknownSync(
  Schema.Struct({
    codex: Schema.Array(WireModel),
    xai: Schema.Array(WireModel),
    devin: Schema.Array(WireModel),
    staticDevin: Schema.Array(WireModel),
  }),
);

const builtins = (() => {
  const wire = decodeBuiltins(builtinsJson);

  return {
    codex: wire.codex.map(fromWire),
    xai: wire.xai.map(fromWire),
    devin: wire.devin.map(fromWire),
    staticDevin: wire.staticDevin.map(fromWire),
  };
})();

/** `upsertModelInfos`: extras replace same-id (case-insensitive) entries and are appended at the end. */
const upsert = (
  models: ReadonlyArray<ModelInfo>,
  extras: ReadonlyArray<ModelInfo>,
): ModelInfo[] => {
  const extraIds = new Set<string>();
  const extraList: ModelInfo[] = [];

  for (const extra of extras) {
    const key = extra.id.trim().toLowerCase();

    if (key === "" || extraIds.has(key)) continue;
    extraIds.add(key);
    extraList.push(cloneModelInfo(extra));
  }

  if (extraList.length === 0) return [...models];

  const kept = models.filter((model) => {
    const id = model.id.trim();

    return id !== "" && !extraIds.has(id.toLowerCase());
  });

  return [...kept, ...extraList];
};

export const withCodexBuiltins = (models: ReadonlyArray<ModelInfo>): ModelInfo[] =>
  upsert(models, builtins.codex);

export const withXaiBuiltins = (models: ReadonlyArray<ModelInfo>): ModelInfo[] =>
  upsert(models, builtins.xai);

export const withDevinBuiltins = (models: ReadonlyArray<ModelInfo>): ModelInfo[] =>
  upsert(models, builtins.devin);

// --- embedded catalogs ---------------------------------------------------------------------------------------------

const parseEmbeddedModels = (): ModelsCatalog => {
  const parsed = parseModelsCatalog(modelsJson);

  if (!parsed.ok) throw new Error(`embedded models.json is invalid: ${parsed.error}`);

  return parsed.value;
};

const parseEmbeddedDevin = (): ReadonlyArray<ModelInfo> => {
  const parsed = parseDevinCatalog(devinJson);

  if (!parsed.ok) throw new Error(`embedded devin_models.json is invalid: ${parsed.error}`);

  return withDevinBuiltins(parsed.value);
};

/** The raw embedded `models.json` document (the base of `meta` carry-over during a refresh). */
export const embeddedModelsDocument: Json = modelsJson;

let embedded: ModelCatalogs | undefined;

/** The catalogs compiled into the Worker (parsed once per isolate). */
export const embeddedCatalogs = (): ModelCatalogs => {
  if (embedded === undefined) {
    const codexClient = validateCodexClientModels(codexClientJson);

    if (!codexClient.ok)
      throw new Error(`embedded codex_client_models.json is invalid: ${codexClient.error}`);
    embedded = {
      models: parseEmbeddedModels(),
      devin: parseEmbeddedDevin(),
      codexClient: codexClient.value,
    };
  }

  return embedded;
};

// --- section getters (clones, like the Go `Get*Models`) ------------------------------------------------------------

const cloneAll = (models: ReadonlyArray<ModelInfo>): ModelInfo[] => models.map(cloneModelInfo);

/** `GetDevinModels`: the active Devin catalog, else the `models.json` section, else the hard-coded list. */
export const devinModels = (catalogs: ModelCatalogs): ModelInfo[] => {
  if (catalogs.devin.length > 0) return withDevinBuiltins(cloneAll(catalogs.devin));

  if (catalogs.models.devin.length > 0) return withDevinBuiltins(cloneAll(catalogs.models.devin));

  return withDevinBuiltins(cloneAll(builtins.staticDevin));
};

/** Models of one section as the Go getters return them (Codex/xAI/Devin with their built-ins). */
export const sectionModels = (catalogs: ModelCatalogs, section: Section): ModelInfo[] => {
  switch (section) {
    case "codex-free":
    case "codex-team":
    case "codex-plus":
    case "codex-pro":
      return withCodexBuiltins(cloneAll(catalogs.models[section]));
    case "xai":
      return withXaiBuiltins(cloneAll(catalogs.models.xai));
    case "devin":
      return devinModels(catalogs);
    default:
      return cloneAll(catalogs.models[section]);
  }
};

/** `GetStaticModelDefinitionsByChannel`; `undefined` for unknown channels. */
export const staticModelsByChannel = (
  catalogs: ModelCatalogs,
  channel: string,
): ModelInfo[] | undefined => {
  switch (channel.trim().toLowerCase()) {
    case "claude":
      return sectionModels(catalogs, "claude");
    case "gemini":
    case "gemini-interactions":
      return sectionModels(catalogs, "gemini");
    case "vertex":
      return sectionModels(catalogs, "vertex");
    case "aistudio":
      return sectionModels(catalogs, "aistudio");
    case "codex":
      return sectionModels(catalogs, "codex-pro");
    case "kimi":
    case "kimi-ai":
    case "kimi.ai":
    case "kimi.com":
      return sectionModels(catalogs, "kimi");
    case "antigravity":
      return sectionModels(catalogs, "antigravity");
    case "xai":
    case "x-ai":
    case "grok":
      return sectionModels(catalogs, "xai");
    case "devin":
      return devinModels(catalogs);
    case "meta":
    case "muse":
      return sectionModels(catalogs, "meta");
    default:
      return undefined;
  }
};

/** `LookupStaticModelInfoByChannel`: exact id within one section. */
export const lookupStaticModelInfoByChannel = (
  catalogs: ModelCatalogs,
  modelId: string,
  channel: string,
): ModelInfo | undefined => {
  const id = modelId.trim();

  if (id === "") return undefined;
  const found = staticModelsByChannel(catalogs, channel)?.find((model) => model.id === id);

  return found === undefined ? undefined : cloneModelInfo(found);
};

/** `LookupStaticModelInfo`: first exact match over the raw sections (no built-ins), in the Go order. */
export const lookupStaticModelInfo = (
  catalogs: ModelCatalogs,
  modelId: string,
): ModelInfo | undefined => {
  if (modelId === "") return undefined;
  const { models } = catalogs;

  const lists = [
    models.claude,
    models.gemini,
    models.vertex,
    models.aistudio,
    models["codex-pro"],
    models.kimi,
    models.antigravity,
    models.xai,
    models.devin,
    builtins.staticDevin,
    models.meta,
  ];

  for (const list of lists) {
    const found = list.find((model) => model.id === modelId);

    if (found !== undefined) return cloneModelInfo(found);
  }

  return undefined;
};

// --- change detection ----------------------------------------------------------------------------------------------

/**
 * `detectChangedProviders`: provider names whose model definitions differ between two catalogs. The Workers registry
 * is rebuilt from the catalogs on demand, so this is only reported (logs/refresh result).
 */
export const detectChangedProviders = (previous: ModelsCatalog, next: ModelsCatalog): string[] => {
  const pairs: ReadonlyArray<readonly [string, Section]> = [
    ["claude", "claude"],
    ["gemini", "gemini"],
    ["gemini-interactions", "gemini"],
    ["vertex", "vertex"],
    ["aistudio", "aistudio"],
    ["codex", "codex-free"],
    ["codex", "codex-team"],
    ["codex", "codex-plus"],
    ["codex", "codex-pro"],
    ["kimi", "kimi"],
    ["kimi-ai", "kimi"],
    ["kimi.ai", "kimi"],
    ["kimi.com", "kimi"],
    ["antigravity", "antigravity"],
    ["xai", "xai"],
    ["devin", "devin"],
    ["meta", "meta"],
  ];

  const changed: string[] = [];

  for (const [provider, section] of pairs) {
    if (changed.includes(provider)) continue;

    if (JSON.stringify(previous[section]) !== JSON.stringify(next[section])) changed.push(provider);
  }

  return changed;
};
