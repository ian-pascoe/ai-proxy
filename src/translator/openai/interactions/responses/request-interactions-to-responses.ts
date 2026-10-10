/**
 * Interactions client -> OpenAI Responses provider (request).
 *
 * Go source: internal/translator/openai/interactions/responses/interactions_openai_responses_request.go
 * (ConvertInteractionsRequestToOpenAIResponses and helpers).
 */
import {
  asBool,
  cloneJson,
  get,
  isJsonObject,
  type Json,
  type JsonObject,
  set,
} from "../../../../json/index.ts";
import { antigravityUpstreamToolNameToClient } from "../../common/antigravity-tools.ts";
import { eachValue, getStr, isArr, str } from "../../common/read.ts";
import {
  firstExisting,
  firstNonEmpty,
  interactionsContentPartToResponses,
  interactionsContentTexts,
  interactionsFunctionCallToResponses,
  isAntigravityModel,
  jsonStringValue,
} from "./shared.ts";

const requestModel = (modelName: string, root: Json): string =>
  modelName.trim() !== "" ? modelName : getStr(root, "model");

/** `interactionsSystemInstructionText`. */
const systemInstructionText = (root: Json): string => {
  const sys = get(root, "system_instruction");

  if (sys === undefined) return "";

  if (typeof sys === "string") return sys;
  const text = get(sys, "text");

  if (text !== undefined) return getStr(sys, "text");
  const parts = get(sys, "parts");

  if (isArr(parts)) {
    let out = "";

    for (const part of parts) {
      const t = getStr(part, "text");

      if (t !== "") out += t;
    }

    return out;
  }

  return "";
};

/** `interactionsThinkingEffort`. */
const thinkingEffort = (root: Json): string => {
  for (const path of [
    "generation_config.thinking_level",
    "generation_config.thinkingConfig.thinkingLevel",
    "generation_config.thinkingConfig.thinking_level",
    "generation_config.thinking_config.thinking_level",
  ]) {
    const level = get(root, path);

    if (typeof level === "string") return level.trim().toLowerCase();
  }

  return "";
};

const textMessage = (text: string): JsonObject => ({
  type: "message",
  role: "user",
  content: [{ type: "input_text", text }],
});

/** `interactionsMessageToResponses`. */
const messageToResponses = (item: Json, role: string): JsonObject => {
  const items: Json[] = [];
  const content = get(item, "content");

  if (typeof content === "string") {
    items.push({ type: role === "assistant" ? "output_text" : "input_text", text: content });
  } else {
    for (const part of eachValue(content)) {
      const converted = interactionsContentPartToResponses(part, role);

      if (converted !== undefined) items.push(converted);
    }
  }

  const out: JsonObject = { type: "message", role, content: [] };

  if (items.length > 0) out.content = items;

  return out;
};

/** `interactionsThoughtToResponses`. */
const thoughtToResponses = (item: Json): JsonObject => {
  const summary: Json[] = interactionsContentTexts(get(item, "content")).map((text) => ({
    type: "summary_text",
    text,
  }));
  const out: JsonObject = { type: "reasoning", summary: [] };

  if (summary.length > 0) out.summary = summary;

  return out;
};

/** `interactionsFunctionResultToResponses`. */
const functionResultToResponses = (item: Json, forAntigravity: boolean): JsonObject => {
  const out: JsonObject = { type: "function_call_output", call_id: "", output: "" };
  const callId = firstNonEmpty(getStr(item, "call_id"), getStr(item, "id"));

  if (callId !== "") out.call_id = callId;
  let name = getStr(item, "name");

  if (name !== "") {
    if (forAntigravity) name = antigravityUpstreamToolNameToClient(name);
    out.name = name;
  }

  let result = get(item, "result");

  if (result === undefined) result = get(item, "output");
  out.output = jsonStringValue(result, "");

  return out;
};

