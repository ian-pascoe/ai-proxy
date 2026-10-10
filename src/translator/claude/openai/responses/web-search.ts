/**
 * Claude server-side web search <-> Responses `web_search_call` items.
 *
 * Go source: internal/translator/claude/openai/responses/claude_openai-responses_web_search.go.
 *
 * Claude reports server-side search as a `server_tool_use` + `web_search_tool_result` pair; Responses models it as
 * one `web_search_call` item. The pair folds into one item on the way out and expands back on the way in.
 */
import { get, type Json, type JsonObject } from "../../../../json/index.ts";
import { isArr, isObj, str } from "../../../common/gjson.ts";

export const CLAUDE_WEB_SEARCH_TOOL_NAME = "web_search";

const RESPONSES_WEB_SEARCH_ID_PREFIX = "ws_";

const CLAUDE_SERVER_TOOL_ID_PREFIX = "srvtoolu_";

export const responsesWebSearchCallID = (claudeToolUseID: string): string =>
  RESPONSES_WEB_SEARCH_ID_PREFIX + claudeToolUseID;

/** Recovers (and normalises to Anthropic's `srvtoolu_…` shape) the server_tool_use id from a Responses item id. */
export const claudeWebSearchToolUseID = (responsesItemID: string): string => {
  let body = responsesItemID.trim();

  if (body.startsWith(RESPONSES_WEB_SEARCH_ID_PREFIX))
    body = body.slice(RESPONSES_WEB_SEARCH_ID_PREFIX.length);

  if (body.startsWith(CLAUDE_SERVER_TOOL_ID_PREFIX))
    body = body.slice(CLAUDE_SERVER_TOOL_ID_PREFIX.length);
  body = body.replace(/[^a-zA-Z0-9_]/gu, "_");

  return body === "" ? "" : CLAUDE_SERVER_TOOL_ID_PREFIX + body;
};

/** Query from a Claude server_tool_use input (accumulated streaming JSON text). */
export const claudeWebSearchQuery = (input: string): string => {
  if (input === "") return "";

  try {
    return str(get(JSON.parse(input) as Json, "query")).trim();
  } catch {
    return "";
  }
};

/** Content of a `web_search_tool_result` block -> Responses `results` (entries ride through verbatim). */
export const claudeWebSearchResultsToResponses = (content: Json | undefined): Json | undefined => {
  if (isObj(content)) return content;

  if (!isArr(content)) return undefined;

  const results = content.filter(
    (entry) =>
      str(get(entry, "type")) === "web_search_tool_result_error" ||
      str(get(entry, "url")).trim() !== "",
  );

  return results;
};

/** The Responses item standing for one Claude server-side search. */
export const buildResponsesWebSearchCallItem = (
  claudeToolUseID: string,
  query: string,
  results: Json | undefined,
): JsonObject => {
  const item: JsonObject = {
    id: responsesWebSearchCallID(claudeToolUseID),
    type: "web_search_call",
    status: "completed",
    action: { type: "search", query },
  };

  if (results !== undefined) item.results = results;

  return item;
};

/** Inverse of `buildResponsesWebSearchCallItem`: rebuilds the Claude block pair for a replayed turn. */
export const convertResponsesWebSearchCallToClaudeBlocks = (item: Json): JsonObject[] => {
  const toolUseID = claudeWebSearchToolUseID(str(get(item, "id")).trim());

  if (toolUseID === "") return [];
  const input: JsonObject = {};
  const query = responsesWebSearchCallQuery(item);

  if (query !== "") input.query = query;
  const use: JsonObject = {
    type: "server_tool_use",
    id: toolUseID,
    name: CLAUDE_WEB_SEARCH_TOOL_NAME,
    input,
  };
  const result: JsonObject = {
    type: "web_search_tool_result",
    tool_use_id: toolUseID,
    content: [],
  };
  const content = responsesWebSearchResultsToClaude(get(item, "results"));

  if (content !== undefined) result.content = content;

  return [use, result];
};

const responsesWebSearchCallQuery = (item: Json): string => {
  const query = str(get(item, "action.query")).trim();

  if (query !== "") return query;
  const first = str(get(item, "action.queries.0")).trim();

  if (first !== "") return first;

  return str(get(item, "action.url")).trim();
};

const responsesWebSearchResultsToClaude = (results: Json | undefined): Json | undefined => {
  if (isObj(results)) return results;

  if (!isArr(results)) return undefined;
  const blocks: Json[] = [];

  for (const entry of results) {
    if (str(get(entry, "type")) === "web_search_tool_result_error") {
      blocks.push(entry);
      continue;
    }

    // Anthropic rejects a result without its genuine encrypted_content, so such an entry is unusable.
    if (str(get(entry, "encrypted_content")).trim() === "") continue;
    blocks.push(isObj(entry) ? { ...entry, type: "web_search_result" } : entry);
  }

  return blocks.length === 0 ? undefined : blocks;
};

/** Mirrors Responses `annotations` back onto a Claude text block as `citations` (entries need `encrypted_index`). */
export const attachClaudeCitations = (
  textBlock: JsonObject,
  annotations: Json | undefined,
): JsonObject => {
  if (!isArr(annotations)) return textBlock;
  const citations = annotations.filter(
    (annotation) => str(get(annotation, "encrypted_index")).trim() !== "",
  );

  if (citations.length === 0) return textBlock;
  textBlock.citations = citations;

  return textBlock;
};
