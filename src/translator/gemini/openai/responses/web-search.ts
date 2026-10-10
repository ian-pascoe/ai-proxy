/**
 * Gemini native web search (Google Search grounding) for the OpenAI Responses translator.
 *
 * Go source: internal/translator/gemini/openai/responses/gemini_openai-responses_web_search.go.
 * `ModelSupportsWebSearch` consults the embedded static catalog only (the live registry is not reachable from pure
 * translators); see `../../util/model-info.ts`.
 */
import {
  asInt,
  asString,
  get,
  isJsonArray,
  isJsonObject,
  type Json,
  type JsonObject,
  set,
} from "../../../../json/index.ts";
import { lookupModelInfo } from "../../util/model-info.ts";

const WEB_SEARCH_TOOL_TYPES = new Set([
  "web_search",
  "web_search_2025_08_26",
  "web_search_preview",
  "web_search_preview_2025_03_11",
]);

const isWebSearchToolType = (toolType: string): boolean => WEB_SEARCH_TOOL_TYPES.has(toolType);

const trimmed = (value: Json | undefined): string => asString(value).trim();

/** `ModelSupportsWebSearch`: explicit false wins, then explicit true, then the capability flags. */
export const modelSupportsWebSearch = (modelId: string): boolean => {
  const info = lookupModelInfo(modelId, "");
  const infoAg = lookupModelInfo(modelId, "antigravity");
  const nativeOf = (candidate: typeof info): boolean | null | undefined =>
    candidate?.nativeCapabilities?.webSearch;

  if (nativeOf(info) === false || nativeOf(infoAg) === false) return false;

  if (nativeOf(info) === true || nativeOf(infoAg) === true) return true;

  return info?.supportsWebSearch === true || infoAg?.supportsWebSearch === true;
};

/** `HasResponsesWebSearchTool`. */
export const hasResponsesWebSearchTool = (root: Json | undefined): boolean => {
  const tools = get(root, "tools");

  return (
    isJsonArray(tools) && tools.some((tool) => isWebSearchToolType(asString(get(tool, "type"))))
  );
};

/** `HasOnlyResponsesWebSearchTools`: every tool is a web search tool (and there is at least one). */
export const hasOnlyResponsesWebSearchTools = (root: Json | undefined): boolean => {
  const tools = get(root, "tools");

  return (
    isJsonArray(tools) &&
    tools.length > 0 &&
    tools.every((tool) => isWebSearchToolType(asString(get(tool, "type"))))
  );
};

/** `AllowsResponsesWebSearchToolChoice`. */
export const allowsResponsesWebSearchToolChoice = (root: Json | undefined): boolean => {
  const toolChoice = get(root, "tool_choice");

  if (toolChoice === undefined) return true;

  if (typeof toolChoice === "string")
    return toolChoice === "" || toolChoice === "auto" || toolChoice === "required";

  if (!isJsonObject(toolChoice)) return false;
  const type = asString(toolChoice["type"]);

  if (type === "" || type === "auto" || type === "required" || isWebSearchToolType(type))
    return true;

  if (type === "allowed_tools") {
    const tools = toolChoice["tools"];

    return (
      isJsonArray(tools) && tools.some((tool) => isWebSearchToolType(asString(get(tool, "type"))))
    );
  }

  return false;
};

/** `ExtractResponsesWebSearchQuery`. */
export const extractResponsesWebSearchQuery = (root: Json | undefined): string => {
  const input = get(root, "input");

  if (typeof input === "string") return input.trim();

  if (isJsonArray(input)) {
    const flatParts: string[] = [];
    let isFlatParts = true;

    for (const item of input) {
      if (asString(get(item, "type")) === "input_text") {
        const text = trimmed(get(item, "text"));

        if (text !== "") flatParts.push(text);
      } else if (get(item, "role") !== undefined) {
        isFlatParts = false;
        break;
      }
    }

    if (isFlatParts && flatParts.length > 0) return flatParts.join("\n");

    for (let i = input.length - 1; i >= 0; i--) {
      const item = input[i] as Json;
      const role = asString(get(item, "role"));

      if (role !== "" && role !== "user") continue;
      const content = get(item, "content");

      if (typeof content === "string" && content.trim() !== "") return content.trim();

      if (isJsonArray(content)) {
        const textParts = content
          .map((part) => trimmed(get(part, "text")))
          .filter((text) => text !== "");

        if (textParts.length > 0) return textParts.join("\n");
      }

      const text = trimmed(get(item, "text"));

      if (text !== "") return text;
    }
  }

  return trimmed(get(root, "instructions"));
};

