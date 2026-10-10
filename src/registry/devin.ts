/**
 * Devin catalog: id namespacing, effort-variant aggregation and validation.
 *
 * Go source: internal/registry/devin_models.go (`ValidateDevinModelsJSON`, `sanitizeAndValidateDevinModels`,
 * `aggregateDevinModels`, `splitDevinModelID`, `cleanDevinDisplayName`, `WithDevinBuiltins`).
 */
import { Result, Schema, type Types } from "effect";
import type { Json } from "../json/index.ts";
import { fromWire, type ModelInfo, type ThinkingSupport, WireModel } from "./model-info.ts";

const COMPOUND_SUFFIXES: ReadonlyArray<{ suffix: string; effort: string; readd?: string }> = [
  { suffix: "-low-fast", effort: "low" },
  { suffix: "-medium-fast", effort: "medium" },
  { suffix: "-high-fast", effort: "high" },
  { suffix: "-xhigh-fast", effort: "xhigh" },
  { suffix: "-max-fast", effort: "max" },
  { suffix: "-none-fast", effort: "none" },
  { suffix: "-low-priority", effort: "low" },
  { suffix: "-medium-priority", effort: "medium" },
  { suffix: "-high-priority", effort: "high" },
  { suffix: "-xhigh-priority", effort: "xhigh" },
  { suffix: "-max-priority", effort: "max" },
  { suffix: "-none-priority", effort: "none" },
  { suffix: "-thinking-1m", effort: "", readd: "-1m" },
  { suffix: "-thinking", effort: "" },
  { suffix: "-max-1m", effort: "max", readd: "-1m" },
  { suffix: "-none-1m", effort: "none", readd: "-1m" },
];

const SIMPLE_SUFFIXES: ReadonlyArray<{ suffix: string; effort: string }> = [
  { suffix: "-none", effort: "none" },
  { suffix: "-minimal", effort: "minimal" },
  { suffix: "-low", effort: "low" },
  { suffix: "-medium", effort: "medium" },
  { suffix: "-high", effort: "high" },
  { suffix: "-xhigh", effort: "xhigh" },
  { suffix: "-max", effort: "max" },
];

const UPPER_SUFFIXES: ReadonlyArray<{ suffix: string; effort: string }> = [
  { suffix: "_NONE", effort: "none" },
  { suffix: "_MINIMAL", effort: "minimal" },
  { suffix: "_LOW", effort: "low" },
  { suffix: "_MEDIUM", effort: "medium" },
  { suffix: "_HIGH", effort: "high" },
  { suffix: "_XHIGH", effort: "xhigh" },
  { suffix: "_MAX", effort: "max" },
  { suffix: "_THINKING", effort: "high" },
];

const DISPLAY_NAME_SUFFIXES: ReadonlyArray<string> = [
  " Low Fast",
  " Medium Fast",
  " High Fast",
  " XHigh Fast",
  " Max Fast",
  " Low Thinking Fast",
  " Medium Thinking Fast",
  " High Thinking Fast",
  " XHigh Thinking Fast",
  " Max Thinking Fast",
  " No Thinking Fast",
  " Low Thinking",
  " Medium Thinking",
  " High Thinking",
  " XHigh Thinking",
  " Max Thinking",
  " No Thinking",
  " Low",
  " Medium",
  " High",
  " XHigh",
  " Max",
  " None",
  " Minimal",
  " Thinking",
  " Fast",
];

const LEVEL_ORDER = new Map<string, number>([
  ["none", 0],
  ["minimal", 1],
  ["low", 2],
  ["medium", 3],
  ["high", 4],
  ["xhigh", 5],
  ["max", 6],
  ["fast", 7],
  ["priority", 8],
]);

/** Splits a lower-cased, unprefixed id into its base model and reasoning effort. */
export interface DevinModelIdParts {
  readonly base: string;
  readonly effort: string;
}

export const splitDevinModelId = (cleanId: string): DevinModelIdParts => {
  if (cleanId === "swe-1-6-slow") return { base: cleanId, effort: "" };

  if (cleanId === "swe-1-6-fast") return { base: "swe-1-6", effort: "" };
  const upper = cleanId.toUpperCase();

  for (const { suffix, effort } of UPPER_SUFFIXES) {
    if (upper.endsWith(suffix))
      return { base: cleanId.slice(0, cleanId.length - suffix.length), effort };
  }

  for (const { suffix, effort, readd } of COMPOUND_SUFFIXES) {
    if (cleanId.endsWith(suffix))
      return { base: cleanId.slice(0, cleanId.length - suffix.length) + (readd ?? ""), effort };
  }

  for (const { suffix, effort } of SIMPLE_SUFFIXES) {
    if (cleanId.endsWith(suffix))
      return { base: cleanId.slice(0, cleanId.length - suffix.length), effort };
  }

  return { base: cleanId, effort: "" };
};

const cleanDisplayName = (name: string): string => {
  let trimmed = name.trim();

  for (;;) {
    const lower = trimmed.toLowerCase();

    const suffix = DISPLAY_NAME_SUFFIXES.find((candidate) =>
      lower.endsWith(candidate.toLowerCase()),
    );

    if (suffix === undefined) return trimmed;
    trimmed = trimmed.slice(0, trimmed.length - suffix.length).trim();
  }
};

interface Aggregate {
  readonly model: Types.Mutable<ModelInfo>;
  readonly levels: Set<string>;
}

const appendUnique = (target: string[], values: readonly string[] | undefined): void => {
  for (const value of values ?? []) if (!target.includes(value)) target.push(value);
};

