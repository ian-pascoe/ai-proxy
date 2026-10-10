/**
 * Codex multi-agent v2 and orphan-delegation request rewriting.
 *
 * Go source: internal/client/codex/optimize-multi-agent-v2/{optimize_multi_agent_v2.go, orphan_delegation.go} and
 * internal/runtime/executor/helps/codex_multi_agent_v2.go. Bodies are parsed JSON mutated in place; every function
 * returns the (same) root so callers can reassign. Official Codex clients (User-Agent allow-list) send
 * `agent_message` items, `collaboration` namespace tools and encrypted collaboration messages that other providers
 * cannot read:
 *  - {@link prepareCodexMultiAgentV2Tools} lists the available models in the `spawn_agent` description and removes
 *    the `message.encrypted` flag from the collaboration message tools;
 *  - {@link optimizeCodexMultiAgentV2Request} additionally renames the `collaboration` namespace to
 *    `collaboration-optimize` upstream and {@link restoreCodexMultiAgentV2Response} restores the names in the answer;
 *  - {@link rewriteCodexMultiAgentV2Input} turns `agent_message` items into plain user messages;
 *  - {@link rewriteCodexOrphanDelegationInput} downgrades orphaned `codex_app` delegation outputs to user messages.
 */
import { compareStrings } from "../../registry/compare.ts";
import { goMarshalSorted } from "../../http/json-text.ts";
import type { HeaderInput } from "../../config/payload/index.ts";
import type { Config } from "../../config/schema.ts";
import {
  asString,
  get,
  isJsonArray,
  isJsonObject,
  type Json,
  type JsonObject,
  tryParseJson,
} from "../../json/index.ts";

const SPAWN_AGENT_DESCRIPTION_MARKER = "Spawns an agent";

const SPAWN_AGENT_MODELS_HEADING =
  "Available model overrides (optional; inherited parent model is preferred):";

const COLLABORATION_NAMESPACE = "collaboration";

const OPTIMIZED_NAMESPACE = "collaboration-optimize";

const OPTIMIZED_NAME_PREFIX = `${OPTIMIZED_NAMESPACE}__`;

const OPTIMIZED_DOT_PREFIX = `${OPTIMIZED_NAMESPACE}.`;

const COLLABORATION_MESSAGE_TOOLS: ReadonlySet<string> = new Set([
  "spawn_agent",
  "send_message",
  "followup_task",
]);

const SPAWN_AGENT_TOOLS: ReadonlySet<string> = new Set(["spawn_agent"]);

const APP_NAMESPACE = "codex_app";

const CREATE_THREAD_TOOL = "codex_app__create_thread";

const SEND_MESSAGE_TOOL = "codex_app__send_message_to_thread";

const SUBAGENT_HEADER = "X-Openai-Subagent";

const COLLAB_SPAWN_SUBAGENT = "collab_spawn";

// --- headers ------------------------------------------------------------------------------------------------------------

/** `headerValueCaseInsensitive`: the first non-blank value of `name`. */
const headerValue = (headers: HeaderInput | undefined, name: string): string => {
  if (headers === undefined) return "";

  if (headers instanceof Headers) return (headers.get(name) ?? "").trim();

  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name.toLowerCase() || value === undefined) continue;

    for (const entry of typeof value === "string" ? [value] : value)
      if (entry.trim() !== "") return entry.trim();
  }

  return "";
};

/** `IsCodexClientUserAgent`: an official Codex client identity. */
export const isCodexClientUserAgent = (userAgent: string): boolean => {
  const ua = userAgent.trim();

  return (
    ua.startsWith("Codex Desktop/") ||
    ua.startsWith("codex-tui/") ||
    ua === "codex_cli_rs" ||
    ua.startsWith("codex_cli_rs/") ||
    ua.startsWith("codex_exec/")
  );
};

const multiAgentClientEnabled = (headers: HeaderInput | undefined, enabled: boolean): boolean =>
  enabled && isCodexClientUserAgent(headerValue(headers, "User-Agent"));

/** `codexMultiAgentV2Enabled`: `client.codex.optimize-multi-agent-v2` and an official Codex client. */
export const codexMultiAgentV2Enabled = (
  headers: HeaderInput | undefined,
  config: Config,
): boolean => multiAgentClientEnabled(headers, config.client.codex["optimize-multi-agent-v2"]);

