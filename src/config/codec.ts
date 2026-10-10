/**
 * Config documents <-> `Config`: YAML/JSON import, validation, normalisation and export.
 *
 * Go source: internal/config/config_load.go (LoadConfig) and config_v8.go (YAML boundary). Unlike Go, no file is
 * ever rewritten: the canonical form is the JSON document stored in the ControlPlane Durable Object.
 */
import { Effect, Schema } from "effect";
import { parse, stringify } from "yaml";
import { isJsonArray, isJsonObject, jsonEquals, type Json } from "../json/index.ts";
import { ConfigValidationError } from "./errors.ts";
import { normalizeConfig } from "./normalize.ts";
import { prepareDocument } from "./document.ts";
import { Config, type ConfigEncoded } from "./schema.ts";

const decodeSchema = Schema.decodeUnknownEffect(Config);

const encodeSchema = Schema.encodeSync(Config);

/**
 * Validates a raw document (parsed YAML or JSON; v8 or legacy layout) and returns the normalised `Config`.
 * Unknown keys and keys that do not apply on Workers are dropped.
 */
export const decodeConfig = (raw: Json): Effect.Effect<Config, ConfigValidationError> =>
  Effect.gen(function* () {
    const prepared = yield* Effect.try({
      try: () => prepareDocument(raw),
      catch: (error) =>
        error instanceof ConfigValidationError
          ? error
          : new ConfigValidationError({ message: String(error) }),
    });

    const decoded = yield* decodeSchema(prepared).pipe(
      Effect.mapError((error) => new ConfigValidationError({ message: error.message })),
    );

    return normalizeConfig(decoded);
  });

/** Parses YAML (or JSON) text into a `Config`. An empty document yields the defaults. */
export const parseConfigYaml = (text: string): Effect.Effect<Config, ConfigValidationError> =>
  Effect.gen(function* () {
    const raw = yield* Effect.try({
      try: (): Json => (text.trim() === "" ? {} : parse(text)),
      catch: (error) =>
        new ConfigValidationError({
          message: `invalid YAML: ${error instanceof Error ? error.message : String(error)}`,
        }),
    });

    return yield* decodeConfig(raw ?? {});
  });

/** The JSON-compatible v8 document of `config` (all defaults included). */
export const encodeConfig = (config: Config): ConfigEncoded => encodeSchema(config);

let defaultsDocument: ConfigEncoded | undefined;

const defaults = (): ConfigEncoded =>
  (defaultsDocument ??= encodeSchema(Schema.decodeUnknownSync(Config)({})));

/** Recursively drops values that equal the corresponding default, so exported YAML only lists what was set. */
const omitDefaults = (value: Json, base: Json | undefined): Json | undefined => {
  if (base !== undefined && jsonEquals(value, base)) return undefined;

  if (isJsonObject(value)) {
    const out: Record<string, Json> = {};
    const baseObject = isJsonObject(base) ? base : {};

    for (const [key, child] of Object.entries(value)) {
      const kept = omitDefaults(child, baseObject[key]);

      if (kept !== undefined) out[key] = kept;
    }

    return out;
  }

  return isJsonArray(value) && value.length === 0 && base === undefined ? undefined : value;
};

export interface YamlExportOptions {
  /** Emit every field, including defaults (default: only non-default values). */
  readonly includeDefaults?: boolean;
}

/** Serialises `config` as v8 YAML. */
export const stringifyConfigYaml = (config: Config, options: YamlExportOptions = {}): string => {
  // SAFETY: the encoded config is a plain JSON document (the schema's encoded side only holds JSON values).
  const encoded = encodeConfig(config) as Json;
  // SAFETY: the defaults document is encoded by the same schema, hence also plain JSON.
  const sparse = omitDefaults(encoded, defaults() as Json);

  const document =
    options.includeDefaults === true ? encoded : Object.assign({ "config-version": 8 }, sparse);

  return stringify(document, { lineWidth: 0 });
};