/** `interactionsInputItemToResponses`. */
const inputItemToResponses = (item: Json, forAntigravity: boolean): Json | undefined => {
  switch (getStr(item, "type")) {
    case "user_input":
      return messageToResponses(item, "user");
    case "model_output":
      return messageToResponses(item, "assistant");
    case "thought":
      return thoughtToResponses(item);
    case "function_call":
      return interactionsFunctionCallToResponses(item, forAntigravity, undefined);
    case "function_result":
      return functionResultToResponses(item, forAntigravity);
    default:
      if (typeof item === "string") return textMessage(item);
  }

  return undefined;
};

/** `responsesToolFromInteractionsTool`. */
const toolFromInteractionsTool = (tool: Json, forAntigravity: boolean): JsonObject | undefined => {
  let name = firstNonEmpty(getStr(tool, "name"), getStr(tool, "function.name"));

  if (name === "") return undefined;

  if (forAntigravity) name = antigravityUpstreamToolNameToClient(name);
  const out: JsonObject = { type: "function", name };
  const description = firstExisting(get(tool, "description"), get(tool, "function.description"));

  if (description !== undefined) out.description = str(description);

  const parameters = firstExisting(
    get(tool, "parameters"),
    get(tool, "function.parameters"),
    get(tool, "parametersJsonSchema"),
  );

  if (parameters !== undefined) out.parameters = cloneJson(parameters);

  return out;
};

/** `ConvertInteractionsRequestToOpenAIResponses`. */
export const convertInteractionsRequestToOpenAIResponses = (
  modelName: string,
  body: Json,
  stream: boolean,
): Json => {
  const root = body;
  const out: JsonObject = { model: "", input: [] };
  const model = requestModel(modelName, root);
  out.model = model;

  if (stream || asBool(get(root, "stream"))) out.stream = true;
  const instructions = systemInstructionText(root);

  if (instructions !== "") out.instructions = instructions;
  const previous = firstNonEmpty(
    getStr(root, "previous_interaction_id"),
    getStr(root, "previous_response_id"),
  );

  if (previous !== "") out.previous_response_id = previous;
  const environmentId = firstNonEmpty(
    getStr(root, "environment_id"),
    getStr(root, "environment.id"),
  );

  if (environmentId !== "") out.environment_id = environmentId;
  const agentConfig = get(root, "agent_config");

  if (agentConfig !== undefined) out.agent_config = cloneJson(agentConfig);
  const forAntigravity = isAntigravityModel(model);

  const input = get(root, "input");

  if (input !== undefined) {
    const items: Json[] = [];

    if (typeof input === "string") items.push(textMessage(input));
    else if (isArr(input)) {
      for (const item of input) {
        const converted = inputItemToResponses(item, forAntigravity);

        if (converted !== undefined) items.push(converted);
      }
    } else if (isJsonObject(input)) {
      const converted = inputItemToResponses(input, forAntigravity);

      if (converted !== undefined) items.push(converted);
    }

    if (items.length > 0) out.input = items;
  }

  const tools = get(root, "tools");

  if (isArr(tools)) {
    const toolItems: Json[] = [];

    for (const tool of tools) {
      const converted = toolFromInteractionsTool(tool, forAntigravity);

      if (converted !== undefined) toolItems.push(converted);
      const declarations = get(tool, "function_declarations");

      if (isArr(declarations)) {
        for (const declaration of declarations) {
          const decl = toolFromInteractionsTool(declaration, forAntigravity);

          if (decl !== undefined) toolItems.push(decl);
        }
      }
    }

    if (toolItems.length > 0) out.tools = toolItems;
  }

  const toolChoice = firstExisting(
    get(root, "generation_config.tool_choice"),
    get(root, "tool_choice"),
  );

  if (toolChoice !== undefined) out.tool_choice = cloneJson(toolChoice);
  const effort = thinkingEffort(root);

  if (effort !== "") set(out, "reasoning.effort", effort);
  const summary = get(root, "generation_config.thinking_summaries");

  if (typeof summary === "string") set(out, "reasoning.summary", summary);
  const modalities = get(root, "response_modalities");

  if (modalities !== undefined) out.modalities = cloneJson(modalities);
  const serviceTier = get(root, "service_tier");

  if (typeof serviceTier === "string") out.service_tier = serviceTier;
  const format = get(root, "response_format");

  if (format !== undefined) set(out, "text.format", cloneJson(format));

  return out;
};