// --- orphan delegation ----------------------------------------------------------------------------------------------------

const matchDelegationTool = (item: Json): string | undefined => {
  if (asString(get(item, "namespace")) !== APP_NAMESPACE) return undefined;

  switch (asString(get(item, "name"))) {
    case "create_thread":
      return CREATE_THREAD_TOOL;
    case "send_message_to_thread":
      return SEND_MESSAGE_TOOL;
    default:
      return undefined;
  }
};

/** `buildCodexOrphanUserMessage`. */
const orphanUserMessage = (toolLabel: string, output: Json | undefined): JsonObject => {
  let outputText = "";

  if (output !== undefined)
    outputText = typeof output === "string" ? output : JSON.stringify(output);

  return {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: `Tool output from ${toolLabel}:\n${outputText}` }],
  };
};

/**
 * `RewriteCodexOrphanDelegationInput`: with `enabled` and the `X-Openai-Subagent: collab_spawn` header, a
 * `codex_app` delegation `function_call_output` without a paired `function_call` becomes a user message.
 */
export const rewriteCodexOrphanDelegationInput = (
  headers: HeaderInput | undefined,
  payload: Json,
  enabled: boolean,
): Json => {
  if (!enabled || headerValue(headers, SUBAGENT_HEADER).toLowerCase() !== COLLAB_SPAWN_SUBAGENT)
    return payload;
  const input = get(payload, "input");

  if (!isJsonArray(input)) return payload;
  const availableCalls = new Map<string, number>();

  for (const item of input) {
    if (asString(get(item, "type")) !== "function_call") continue;
    const callId = asString(get(item, "call_id"));

    if (callId.trim() !== "") availableCalls.set(callId, (availableCalls.get(callId) ?? 0) + 1);
  }

  for (const [index, item] of input.entries()) {
    if (asString(get(item, "type")) !== "function_call_output") continue;
    const callId = asString(get(item, "call_id"));

    if (callId.trim() !== "" && (availableCalls.get(callId) ?? 0) > 0) {
      availableCalls.set(callId, (availableCalls.get(callId) as number) - 1);
      continue;
    }

    const toolLabel = matchDelegationTool(item);

    if (toolLabel === undefined) continue;
    input[index] = orphanUserMessage(toolLabel, get(item, "output"));
  }

  return payload;
};

/** `RewriteCodexOrphanDelegationInputForConfig`: gated by `upstream.codex.orphan-delegation-compatibility`. */
export const rewriteCodexOrphanDelegationInputForConfig = (
  headers: HeaderInput | undefined,
  payload: Json,
  config: Config,
): Json =>
  config.upstream.codex["orphan-delegation-compatibility"]
    ? rewriteCodexOrphanDelegationInput(headers, payload, true)
    : payload;

// --- agent_message input ------------------------------------------------------------------------------------------------------

/** `rewriteCodexAgentMessageContent`: `encrypted_content` parts of agent messages become plain input text. */
const rewriteAgentMessageContent = (payload: Json): void => {
  const input = get(payload, "input");

  if (!isJsonArray(input)) return;

  for (const item of input) {
    if (asString(get(item, "type")).trim() !== "agent_message") continue;
    const content = get(item, "content");

    if (!isJsonArray(content)) continue;

    for (const [index, part] of content.entries()) {
      if (asString(get(part, "type")).trim() !== "encrypted_content" || !isJsonObject(part))
        continue;
      const encrypted = part["encrypted_content"];

      if (typeof encrypted !== "string") continue;
      // sjson.Set on the existing `type`, a new `text`, then the removal of `encrypted_content`.
      const rebuilt: JsonObject = {};

      for (const [key, value] of Object.entries(part)) {
        if (key === "encrypted_content") continue;
        rebuilt[key] = key === "type" ? "input_text" : value;
      }

      rebuilt["text"] = encrypted;
      content[index] = rebuilt;
    }
  }
};