/** `aggregateDevinModels`: one entry per base model with the union of its effort variants as thinking levels. */
export const aggregateDevinModels = (models: ReadonlyArray<ModelInfo>): ModelInfo[] => {
  const aggregated = new Map<string, Aggregate>();

  for (const model of models) {
    const cleanId = model.id
      .trim()
      .replace(/^devin\//, "")
      .toLowerCase();

    const split = splitDevinModelId(cleanId);
    const baseId = split.base === "" ? cleanId : split.base;
    const namespacedBase = `devin/${baseId}`;
    const isBase = baseId === cleanId;

    let entry = aggregated.get(namespacedBase);

    if (entry === undefined) {
      const clone: Types.Mutable<ModelInfo> = structuredClone(model);
      const cleaned = cleanDisplayName(model.displayName ?? "");
      const next: Types.Mutable<ModelInfo> = { ...clone, id: namespacedBase };
      const displayName = cleaned === "" ? model.displayName : cleaned;

      if (displayName === undefined || displayName === "") delete next.displayName;
      else next.displayName = displayName;
      entry = { model: next, levels: new Set() };
      aggregated.set(namespacedBase, entry);
    }

    const target = entry.model;

    if (isBase) {
      if (model.displayName !== undefined && model.displayName !== "")
        target.displayName = cleanDisplayName(model.displayName);

      if (model.ownedBy !== "") target.ownedBy = model.ownedBy;
    }

    for (const key of [
      "contextLength",
      "maxCompletionTokens",
      "inputTokenLimit",
      "outputTokenLimit",
    ] as const) {
      const value = model[key] ?? 0;

      if (value > (target[key] ?? 0)) target[key] = value;
    }

    for (const key of [
      "supportedInputModalities",
      "supportedOutputModalities",
      "supportedGenerationMethods",
    ] as const) {
      if ((model[key] ?? []).length === 0) continue;
      const merged = [...(target[key] ?? [])];
      appendUnique(merged, model[key]);
      target[key] = merged;
    }

    for (const level of model.thinking?.levels ?? [])
      if (level !== "" && level !== "priority") entry.levels.add(level);

    if (split.effort !== "" && split.effort !== "priority") entry.levels.add(split.effort);
  }

  // Map iteration follows insertion order, i.e. the order in which each base model first appeared.
  return [...aggregated.values()].map(({ model, levels }) => {
    if (levels.size > 0) {
      const rank = (level: string) => LEVEL_ORDER.get(level) ?? 99;

      const sorted = [...levels].toSorted(
        (a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0),
      );

      model.thinking = { levels: sorted } satisfies ThinkingSupport;
    }

    if (model.type === "") model.type = "devin";

    if (model.object === "") model.object = "model";

    if ((model.supportedInputModalities ?? []).length === 0)
      model.supportedInputModalities = ["text"];

    if ((model.supportedOutputModalities ?? []).length === 0)
      model.supportedOutputModalities = ["text"];

    if (!model.inputTokenLimit && model.contextLength) model.inputTokenLimit = model.contextLength;

    if (!model.outputTokenLimit && model.maxCompletionTokens)
      model.outputTokenLimit = model.maxCompletionTokens;

    if ((model.supportedGenerationMethods ?? []).length === 0)
      model.supportedGenerationMethods = ["generateContent", "countTokens"];

    return model;
  });
};

export type CatalogResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

const Envelope = Schema.Struct({
  devin: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.NullOr(WireModel)))),
  models: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.NullOr(WireModel)))),
});

const RawList = Schema.Array(Schema.NullOr(WireModel));

/** `sanitizeAndValidateDevinModels`: namespaces and lower-cases ids, rejects nulls/empties/duplicates, aggregates. */
const sanitize = (
  models: ReadonlyArray<typeof WireModel.Type | null>,
): CatalogResult<ModelInfo[]> => {
  const seen = new Set<string>();
  const out: ModelInfo[] = [];

  for (const [index, wire] of models.entries()) {
    if (wire === null) return { ok: false, error: `model at index ${index} is null` };
    let id = wire.id.trim();

    if (id === "") return { ok: false, error: `model at index ${index} has empty id` };

    if (!id.toLowerCase().startsWith("devin/")) id = `devin/${id}`;
    id = id.toLowerCase();

    if (seen.has(id)) return { ok: false, error: `duplicate model id: ${JSON.stringify(id)}` };
    seen.add(id);
    out.push({ ...fromWire(wire), id });
  }

  return { ok: true, value: aggregateDevinModels(out) };
};

/** `ValidateDevinModelsJSON`: accepts `{"devin":[...]}`, `{"models":[...]}` or a bare array. */
export const parseDevinCatalog = (parsed: Json | undefined): CatalogResult<ModelInfo[]> => {
  if (parsed === null || parsed === undefined)
    return { ok: false, error: "empty Devin models payload" };

  if (Array.isArray(parsed)) {
    const list = Schema.decodeUnknownResult(RawList)(parsed);

    if (Result.isSuccess(list) && list.success.length > 0) return sanitize(list.success);
  } else if (typeof parsed === "object") {
    const envelope = Schema.decodeUnknownResult(Envelope)(parsed);

    if (Result.isSuccess(envelope)) {
      const candidates =
        (envelope.success.devin ?? []).length > 0
          ? envelope.success.devin
          : envelope.success.models;

      if (candidates !== undefined && candidates !== null && candidates.length > 0)
        return sanitize(candidates);
    }
  }

  return {
    ok: false,
    error: "invalid Devin models JSON: expected non-empty 'devin'/'models' array or model list",
  };
};
