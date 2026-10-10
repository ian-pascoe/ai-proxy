import { describe, expect, it } from "vitest";
import {
  detectChangedProviders,
  embeddedCatalogs,
  parseModelsCatalog,
  validateCodexClientModels,
  withMetaFallback,
} from "../src/registry/catalog.ts";
import { catalogsFromTexts, validateCatalogText } from "../src/registry/catalog-store.ts";
import {
  aggregateDevinModels,
  parseDevinCatalog,
  splitDevinModelId,
} from "../src/registry/devin.ts";
import { fromWire, decodeWireModel, type ModelInfo } from "../src/registry/model-info.ts";
import codexClient from "../src/registry/catalog/codex_client_models.json";
import modelsJson from "../src/registry/catalog/models.json";

const wire = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  object: "model",
  created: 1,
  owned_by: "x",
  type: "x",
  ...extra,
});

const section = (...ids: string[]) => ids.map((id) => wire(id));

const catalog = (overrides: Record<string, unknown> = {}) => ({
  claude: section("c1"),
  gemini: section("g1"),
  vertex: section("v1"),
  aistudio: section("a1"),
  "codex-free": section("f1"),
  "codex-team": section("t1"),
  "codex-plus": section("p1"),
  "codex-pro": section("r1"),
  kimi: section("k1"),
  antigravity: section("ag1"),
  xai: section("x1"),
  meta: section("m1"),
  ...overrides,
});

describe("models catalog validation (validateModelsCatalog)", () => {
  it("accepts the embedded catalog, including the legacy gemini-cli section it ignores", () => {
    const parsed = parseModelsCatalog(modelsJson);
    expect(parsed.ok).toBe(true);
  });

  it("rejects null entries, empty ids and duplicate ids", () => {
    expect(parseModelsCatalog(catalog({ claude: [null] }))).toMatchObject({
      ok: false,
      error: "claude[0] is null",
    });
    expect(parseModelsCatalog(catalog({ gemini: section("g1", "  ") }))).toMatchObject({
      ok: false,
      error: "gemini[1] has empty id",
    });
    expect(parseModelsCatalog(catalog({ kimi: section("k1", "k1") }))).toMatchObject({ ok: false });
  });

  it("only warns about empty sections and rejects structurally invalid payloads", () => {
    expect(parseModelsCatalog(catalog({ meta: [] })).ok).toBe(true);
    expect(parseModelsCatalog([]).ok).toBe(false);
    expect(parseModelsCatalog(catalog({ claude: [{ id: 5 }] })).ok).toBe(false);
  });

  it("keeps the previous meta section when the new catalog has none (publishCatalogBytes)", () => {
    const previous = parseModelsCatalog(catalog());
    const next = parseModelsCatalog(catalog({ meta: [] }));

    if (!previous.ok || !next.ok) throw new Error("unexpected");
    expect(withMetaFallback(next.value, previous.value).meta.map((model) => model.id)).toEqual([
      "m1",
    ]);
    expect(withMetaFallback(previous.value, undefined).meta.map((model) => model.id)).toEqual([
      "m1",
    ]);
  });

  it("reports changed providers like detectChangedProviders", () => {
    const base = parseModelsCatalog(catalog());

    const changed = parseModelsCatalog(
      catalog({ gemini: [wire("g1", { display_name: "New" })], "codex-plus": section("p1", "p2") }),
    );

    if (!base.ok || !changed.ok) throw new Error("unexpected");
    expect(detectChangedProviders(base.value, changed.value)).toEqual([
      "gemini",
      "gemini-interactions",
      "codex",
    ]);
    expect(detectChangedProviders(base.value, base.value)).toEqual([]);
  });
});

const codexEntry = (overrides: Record<string, unknown> = {}) => ({
  slug: "gpt-5.5",
  display_name: "GPT",
  description: "d",
  base_instructions: "b",
  minimal_client_version: "0.1.0",
  visibility: "list",
  priority: 0,
  context_window: 10,
  max_context_window: 20,
  default_reasoning_level: "low",
  supported_reasoning_levels: [{ effort: "low" }],
  ...overrides,
});

describe("codex client catalog validation", () => {
  it("accepts the embedded catalog", () => {
    expect(validateCodexClientModels(codexClient).ok).toBe(true);
  });

  it.each([
    ["no models", { models: [] }],
    ["missing default template", { models: [codexEntry({ slug: "other" })] }],
    ["duplicate slug", { models: [codexEntry(), codexEntry()] }],
    ["context window above max", { models: [codexEntry({ context_window: 30 })] }],
    ["unlisted default level", { models: [codexEntry({ default_reasoning_level: "high" })] }],
    [
      "duplicate effort",
      {
        models: [
          codexEntry({ supported_reasoning_levels: [{ effort: "low" }, { effort: "low" }] }),
        ],
      },
    ],
    ["negative priority", { models: [codexEntry({ priority: -1 })] }],
    ["blank description", { models: [codexEntry({ description: " " })] }],
  ])("rejects %s", (_name, payload) => {
    expect(validateCodexClientModels(payload).ok).toBe(false);
  });

  it("accepts a minimal valid catalog", () => {
    expect(validateCodexClientModels({ models: [codexEntry()] }).ok).toBe(true);
  });
});