/** `ExtractResponsesWebSearchAllowedDomains`: from `tools[].filters.allowed_domains` of the first web search tool. */
export const extractResponsesWebSearchAllowedDomains = (root: Json | undefined): string[] => {
  const tools = get(root, "tools");

  if (!isJsonArray(tools)) return [];

  for (const tool of tools) {
    if (!isWebSearchToolType(asString(get(tool, "type")))) continue;
    const allowed = get(tool, "filters.allowed_domains");

    if (!isJsonArray(allowed)) continue;

    return allowed.map((domain) => asString(domain).trim()).filter((domain) => domain !== "");
  }

  return [];
};

/** `ExtractGroundingMetadata`. */
export const extractGroundingMetadata = (root: Json | undefined): Json | undefined =>
  get(root, "candidates.0.groundingMetadata") ??
  get(root, "response.candidates.0.groundingMetadata");

/** `ExtractGroundingQueries`. */
export const extractGroundingQueries = (groundingMetadata: Json | undefined): string[] => {
  const queries = get(groundingMetadata, "webSearchQueries");

  return isJsonArray(queries) ? queries.map((q) => asString(q).trim()).filter((q) => q !== "") : [];
};

/** `ExtractGroundingSources`. */
export const extractGroundingSources = (groundingMetadata: Json | undefined): Json[] => {
  const chunks = get(groundingMetadata, "groundingChunks");

  if (!isJsonArray(chunks)) return [];
  const seen = new Set<string>();
  const sources: Json[] = [];

  for (const chunk of chunks) {
    const uri = trimmed(get(chunk, "web.uri"));

    if (uri === "" || seen.has(uri)) continue;
    seen.add(uri);
    sources.push({ type: "url", url: uri });
  }

  return sources;
};

/** `BuildResponsesWebSearchCallItem`. */
export const buildResponsesWebSearchCallItem = (
  id: string,
  query: string,
  queries: readonly string[],
  sources: readonly Json[],
): JsonObject => {
  const item: JsonObject = {
    id,
    type: "web_search_call",
    status: "completed",
    action: { type: "search", query },
  };

  if (queries.length > 0) set(item, "action.queries", [...queries]);

  if (sources.length > 0) set(item, "action.sources", [...sources]);

  return item;
};

/** `HasValidWebGrounding`. */
export const hasValidWebGrounding = (groundingMetadata: Json | undefined): boolean => {
  if (groundingMetadata === undefined) return false;
  const queries = get(groundingMetadata, "webSearchQueries");

  if (isJsonArray(queries) && queries.some((q) => asString(q).trim() !== "")) return true;
  const chunks = get(groundingMetadata, "groundingChunks");

  return isJsonArray(chunks) && chunks.some((chunk) => trimmed(get(chunk, "web.uri")) !== "");
};

const goAtoi = (text: string): number | undefined =>
  /^[+-]?\d+$/.test(text) ? Number.parseInt(text, 10) : undefined;

const chunkList = (metadata: Json): Json[] => {
  const chunks = get(metadata, "groundingChunks");

  return isJsonArray(chunks) ? chunks : [];
};

const supportList = (metadata: Json): Json[] => {
  const supports = get(metadata, "groundingSupports");

  return isJsonArray(supports) ? supports : [];
};

