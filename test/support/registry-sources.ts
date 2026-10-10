/** Builders for registry tests: model sources, decoded configs and catalogs. */
import { Effect } from "effect";
import { parseConfigYaml } from "../../src/config/codec.ts";
import type { Config } from "../../src/config/schema.ts";
import { emptyState } from "../../src/credentials/model.ts";
import { embeddedCatalogs, type ModelCatalogs } from "../../src/registry/catalog.ts";
import type { AssemblyOptions } from "../../src/registry/credential-models.ts";
import type { ModelSource } from "../../src/registry/source.ts";

export const configOf = (yaml = ""): Config => Effect.runSync(parseConfigYaml(yaml));

export const NOW_SECONDS = 1_800_000_000;

export const options = (
  yaml = "",
  catalogs: ModelCatalogs = embeddedCatalogs(),
): AssemblyOptions => ({
  config: configOf(yaml),
  catalogs,
  nowSeconds: NOW_SECONDS,
});

export const source = (
  id: string,
  provider: string,
  overrides: Partial<ModelSource> = {},
): ModelSource => ({
  id,
  provider,
  executor: provider,
  source: "file",
  authKind: "oauth",
  label: id,
  disabled: false,
  compat: false,
  excludedModels: [],
  modelAliases: [],
  state: (({ rejectedAccessToken: _omitted, ...rest }) => rest)(emptyState()),
  ...overrides,
});

export const ids = (models: ReadonlyArray<{ readonly id: string }> | undefined): string[] =>
  (models ?? []).map((model) => model.id);
