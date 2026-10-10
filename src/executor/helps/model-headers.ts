/**
 * models.json `config.override_header` lookup for executors.
 *
 * Go source: internal/registry/model_registry.go (`ModelOverrideHeaders`), internal/runtime/executor/codex_executor_request.go
 * (`applyModelHeaderOverrides`). The registry snapshot of the attempt is reachable through `ExecutorRequest.modelLookup`, whose
 * entries are the registry `ModelInfo` objects (they carry `config.overrideHeader`).
 */
import type { ThinkingModelInfo } from "../../thinking/index.ts";

type Lookup = (modelId: string, provider: string) => ThinkingModelInfo | undefined;

/** `registry.ModelOverrideHeaders(model)`: a copy with trimmed names; `undefined` when there is nothing to force. */
export const modelOverrideHeaders = (
  lookup: Lookup | undefined,
  model: string,
): Readonly<Record<string, string>> | undefined => {
  const source = lookup?.(model, "")?.config?.overrideHeader;

  if (source === undefined) return undefined;
  const out: Record<string, string> = {};

  for (const [key, value] of Object.entries(source)) {
    const name = key.trim();

    if (name !== "") out[name] = value;
  }

  return Object.keys(out).length === 0 ? undefined : out;
};
