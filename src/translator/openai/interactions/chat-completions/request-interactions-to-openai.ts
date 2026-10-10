/**
 * Interactions client -> OpenAI Chat Completions provider (request).
 *
 * Go source: internal/translator/openai/interactions/chat-completions/interactions_openai_request.go.
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
import { getStr, isArr, str } from "../../common/read.ts";
import {
  firstExisting,
  firstNonEmpty,
  interactionsFileNameFromMime,
  interactionsText,
  isAntigravityModel,
  jsonStringValue,
  openAIInputAudioFormatFromMime,
} from "./shared.ts";

const interactionsMediaDataUrl = (part: Json, fallbackMimeType: string): string => {
  const url = firstNonEmpty(
    getStr(part, "image_url"),
    getStr(part, "file_data"),
    getStr(part, "url"),
  );

  if (url !== "") return url;
  const data = getStr(part, "data");

  if (data === "") return "";
  const mimeType = firstNonEmpty(getStr(part, "mime_type"), fallbackMimeType);

  return `data:${mimeType};base64,${data}`;
};

const interactionsContentPartToOpenAI = (part: Json): JsonObject | undefined => {
  let partType = getStr(part, "type");

  if (partType === "" && get(part, "text") !== undefined) partType = "text";

  switch (partType) {
    case "text":
      return { type: "text", text: getStr(part, "text") };
    case "image":
      return {
        type: "image_url",
        image_url: { url: interactionsMediaDataUrl(part, "application/octet-stream") },
      };
    case "audio":
      return {
        type: "input_audio",
        input_audio: {
          data: getStr(part, "data"),
          format: openAIInputAudioFormatFromMime(getStr(part, "mime_type")),
        },
      };
    case "video":
      return { type: "video_url", video_url: { url: interactionsMediaDataUrl(part, "video/mp4") } };
    case "document":
    case "file": {
      const file: JsonObject = {
        filename: firstNonEmpty(
          getStr(part, "filename"),
          interactionsFileNameFromMime(getStr(part, "mime_type")),
        ),
        file_data: getStr(part, "data"),
      };

      const url = firstNonEmpty(getStr(part, "file_url"), getStr(part, "url"));

      if (url !== "") {
        delete file.file_data;
        file.file_url = url;
      }

      return { type: "file", file };
    }

    default:
      return undefined;
  }
};

const appendInteractionsContentToOpenAIMessage = (
  msg: JsonObject,
  content: Json | undefined,
  _role: string,
): void => {
  if (content === undefined) return;

  if (typeof content === "string") {
    msg.content = content;

    return;
  }

  const contentItems: JsonObject[] = [];
  let textOnly = true;
  let text = "";

  const appendPart = (part: Json): void => {
    const converted = interactionsContentPartToOpenAI(part);

    if (converted === undefined) return;

    if (converted.type === "text") text += str(converted.text);
    else textOnly = false;
    contentItems.push(converted);
  };

  if (isArr(content)) for (const part of content) appendPart(part);
  else if (isJsonObject(content)) appendPart(content);

  if (contentItems.length > 0) msg.content = textOnly ? text : contentItems;
};

const appendInteractionsMessageToOpenAI = (items: Json[], step: Json, role: string): void => {
  const msg: JsonObject = { role, content: "" };
  const content = get(step, "content");

  if (typeof content === "string") msg.content = content;
  else appendInteractionsContentToOpenAIMessage(msg, content, role);
  items.push(msg);
};

const appendInteractionsStepToOpenAI = (
  items: Json[],
  step: Json,
  defaultRole: string,
  forAntigravity: boolean,
): void => {
  switch (getStr(step, "type")) {
    case "user_input":
      appendInteractionsMessageToOpenAI(items, step, "user");
      break;
    case "model_output":
      appendInteractionsMessageToOpenAI(items, step, "assistant");
      break;
    case "thought":
      items.push({
        role: "assistant",
        content: "",
        reasoning_content: interactionsText(get(step, "content")),
      });
      break;
    case "function_call": {
      const callId = firstNonEmpty(getStr(step, "call_id"), getStr(step, "id"), "call_0");
      let name = getStr(step, "name");

      if (forAntigravity) name = antigravityUpstreamToolNameToClient(name);
      items.push({
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: callId,
            type: "function",
            function: { name, arguments: jsonStringValue(get(step, "arguments"), "{}") },
          },
        ],
      });
      break;
    }

    case "function_result":
      items.push({
        role: "tool",
        tool_call_id: firstNonEmpty(getStr(step, "call_id"), getStr(step, "id")),
        content: jsonStringValue(firstExisting(get(step, "result"), get(step, "output")), ""),
      });
      break;
    default:
      if (typeof step === "string") items.push({ role: defaultRole, content: step });
  }
};

const openAIToolFromInteractionsTool = (
  tool: Json,
  forAntigravity: boolean,
): JsonObject | undefined => {
  let name = firstNonEmpty(getStr(tool, "name"), getStr(tool, "function.name"));

  if (name === "") return undefined;

  if (forAntigravity) name = antigravityUpstreamToolNameToClient(name);
  const fn: JsonObject = { name };
  const desc = firstExisting(get(tool, "description"), get(tool, "function.description"));

  if (desc !== undefined) fn.description = str(desc);

  const params = firstExisting(
    get(tool, "parameters"),
    get(tool, "function.parameters"),
    get(tool, "parametersJsonSchema"),
  );

  if (params !== undefined) fn.parameters = cloneJson(params);

  return { type: "function", function: fn };
};

const interactionsReasoningEffort = (root: Json, gen: Json | undefined): string => {
  for (const value of [
    get(gen, "reasoning_effort"),
    get(gen, "thinking_level"),
    get(gen, "thinkingLevel"),
    get(gen, "thinking_config.thinking_level"),
    get(gen, "thinkingConfig.thinkingLevel"),
    get(root, "reasoning_effort"),
  ]) {
    if (typeof value === "string") return value.trim().toLowerCase();
  }

  return "";
};

/** `ConvertInteractionsRequestToOpenAI`. */
export const convertInteractionsRequestToOpenAI = (
  modelName: string,
  root: Json,
  stream: boolean,
): Json => {
  const out: JsonObject = { model: "", messages: [] };
  const model = firstNonEmpty(modelName, getStr(root, "model"));
  out.model = model;

  if (stream || asBool(get(root, "stream"))) out.stream = true;

  const messageItems: Json[] = [];
  const systemText = interactionsText(get(root, "system_instruction"));

  if (systemText !== "") messageItems.push({ role: "system", content: systemText });

  const forAntigravity = isAntigravityModel(model);
  const input = get(root, "input");

  if (typeof input === "string") {
    messageItems.push({ role: "user", content: input });
  } else if (isArr(input)) {
    for (const step of input)
      appendInteractionsStepToOpenAI(messageItems, step, "user", forAntigravity);
  } else if (isJsonObject(input)) {
    appendInteractionsStepToOpenAI(messageItems, input, "user", forAntigravity);
  }

  if (messageItems.length > 0) out.messages = messageItems;

  const tools = get(root, "tools");

  if (isArr(tools)) {
    const toolItems: Json[] = [];

    for (const tool of tools) {
      const converted = openAIToolFromInteractionsTool(tool, forAntigravity);

      if (converted !== undefined) toolItems.push(converted);

      const decls = firstExisting(
        get(tool, "function_declarations"),
        get(tool, "functionDeclarations"),
      );

      if (isArr(decls)) {
        for (const decl of decls) {
          const c = openAIToolFromInteractionsTool(decl, forAntigravity);

          if (c !== undefined) toolItems.push(c);
        }
      }
    }

    if (toolItems.length > 0) out.tools = toolItems;
  }

  // Generation config.
  let gen = get(root, "generation_config");

  if (gen === undefined) gen = get(root, "generationConfig");

  const copyNumber = (path: string, value: Json | undefined): void => {
    if (value !== undefined) set(out, path, cloneJson(value));
  };

  copyNumber("temperature", firstExisting(get(gen, "temperature"), get(root, "temperature")));
  copyNumber(
    "max_tokens",
    firstExisting(
      get(gen, "max_output_tokens"),
      get(gen, "maxOutputTokens"),
      get(root, "max_tokens"),
      get(root, "max_completion_tokens"),
    ),
  );
  copyNumber("top_p", firstExisting(get(gen, "top_p"), get(gen, "topP"), get(root, "top_p")));
  copyNumber("top_k", firstExisting(get(gen, "top_k"), get(gen, "topK")));
  copyNumber(
    "n",
    firstExisting(get(gen, "candidate_count"), get(gen, "candidateCount"), get(root, "n")),
  );

  const stop = firstExisting(
    get(gen, "stop_sequences"),
    get(gen, "stopSequences"),
    get(root, "stop"),
  );

  if (stop !== undefined) out.stop = cloneJson(stop);
  const toolChoice = firstExisting(get(gen, "tool_choice"), get(root, "tool_choice"));

  if (toolChoice !== undefined) out.tool_choice = cloneJson(toolChoice);
  const effort = interactionsReasoningEffort(root, gen);

  if (effort !== "") out.reasoning_effort = effort;
  const responseModalities = get(root, "response_modalities");

  if (responseModalities !== undefined) out.modalities = cloneJson(responseModalities);

  // Top level OpenAI fields.
  const format = get(root, "response_format");

  if (format !== undefined) out.response_format = cloneJson(format);
  const serviceTier = get(root, "service_tier");

  if (typeof serviceTier === "string") out.service_tier = serviceTier;

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

  for (const key of ["parallel_tool_calls", "seed", "user"]) {
    const value = get(root, key);

    if (value !== undefined) out[key] = cloneJson(value);
  }

  return out;
};