const info = (value: Record<string, unknown>): ModelInfo => fromWire(decodeWireModel(value));

describe("Devin catalog", () => {
  it("splits effort variants out of ids", () => {
    expect(splitDevinModelId("claude-opus-5-low-fast")).toEqual({
      base: "claude-opus-5",
      effort: "low",
    });
    expect(splitDevinModelId("claude-opus-4-6-thinking-1m")).toEqual({
      base: "claude-opus-4-6-1m",
      effort: "",
    });
    expect(splitDevinModelId("gpt-6-astra-high")).toEqual({ base: "gpt-6-astra", effort: "high" });
    expect(splitDevinModelId("MODEL_X_MAX")).toEqual({ base: "MODEL_X", effort: "max" });
    expect(splitDevinModelId("swe-1-6-fast")).toEqual({ base: "swe-1-6", effort: "" });
    expect(splitDevinModelId("swe-1-6-slow")).toEqual({ base: "swe-1-6-slow", effort: "" });
    expect(splitDevinModelId("plain")).toEqual({ base: "plain", effort: "" });
  });

  it("aggregates variants into one model with ordered levels and defaults", () => {
    const [aggregated, ...rest] = aggregateDevinModels([
      info(
        wire("devin/gpt-6-astra-high", {
          display_name: "GPT-6 Astra High Thinking",
          context_length: 1000,
        }),
      ),
      info(
        wire("devin/gpt-6-astra", {
          display_name: "GPT-6 Astra",
          context_length: 2000,
          owned_by: "openai",
        }),
      ),
      info(wire("devin/gpt-6-astra-low-fast", { thinking: { levels: ["priority", "medium"] } })),
    ]);

    expect(rest).toEqual([]);
    expect(aggregated).toMatchObject({
      id: "devin/gpt-6-astra",
      displayName: "GPT-6 Astra",
      ownedBy: "openai",
      contextLength: 2000,
      inputTokenLimit: 2000,
      supportedInputModalities: ["text"],
      supportedGenerationMethods: ["generateContent", "countTokens"],
    });
    expect(aggregated?.thinking?.levels).toEqual(["low", "medium", "high"]);
  });

  it("accepts envelopes and bare arrays, namespaces ids and rejects bad payloads", () => {
    const fromDevin = parseDevinCatalog({ devin: [wire("Model-A")] });
    const fromModels = parseDevinCatalog({
      models: [wire("devin/model-a-high"), wire("devin/model-a")],
    });
    const fromArray = parseDevinCatalog([wire("model-a")]);

    for (const parsed of [fromDevin, fromModels, fromArray]) {
      if (!parsed.ok) throw new Error(parsed.error);
      expect(parsed.value.map((model) => model.id)).toEqual(["devin/model-a"]);
    }

    expect(parseDevinCatalog({ devin: [wire("a"), wire("devin/A")] }).ok).toBe(false);
    expect(parseDevinCatalog({ devin: [null] }).ok).toBe(false);
    expect(parseDevinCatalog({ devin: [wire(" ")] }).ok).toBe(false);
    expect(parseDevinCatalog({}).ok).toBe(false);
    expect(parseDevinCatalog(null).ok).toBe(false);
  });
});

describe("catalogsFromTexts (KV contents -> catalogs)", () => {
  it("uses the embedded catalogs when nothing is stored", () => {
    const { catalogs, warnings } = catalogsFromTexts({});
    expect(catalogs).toEqual(embeddedCatalogs());
    expect(warnings).toEqual([]);
  });

  it("prefers a valid stored catalog per catalog", () => {
    const { catalogs, warnings } = catalogsFromTexts({
      models: JSON.stringify(catalog({ claude: section("stored-claude") })),
      devin: JSON.stringify({ devin: [wire("only-devin")] }),
    });

    expect(warnings).toEqual([]);
    expect(catalogs.models.claude.map((model) => model.id)).toEqual(["stored-claude"]);
    expect(catalogs.devin.map((model) => model.id)).toEqual([
      "devin/only-devin",
      "devin/swe-1-6-slow",
    ]);
    expect(catalogs.codexClient).toBe(embeddedCatalogs().codexClient);
  });

  it("falls back to the embedded catalog and warns when stored data is invalid", () => {
    const { catalogs, warnings } = catalogsFromTexts({
      models: "{not json",
      devin: JSON.stringify({ devin: [] }),
      codexClient: JSON.stringify({ models: [] }),
    });

    expect(catalogs).toEqual(embeddedCatalogs());
    expect(warnings).toHaveLength(3);
  });

  it("validateCatalogText reports the reason", () => {
    expect(validateCatalogText("models", "nope")).toBeTypeOf("string");
    expect(validateCatalogText("models", JSON.stringify(catalog()))).toBeUndefined();
    expect(validateCatalogText("codexClient", JSON.stringify({ models: [] }))).toContain(
      "no models",
    );
  });
});
