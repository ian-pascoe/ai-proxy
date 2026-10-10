/**
 * Gemini-family usage parsing and stream usage filtering.
 *
 * Go source: internal/runtime/executor/helps/usage_helpers.go (parseGeminiFamilyUsageDetail, ParseGeminiUsage,
 * ParseGeminiStreamUsage, parseInteractionsUsageDetail, ParseInteractionsUsage, ParseInteractionsStreamUsage,
 * FilterSSEUsageMetadata, StripUsageMetadataFromJSON, JSONPayload). The parsers (with the v2 token breakdown:
 * separate-reasoning accounting, `inconsistent` for invalid sums) live in `usage/parsers.ts` and are re-exported here.
 */
import { asString, del, get, set, tryParseJson } from "../../json/index.ts";

export {
  parseGeminiFamilyNode as parseGeminiFamilyUsageDetail,
  parseGeminiStreamUsage,
  parseGeminiUsage,
  parseGeminiUsageBody,
  parseInteractionsNode as parseInteractionsUsageDetail,
  parseInteractionsStreamUsage,
  parseInteractionsUsage,
  parseInteractionsUsageBody,
} from "../../usage/parsers.ts";

/** `JSONPayload`: the JSON object of an SSE line, `undefined` for events, `[DONE]` and non-objects. */
export const jsonPayload = (line: string): string | undefined => {
  let trimmed = line.trim();

  if (trimmed === "" || trimmed === "[DONE]" || trimmed.startsWith("event:")) return undefined;

  if (trimmed.startsWith("data:")) trimmed = trimmed.slice(5).trim();

  return trimmed.startsWith("{") ? trimmed : undefined;
};

/** Result of {@link stripUsageMetadataFromJson}. */
export interface StrippedUsage {
  readonly text: string;
  readonly changed: boolean;
}

/**
 * `StripUsageMetadataFromJSON`: renames `usageMetadata` to `cpaUsageMetadata` on non-terminal chunks (no
 * `finishReason`) so translators only report usage once the stream finishes.
 */
export const stripUsageMetadataFromJson = (raw: string): StrippedUsage => {
  const root = tryParseJson(raw.trim());

  if (root === undefined) return { text: raw, changed: false };
  let finish = get(root, "candidates.0.finishReason");

  if (finish === undefined) finish = get(root, "response.candidates.0.finishReason");

  if (finish !== undefined && asString(finish).trim() !== "") return { text: raw, changed: false };
  let changed = false;
  const usage = get(root, "usageMetadata");

  if (usage !== undefined) {
    set(root, "cpaUsageMetadata", usage);
    del(root, "usageMetadata");
    changed = true;
  }

  const wrapped = get(root, "response.usageMetadata");

  if (wrapped !== undefined) {
    set(root, "response.cpaUsageMetadata", wrapped);
    del(root, "response.usageMetadata");
    changed = true;
  }

  return changed ? { text: JSON.stringify(root), changed } : { text: raw, changed: false };
};

/**
 * `FilterSSEUsageMetadata` for one stream line (Gemini API keys carry no `traceId`, so the Antigravity stop-chunk
 * bookkeeping does not apply): a `data:` line, or a raw JSON line.
 */
export const filterSseUsageMetadata = (line: string): string => {
  if (line === "") return line;
  const trimmed = line.trim();

  if (trimmed.startsWith("data:")) {
    const dataIndex = line.indexOf("data:");
    const cleaned = stripUsageMetadataFromJson(line.slice(dataIndex + 5).trim());

    if (!cleaned.changed) return line;

    return `${line.slice(0, dataIndex)}data: ${cleaned.text}`;
  }

  const cleaned = stripUsageMetadataFromJson(trimmed);

  return cleaned.changed ? cleaned.text : line;
};