/** `rewriteCodexAgentMessageInput`. */
const rewriteAgentMessageInput = (
  payload: Json,
  optimizeEnabled: boolean,
  compatMode: boolean,
): void => {
  const input = get(payload, "input");

  if (!isJsonArray(input)) return;

  if (optimizeEnabled) rewriteAgentMessageContent(payload);

  for (const [index, item] of input.entries()) {
    if (!isJsonObject(item)) continue;

    if (asString(item["type"]).trim() === "agent_message" && optimizeEnabled) {
      item["role"] = "user";
      item["type"] = "message";
    }

    if (compatMode) {
      delete item["author"];
      delete item["recipient"];
      delete item["internal_chat_message_metadata_passthrough"];
    }

    input[index] = item;
  }
};

/**
 * `RewriteCodexMultiAgentV2Input`: official Codex multi-agent input as standard Responses messages. `isCompat`
 * (compat models) converts unconditionally and strips the non-standard `author`/`recipient`/passthrough fields.
 */
export const rewriteCodexMultiAgentV2Input = (
  headers: HeaderInput | undefined,
  payload: Json,
  config: Config,
  isCompat = false,
): Json => {
  const optimizeEnabled = isCompat || codexMultiAgentV2Enabled(headers, config);

  if (!isCompat && !optimizeEnabled) return payload;
  rewriteAgentMessageInput(payload, optimizeEnabled, isCompat);

  return payload;
};

// --- collaboration tools ----------------------------------------------------------------------------------------------------

interface ToolRef {
  readonly tool: JsonObject;
  /** The enclosing namespace tool or `additional_tools` item; `undefined` for a top-level function. */
  readonly parent: JsonObject | undefined;
}

const collectToolsByNames = (
  tools: Json | undefined,
  parent: JsonObject | undefined,
  out: ToolRef[],
  names: ReadonlySet<string>,
): void => {
  if (!isJsonArray(tools)) return;

  for (const tool of tools) {
    if (!isJsonObject(tool)) continue;
    const toolType = asString(tool["type"]).trim();

    if (toolType === "function" && names.has(asString(tool["name"]).trim()))
      out.push({ tool, parent });

    if (toolType === "namespace") collectToolsByNames(tool["tools"], tool, out, names);
  }
};

/** `codexToolPathsByNames`: top-level tools and `additional_tools` input items, including namespace children. */
const toolsByNames = (payload: Json, names: ReadonlySet<string>): ToolRef[] => {
  const out: ToolRef[] = [];
  collectToolsByNames(get(payload, "tools"), undefined, out, names);
  const input = get(payload, "input");

  if (isJsonArray(input)) {
    for (const item of input) {
      if (asString(get(item, "type")).trim() !== "additional_tools" || !isJsonObject(item))
        continue;
      collectToolsByNames(item["tools"], item, out, names);
    }
  }

  return out;
};

const toolsHaveOptimizedConflict = (tools: Json | undefined): boolean => {
  if (!isJsonArray(tools)) return false;

  for (const tool of tools) {
    const name = asString(get(tool, "name")).trim();

    if (
      name === OPTIMIZED_NAMESPACE ||
      name.startsWith(OPTIMIZED_NAME_PREFIX) ||
      name.startsWith(OPTIMIZED_DOT_PREFIX)
    ) {
      return true;
    }

    if (
      asString(get(tool, "type")).trim() === "namespace" &&
      toolsHaveOptimizedConflict(get(tool, "tools"))
    )
      return true;
  }

  return false;
};

/** `HasCodexMultiAgentV2NamespaceConflict`: the request already defines the reserved optimized namespace. */
export const hasCodexMultiAgentV2NamespaceConflict = (payload: Json): boolean => {
  if (toolsHaveOptimizedConflict(get(payload, "tools"))) return true;
  const input = get(payload, "input");

  if (!isJsonArray(input)) return false;

  return input.some(
    (item) =>
      asString(get(item, "type")).trim() === "additional_tools" &&
      toolsHaveOptimizedConflict(get(item, "tools")),
  );
};

/** `removeCodexCollaborationMessageEncryption`: the proxy must be able to read the plaintext message. */
const removeMessageEncryption = (refs: ReadonlyArray<ToolRef>): void => {
  for (const { tool } of refs) {
    const message = get(tool, "parameters.properties.message");

    if (isJsonObject(message)) delete message["encrypted"];
  }
};