/** `MergeGroundingMetadata`: merges incremental metadata, remapping chunk indices of deduplicated chunks. */
export const mergeGroundingMetadata = (
  existingInput: Json | undefined,
  newGm: Json | undefined,
): Json | undefined => {
  if (existingInput === undefined && newGm === undefined) return existingInput;
  const existingGm: Json = existingInput ?? {};

  if (newGm === undefined) return existingGm;
  const merged = structuredClone(existingGm);

  // 1. webSearchQueries (order preserved, duplicates removed)
  const newQueries = extractGroundingQueries(newGm);

  if (newQueries.length > 0) {
    const seen = new Set<string>();
    const mergedQueries: string[] = [];

    for (const q of [...extractGroundingQueries(existingGm), ...newQueries]) {
      if (seen.has(q)) continue;
      seen.add(q);
      mergedQueries.push(q);
    }

    set(merged, "webSearchQueries", mergedQueries);
  }

  // 2. groundingChunks with index remapping
  const existingChunks = chunkList(existingGm);
  const newChunks = chunkList(newGm);
  const cumulativeRemap = new Map<number, number>();
  const remapJson = get(existingGm, "_chunkIndexRemap");

  if (isJsonObject(remapJson)) {
    for (const [key, value] of Object.entries(remapJson)) {
      const oldIdx = goAtoi(key);

      if (oldIdx !== undefined) cumulativeRemap.set(oldIdx, asInt(value));
    }
  }

  const rawCount = get(existingGm, "_rawChunkCount");
  const prevRawCount = rawCount !== undefined ? asInt(rawCount) : existingChunks.length;

  if (cumulativeRemap.size === 0 && existingChunks.length > 0) {
    for (let i = 0; i < existingChunks.length; i++) cumulativeRemap.set(i, i);
  }

  const mergedChunks: Json[] = [];
  const uriToMergedIndex = new Map<string, number>();
  const rawToMergedIndex = new Map<string, number>();
  existingChunks.forEach((chunk, i) => {
    mergedChunks.push(chunk);
    const uri = trimmed(get(chunk, "web.uri"));

    if (uri !== "" && !uriToMergedIndex.has(uri)) uriToMergedIndex.set(uri, i);
    rawToMergedIndex.set(JSON.stringify(chunk), i);
  });
  newChunks.forEach((chunk, i) => {
    const uri = trimmed(get(chunk, "web.uri"));
    const title = trimmed(get(chunk, "web.title"));
    const newRawIdx = prevRawCount + i;
    const raw = JSON.stringify(chunk);

    if (uri !== "") {
      const existingIdx = uriToMergedIndex.get(uri);

      if (existingIdx !== undefined) {
        cumulativeRemap.set(newRawIdx, existingIdx);

        if (prevRawCount === 0) cumulativeRemap.set(i, existingIdx);

        if (title !== "") {
          const existingChunk = mergedChunks[existingIdx] as Json;

          if (trimmed(get(existingChunk, "web.title")) === "") {
            const updated = structuredClone(existingChunk);
            set(updated, "web.title", title);
            mergedChunks[existingIdx] = updated;
          }
        }

        return;
      }
    } else {
      const existingIdx = rawToMergedIndex.get(raw);

      if (existingIdx !== undefined) {
        cumulativeRemap.set(newRawIdx, existingIdx);

        if (prevRawCount === 0) cumulativeRemap.set(i, existingIdx);

        return;
      }
    }

    const newIdx = mergedChunks.length;
    mergedChunks.push(chunk);

    if (uri !== "") uriToMergedIndex.set(uri, newIdx);
    rawToMergedIndex.set(raw, newIdx);
    cumulativeRemap.set(newRawIdx, newIdx);

    if (prevRawCount === 0) cumulativeRemap.set(i, newIdx);
  });

  if (mergedChunks.length > 0) set(merged, "groundingChunks", mergedChunks);
  const totalRawCount = prevRawCount + newChunks.length;

  if (cumulativeRemap.size > 0) {
    const remap: JsonObject = {};

    for (const key of [...cumulativeRemap.keys()].toSorted((a, b) => a - b)) {
      remap[String(key)] = cumulativeRemap.get(key) as number;
    }

    set(merged, "_chunkIndexRemap", remap);
    set(merged, "_rawChunkCount", totalRawCount);
  }

  // 3. groundingSupports with remapped chunk indices
  const existingChunkCount = existingChunks.length;

  const supportKey = (
    partIndex: number,
    startByte: number,
    endByte: number,
    indices: readonly number[],
  ): string =>
    `${partIndex}:${startByte}:${endByte}:[${indices.toSorted((a, b) => a - b).join(" ")}]`;

  const remapIndices = (
    orig: readonly Json[],
    isExisting: boolean,
  ): { indices: number[]; needRewrite: boolean } => {
    const remapped: number[] = [];
    let needRewrite = false;

    for (const idxRes of orig) {
      const oldIdx = asInt(idxRes);
      let target = oldIdx;
      // Existing supports hold cumulative raw stream indices: only unresolved (pending) ones are remapped. Stream
      // supports always use cumulative stream-wide indices, resolved through the same map.
      const shouldRemap = isExisting
        ? existingChunkCount === 0 || oldIdx >= existingChunkCount
        : true;

      if (shouldRemap) {
        const mapped = cumulativeRemap.get(oldIdx);

        if (mapped !== undefined) {
          target = mapped;

          if (target !== oldIdx) needRewrite = true;
        }
      }

      if (!remapped.includes(target)) remapped.push(target);
    }

    if (remapped.length !== orig.length) needRewrite = true;

    return { indices: remapped, needRewrite };
  };

  const seenSupports = new Set<string>();
  const mergedSupports: Json[] = [];

  const addSupports = (supports: readonly Json[], isExisting: boolean): void => {
    for (const support of supports) {
      const partIndexValue = get(support, "segment.partIndex");
      const partIndex = partIndexValue !== undefined ? asInt(partIndexValue) : 0;
      const startByte = asInt(get(support, "segment.startIndex"));
      const endByte = asInt(get(support, "segment.endIndex"));
      const orig = get(support, "groundingChunkIndices");
      const { indices, needRewrite } = remapIndices(isJsonArray(orig) ? orig : [], isExisting);
      const key = supportKey(partIndex, startByte, endByte, indices);

      if (seenSupports.has(key)) continue;
      seenSupports.add(key);
      let rawSupport = support;

      if (needRewrite) {
        rawSupport = structuredClone(support);
        set(rawSupport, "groundingChunkIndices", indices);
      }

      mergedSupports.push(rawSupport);
    }
  };

  addSupports(supportList(existingGm), true);
  addSupports(supportList(newGm), false);

  if (mergedSupports.length > 0) set(merged, "groundingSupports", mergedSupports);

  // 4./5. searchEntryPoint and retrievalQueries
  const entryPoint = get(newGm, "searchEntryPoint");

  if (entryPoint !== undefined) set(merged, "searchEntryPoint", entryPoint);
  const retrievalQueries = get(newGm, "retrievalQueries");

  if (retrievalQueries !== undefined && get(existingGm, "retrievalQueries") === undefined) {
    set(merged, "retrievalQueries", retrievalQueries);
  }

  return merged;
};

