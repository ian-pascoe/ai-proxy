/**
 * Helpers shared by the Antigravity response translators.
 *
 * Go source: `hasAntigravityResponsePayload` in internal/translator/antigravity/*\/*_response.go (identical copies).
 */
import { get, isJsonArray, isJsonObject, type Json } from "../../../json/index.ts";

export const USAGE_PATHS = [
  "response.usageMetadata",
  "response.cpaUsageMetadata",
  "usageMetadata",
  "cpaUsageMetadata",
] as const;

/**
 * Whether a chunk carries generated content or token accounting. An envelope such as `{}` or `{"response":{}}` must
 * not count as a started stream, otherwise a keepalive would be enough to finalize a stream that produced nothing.
 */
export const hasAntigravityResponsePayload = (raw: Json | undefined): boolean => {
  for (const path of ["response.candidates", "candidates"]) {
    const candidates = get(raw, path);

    if (isJsonArray(candidates) && candidates.length > 0) return true;
  }

  return USAGE_PATHS.some((path) => {
    const usage = get(raw, path);

    return isJsonObject(usage) && Object.keys(usage).length > 0;
  });
};