// --- spawn_agent model list ----------------------------------------------------------------------------------------------------

/** A model offered to `spawn_agent` (`GetAvailableModels("openai")` entry). */
export interface SpawnAgentAvailableModel {
  readonly id: string;
  readonly description?: string;
  readonly displayName?: string;
}

/** The registry data behind the `spawn_agent` model list. */
export interface SpawnAgentSource {
  readonly availableModels: ReadonlyArray<SpawnAgentAvailableModel>;
  /** The validated `codex_client_models.json` catalog (`{ models: [...] }`). */
  readonly catalog: unknown;
  /** `registry.LookupModelInfo(modelID)`. */
  readonly lookupModel: (
    modelId: string,
  ) =>
    | {
        readonly description?: string;
        readonly thinking?: { readonly levels?: ReadonlyArray<string> };
      }
    | undefined;
}

interface SpawnAgentModel {
  id: string;
  description: string;
  reasoningEfforts: string[];
  defaultReasoningEffort: string;
  serviceTiers: string[];
  priority: number;
  displayName: string;
}

const mapString = (values: Json | undefined, key: string): string => {
  const value = get(values, key);

  return typeof value === "string" ? value.trim() : "";
};

const normalizeReasoningEffort = (effort: string): string => {
  const value = effort.trim().toLowerCase();

  return ["none", "low", "medium", "high", "xhigh", "max", "ultra"].includes(value) ? value : "";
};

/** `codexReasoningMetadata`. */
const reasoningMetadata = (
  metadata: Json,
): { readonly efforts: string[]; readonly defaultEffort: string } => {
  const levels = get(metadata, "supported_reasoning_levels");
  const efforts: string[] = [];

  if (isJsonArray(levels)) {
    for (const level of levels) {
      const effort = normalizeReasoningEffort(mapString(level, "effort"));

      if (effort !== "") efforts.push(effort);
    }
  }

  if (efforts.length === 0) return { efforts: [], defaultEffort: "" };
  let defaultEffort = normalizeReasoningEffort(mapString(metadata, "default_reasoning_level"));

  if (!efforts.includes(defaultEffort)) defaultEffort = efforts[0] as string;

  return { efforts, defaultEffort };
};

/** `codexServiceTierIDs`. */
const serviceTierIds = (metadata: Json): string[] => {
  const tiers = get(metadata, "service_tiers");
  const ids: string[] = [];

  if (!isJsonArray(tiers)) return ids;

  for (const tier of tiers) {
    const id = mapString(tier, "id");

    if (id !== "" && !ids.includes(id)) ids.push(id);
  }

  return ids;
};

/** `codexSpawnAgentModelFromMetadata`. */
const modelFromMetadata = (modelId: string, metadata: Json): SpawnAgentModel => {
  const reasoning = reasoningMetadata(metadata);
  const priority = get(metadata, "priority");

  return {
    id: modelId,
    description: mapString(metadata, "description"),
    displayName: mapString(metadata, "display_name"),
    priority: typeof priority === "number" ? Math.trunc(priority) : 0,
    reasoningEfforts: reasoning.efforts,
    defaultReasoningEffort: reasoning.defaultEffort,
    serviceTiers: serviceTierIds(metadata),
  };
};

/** `applyCodexSpawnAgentThinking`. */
const applySpawnAgentThinking = (
  profile: SpawnAgentModel,
  levels: ReadonlyArray<string> | undefined,
): void => {
  if (levels === undefined || levels.length === 0) return;
  const efforts: string[] = [];
  let defaultEffort = "";
  let firstEffort = "";

  for (const raw of levels) {
    const effort = normalizeReasoningEffort(raw);

    if (effort === "") continue;

    if (firstEffort === "") firstEffort = effort;

    if ((defaultEffort === "" && effort !== "none") || effort === "medium") defaultEffort = effort;
    efforts.push(effort);
  }

  if (efforts.length === 0) return;
  profile.reasoningEfforts = efforts;
  profile.defaultReasoningEffort = defaultEffort === "" ? firstEffort : defaultEffort;
};