/** `MergeCitationAnnotations`: dedupes by URL and rune offsets, preferring a titled duplicate. */
export const mergeCitationAnnotations = (
  existing: readonly Json[],
  late: readonly Json[],
): Json[] => {
  if (existing.length === 0) return [...late];

  if (late.length === 0) return [...existing];
  const result: Json[] = [];
  const keyToIndex = new Map<string, number>();

  const keyOf = (annotation: Json): string =>
    `${asString(get(annotation, "url"))}:${asInt(get(annotation, "start_index"))}:${asInt(get(annotation, "end_index"))}`;

  for (const annotation of existing) {
    const key = keyOf(annotation);

    if (!keyToIndex.has(key)) {
      keyToIndex.set(key, result.length);
      result.push(annotation);
    }
  }

  for (const annotation of late) {
    const key = keyOf(annotation);
    const index = keyToIndex.get(key);

    if (index !== undefined) {
      if (
        asString(get(result[index], "title")) === "" &&
        asString(get(annotation, "title")) !== ""
      ) {
        result[index] = annotation;
      }
    } else {
      keyToIndex.set(key, result.length);
      result.push(annotation);
    }
  }

  return result;
};

const utf8 = new TextEncoder();

const utf8Decoder = new TextDecoder();

/** Rune (code point) count of a UTF-8 byte prefix; `utf8.RuneCount` counts each invalid byte as one rune. */
const runeCount = (bytes: Uint8Array): number => {
  let count = 0;

  for (const _ of utf8Decoder.decode(bytes)) {
    void _;
    count++;
  }

  return count;
};

/** `byteOffsetToRuneOffset`. */
export const byteOffsetToRuneOffset = (text: string, byteOffset: number): number => {
  if (byteOffset <= 0) return 0;
  const bytes = utf8.encode(text);

  if (byteOffset >= bytes.length) return runeCount(bytes);

  return runeCount(bytes.subarray(0, byteOffset));
};

export interface GeminiPartMapping {
  partIndex: number;
  messageIndex: number;
  startRuneInMsg: number;
  partText: string;
}

export interface MessageRuneRange {
  messageIndex: number;
  startIndex: number;
  endIndex: number;
}

/** `mapByteOffsetsToRuneRanges`. */
const mapByteOffsetsToRuneRanges = (
  mappings: readonly GeminiPartMapping[],
  startByteInput: number,
  endByteInput: number,
): MessageRuneRange[] => {
  if (mappings.length === 0) return [];
  const startByte = Math.max(startByteInput, 0);
  let endByte = endByteInput;

  if (startByte >= endByte) return [];
  let cumBytes = 0;

  const spans = mappings.map((mapping) => {
    const length = utf8.encode(mapping.partText).length;
    const span = { mapping, cumStart: cumBytes, cumEnd: cumBytes + length };
    cumBytes += length;

    return span;
  });

  if (startByte >= cumBytes) return [];

  if (endByte > cumBytes) endByte = cumBytes;
  const ranges: MessageRuneRange[] = [];

  for (const span of spans) {
    const overlapStart = Math.max(startByte, span.cumStart);
    const overlapEnd = Math.min(endByte, span.cumEnd);

    if (overlapStart >= overlapEnd) continue;
    const partStartRune = byteOffsetToRuneOffset(
      span.mapping.partText,
      overlapStart - span.cumStart,
    );
    const partEndRune = byteOffsetToRuneOffset(span.mapping.partText, overlapEnd - span.cumStart);

    if (partEndRune <= partStartRune || partStartRune < 0) continue;
    const startRune = span.mapping.startRuneInMsg + partStartRune;
    const endRune = span.mapping.startRuneInMsg + partEndRune;
    const last = ranges[ranges.length - 1];

    if (
      last !== undefined &&
      last.messageIndex === span.mapping.messageIndex &&
      last.endIndex === startRune
    ) {
      last.endIndex = endRune;
    } else {
      ranges.push({
        messageIndex: span.mapping.messageIndex,
        startIndex: startRune,
        endIndex: endRune,
      });
    }
  }

  return ranges;
};