/** `codexSpawnAgentModelsFromTemplates`: template models by priority, then synthesised ones by display name. */
const spawnAgentModels = (source: SpawnAgentSource): SpawnAgentModel[] => {
  const catalogModels = get(source.catalog as Json, "models");

  if (!isJsonArray(catalogModels) || catalogModels.length === 0) return [];
  const templates = new Map<string, Json>();
  let defaultTemplate: Json | undefined;

  for (const model of catalogModels) {
    const slug = mapString(model, "slug");

    if (slug === "") continue;
    templates.set(slug, model);

    if (slug === "gpt-5.5") defaultTemplate = model;
  }

  if (defaultTemplate === undefined) return [];

  const seen = new Set<string>();
  const templateModels: SpawnAgentModel[] = [];
  const synthesized: SpawnAgentModel[] = [];

  for (const available of source.availableModels) {
    const modelId = available.id.trim();

    if (modelId === "" || seen.has(modelId)) continue;
    seen.add(modelId);
    const template = templates.get(modelId);

    if (template !== undefined) {
      templateModels.push(modelFromMetadata(modelId, template));
      continue;
    }

    const profile = modelFromMetadata(modelId, defaultTemplate);
    profile.id = modelId;
    profile.description = (available.description ?? "").trim();
    profile.displayName = (available.displayName ?? "").trim() || modelId;
    const info = source.lookupModel(modelId);

    if (info !== undefined) {
      if ((info.description ?? "").trim() !== "")
        profile.description = (info.description as string).trim();
      applySpawnAgentThinking(profile, info.thinking?.levels);
    }

    if (profile.description === "") profile.description = modelId;
    profile.serviceTiers = [];
    synthesized.push(profile);
  }

  templateModels.sort((a, b) =>
    a.priority === b.priority ? compareStrings(a.id, b.id) : a.priority - b.priority,
  );
  synthesized.sort((a, b) => {
    const left = a.displayName.toLowerCase();
    const right = b.displayName.toLowerCase();

    return left === right ? compareStrings(a.id, b.id) : compareStrings(left, right);
  });

  return [...templateModels, ...synthesized];
};

const fields = (text: string): string[] => text.split(/\s+/).filter((part) => part !== "");

const markdownCode = (value: string): string =>
  value.includes("`") ? `\`\` ${value} \`\`` : `\`${value}\``;

const writeSentence = (value: string): string => (/[.!?]$/.test(value) ? value : `${value}.`);

/** `formatCodexSpawnAgentModels`: one markdown bullet per model. */
const formatSpawnAgentModels = (models: ReadonlyArray<SpawnAgentModel>): string => {
  let out = "";

  for (const model of models) {
    const modelId = fields(model.id).join(" ");

    if (modelId === "") continue;
    out += `- ${markdownCode(modelId)}: `;
    let hasDetails = false;
    const description = fields(model.description).join(" ");

    if (description !== "") {
      out += writeSentence(description);
      hasDetails = true;
    }

    if (model.reasoningEfforts.length > 0) {
      if (hasDetails) out += " ";
      out += `Reasoning efforts: ${model.reasoningEfforts
        .map((effort) => (effort === model.defaultReasoningEffort ? `${effort} (default)` : effort))
        .join(", ")}.`;
      hasDetails = true;
    }

    if (model.serviceTiers.length > 0) {
      if (hasDetails) out += " ";
      out += `Service tiers: ${model.serviceTiers.join(", ")}.`;
    }

    out += "\n";
  }

  return out.endsWith("\n") ? out.slice(0, -1) : out;
};

/** Go `strings.SplitAfter(text, "\n")`. */
const splitAfterNewline = (text: string): string[] => {
  const lines: string[] = [];
  let start = 0;

  for (;;) {
    const index = text.indexOf("\n", start);

    if (index < 0) break;
    lines.push(text.slice(start, index + 1));
    start = index + 1;
  }

  lines.push(text.slice(start));

  return lines;
};

/** `removeCodexSpawnAgentModelSections`: drops earlier model lists, remembering the heading indentation. */
const removeModelSections = (
  description: string,
): { readonly cleaned: string; readonly headingIndent: string } => {
  if (!description.includes(SPAWN_AGENT_MODELS_HEADING))
    return { cleaned: description, headingIndent: "" };
  const lines = splitAfterNewline(description);
  let cleaned = "";
  let headingIndent = "";

  for (let index = 0; index < lines.length;) {
    const line = lines[index] as string;

    if (line.trim() !== SPAWN_AGENT_MODELS_HEADING) {
      cleaned += line;
      index++;
      continue;
    }

    if (headingIndent === "") {
      const headingIndex = line.indexOf(SPAWN_AGENT_MODELS_HEADING);

      if (headingIndex > 0) headingIndent = line.slice(0, headingIndex);
    }

    index++;

    while (index < lines.length && (lines[index] as string).trim().startsWith("- ")) index++;
  }

  return { cleaned, headingIndent };
};

/** `replaceCodexSpawnAgentModels`. */
const replaceSpawnAgentModels = (description: string, modelList: string): string => {
  if (modelList === "") return description;
  const { cleaned, headingIndent } = removeModelSections(description);
  const section = `${headingIndent}${SPAWN_AGENT_MODELS_HEADING}\n${modelList}\n`;
  const markerIndex = cleaned.indexOf(SPAWN_AGENT_DESCRIPTION_MARKER);

  if (markerIndex >= 0) {
    const markerLineStart = cleaned.lastIndexOf("\n", markerIndex - 1) + 1;

    return cleaned.slice(0, markerLineStart) + section + cleaned.slice(markerLineStart);
  }

  const separator = cleaned !== "" && !cleaned.endsWith("\n") ? "\n\n" : "";

  return cleaned + separator + section.slice(0, -1);
};

/** `rewriteCodexCollaborationTools`. */
const rewriteCollaborationTools = (
  messageTools: ReadonlyArray<ToolRef>,
  spawnAgentTools: ReadonlyArray<ToolRef>,
  modelList: string,
): void => {
  for (const { tool } of spawnAgentTools) {
    const description = tool["description"];

    if (typeof description === "string" && modelList !== "") {
      const rewritten = replaceSpawnAgentModels(description, modelList);

      if (rewritten !== description) tool["description"] = rewritten;
    }
  }

  removeMessageEncryption(messageTools);
};

/**
 * `PrepareCodexMultiAgentV2Tools`: prepares the collaboration tool definitions at the Responses API boundary without
 * renaming the namespace. `prepared` is false when the optimisation does not apply to this request.
 */
export const prepareCodexMultiAgentV2Tools = (
  headers: HeaderInput | undefined,
  payload: Json,
  enabled: boolean,
  source?: SpawnAgentSource,
): { readonly payload: Json; readonly prepared: boolean } => {
  if (!multiAgentClientEnabled(headers, enabled)) return { payload, prepared: false };
  const spawnAgentTools = toolsByNames(payload, SPAWN_AGENT_TOOLS);
  const messageTools = toolsByNames(payload, COLLABORATION_MESSAGE_TOOLS);

  if (spawnAgentTools.length === 0 && messageTools.length === 0) return { payload, prepared: true };

  if (hasCodexMultiAgentV2NamespaceConflict(payload)) {
    removeMessageEncryption(messageTools);

    return { payload, prepared: true };
  }

  const modelList =
    spawnAgentTools.length > 0 && source !== undefined
      ? formatSpawnAgentModels(spawnAgentModels(source))
      : "";

  rewriteCollaborationTools(messageTools, spawnAgentTools, modelList);

  return { payload, prepared: true };
};

/** `optimizeCodexCollaborationNamespace`. */
const optimizeCollaborationNamespace = (refs: ReadonlyArray<ToolRef>): boolean => {
  let optimized = false;

  for (const { parent } of refs) {
    if (parent === undefined) continue;

    if (
      asString(parent["type"]).trim() !== "namespace" ||
      asString(parent["name"]).trim() !== COLLABORATION_NAMESPACE
    ) {
      continue;
    }

    parent["name"] = OPTIMIZED_NAMESPACE;
    optimized = true;
  }

  return optimized;
};

/**
 * `OptimizeCodexMultiAgentV2Request`: prepares the tools (unless `toolsPrepared`: the Responses handler already did)
 * and renames the `collaboration` namespace for the upstream. `optimized` tells the caller to restore the response.
 */