/** `BuildResponsesURLCitationsForMessages`: message index -> `url_citation` annotations. */
export const buildResponsesUrlCitationsForMessages = (
  groundingMetadata: Json | undefined,
  mappingsInput: readonly GeminiPartMapping[],
  messageTexts: readonly string[],
): Map<number, Json[]> => {
  const chunks = get(groundingMetadata, "groundingChunks");
  const supports = get(groundingMetadata, "groundingSupports");
  const result = new Map<number, Json[]>();

  if (
    !isJsonArray(chunks) ||
    !isJsonArray(supports) ||
    supports.length === 0 ||
    chunks.length === 0
  )
    return result;

  // Coalesce adjacent mappings that share the same PartIndex and MessageIndex.
  const mappings: GeminiPartMapping[] = [];

  for (const mapping of mappingsInput) {
    const last = mappings[mappings.length - 1];

    if (
      last !== undefined &&
      last.partIndex === mapping.partIndex &&
      last.messageIndex === mapping.messageIndex
    ) {
      last.partText += mapping.partText;
    } else {
      mappings.push({ ...mapping });
    }
  }

  const seen = new Set<string>();

  for (const support of supports) {
    const segment = get(support, "segment");
    const hasPartIndex = get(segment, "partIndex") !== undefined;
    const partIndex = asInt(get(segment, "partIndex"));
    const startByte = asInt(get(segment, "startIndex"));
    const endByte = asInt(get(segment, "endIndex"));
    let ranges: MessageRuneRange[] = [];

    if (hasPartIndex) {
      let partMappings = mappings.filter((mapping) => mapping.partIndex === partIndex);

      if (partMappings.length === 0 && partIndex === 0 && mappings.length === 1)
        partMappings = mappings;
      ranges = mapByteOffsetsToRuneRanges(partMappings, startByte, endByte);
    } else if (mappings.length > 0) {
      ranges = mapByteOffsetsToRuneRanges(mappings, startByte, endByte);
    } else if (messageTexts.length > 0) {
      const text = messageTexts[0] as string;
      const startRune = byteOffsetToRuneOffset(text, startByte);
      const endRune = byteOffsetToRuneOffset(text, endByte);

      if (endRune > startRune && startRune >= 0)
        ranges = [{ messageIndex: 0, startIndex: startRune, endIndex: endRune }];
    }

    if (ranges.length === 0) continue;
    const indices = get(support, "groundingChunkIndices");

    for (const indexValue of isJsonArray(indices) ? indices : []) {
      const idx = asInt(indexValue);

      if (idx < 0 || idx >= chunks.length) continue;
      const chunk = chunks[idx] as Json;
      const uri = trimmed(get(chunk, "web.uri"));
      const title = trimmed(get(chunk, "web.title"));

      if (uri === "") continue;

      for (const range of ranges) {
        const key = `${range.messageIndex}:${uri}:${range.startIndex}:${range.endIndex}`;

        if (seen.has(key)) continue;
        seen.add(key);

        const citation: JsonObject = {
          type: "url_citation",
          url: uri,
          title,
          start_index: range.startIndex,
          end_index: range.endIndex,
        };

        const list = result.get(range.messageIndex) ?? [];
        list.push(citation);
        result.set(range.messageIndex, list);
      }
    }
  }

  return result;
};

/** `BuildResponsesURLCitations`: citations for the message text (byte offsets become rune offsets). */
export const buildResponsesUrlCitations = (
  groundingMetadata: Json | undefined,
  text = "",
): Json[] => {
  const mappings: GeminiPartMapping[] =
    text === "" ? [] : [{ partIndex: 0, messageIndex: 0, startRuneInMsg: 0, partText: text }];

  const byMessage = buildResponsesUrlCitationsForMessages(groundingMetadata, mappings, [text]);
  const first = byMessage.get(0);

  if (first !== undefined && first.length > 0) return first;

  for (const citations of byMessage.values()) if (citations.length > 0) return citations;

  return [];
};