export const optimizeCodexMultiAgentV2Request = (
  headers: HeaderInput | undefined,
  payload: Json,
  config: Config,
  options: { readonly source?: SpawnAgentSource; readonly toolsPrepared?: boolean } = {},
): { readonly payload: Json; readonly optimized: boolean } => {
  if (!codexMultiAgentV2Enabled(headers, config)) return { payload, optimized: false };
  rewriteAgentMessageContent(payload);

  if (options.toolsPrepared === true) {
    removeMessageEncryption(toolsByNames(payload, COLLABORATION_MESSAGE_TOOLS));
  } else {
    prepareCodexMultiAgentV2Tools(
      headers,
      payload,
      config.client.codex["optimize-multi-agent-v2"],
      options.source,
    );
  }

  const spawnAgentTools = toolsByNames(payload, SPAWN_AGENT_TOOLS);

  if (spawnAgentTools.length === 0 || hasCodexMultiAgentV2NamespaceConflict(payload))
    return { payload, optimized: false };

  return { payload, optimized: optimizeCollaborationNamespace(spawnAgentTools) };
};

/**
 * `OptimizeCodexMultiAgentV2RequestForAuth`: orphan delegation rewrite, the optimisation and, for compat models, the
 * `agent_message` conversion. API-key credentials see the config without OAuth-only settings (the executor scope).
 */
export const optimizeCodexMultiAgentV2RequestForAuth = (
  headers: HeaderInput | undefined,
  payload: Json,
  config: Config,
  isCompat: boolean,
  options: { readonly source?: SpawnAgentSource; readonly toolsPrepared?: boolean } = {},
): { readonly payload: Json; readonly optimized: boolean } => {
  rewriteCodexOrphanDelegationInputForConfig(headers, payload, config);
  const result = optimizeCodexMultiAgentV2Request(headers, payload, config, options);

  if (isCompat) rewriteCodexMultiAgentV2Input(headers, result.payload, config, true);

  return result;
};

// --- response restoration -------------------------------------------------------------------------------------------------------

const restoreCollaborationValue = (value: Json): boolean => {
  let changed = false;

  if (isJsonArray(value)) {
    for (const item of value) if (restoreCollaborationValue(item)) changed = true;

    return changed;
  }

  if (!isJsonObject(value)) return false;
  const itemType = mapString(value, "type");
  const isToolCall = itemType === "function_call" || itemType === "custom_tool_call";

  if (isToolCall && value["namespace"] === OPTIMIZED_NAMESPACE) {
    value["namespace"] = COLLABORATION_NAMESPACE;
    changed = true;
  }

  const name = value["name"];

  if (typeof name === "string") {
    if (name === OPTIMIZED_NAMESPACE && itemType === "namespace") {
      value["name"] = COLLABORATION_NAMESPACE;
      changed = true;
    } else if (isToolCall && name.startsWith(OPTIMIZED_DOT_PREFIX)) {
      const toolName = name.slice(OPTIMIZED_DOT_PREFIX.length);

      if (toolName !== "") {
        value["namespace"] = COLLABORATION_NAMESPACE;
        value["name"] = toolName;
        changed = true;
      }
    } else if (isToolCall && name.startsWith(OPTIMIZED_NAME_PREFIX)) {
      value["name"] = `${COLLABORATION_NAMESPACE}__${name.slice(OPTIMIZED_NAME_PREFIX.length)}`;
      changed = true;
    }
  }

  for (const [key, child] of Object.entries(value)) {
    if (
      key === "arguments" ||
      key === "input" ||
      (key === "output" &&
        (itemType === "function_call_output" || itemType === "custom_tool_call_output"))
    ) {
      continue;
    }

    if (restoreCollaborationValue(child)) changed = true;
  }

  return changed;
};

/**
 * `RestoreCodexMultiAgentV2Response`: restores the collaboration namespace in an upstream JSON payload (text). A
 * restored payload is re-marshalled like Go does (sorted keys); untouched or invalid payloads are returned as is.
 */
export const restoreCodexMultiAgentV2Response = (payload: string, optimized: boolean): string => {
  if (!optimized || payload === "") return payload;
  const parsed = tryParseJson(payload);

  if (parsed === undefined || !restoreCollaborationValue(parsed)) return payload;

  return goMarshalSorted(parsed);
};
