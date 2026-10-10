/**
 * OpenAI Responses upstream -> Interactions client (response).
 *
 * Go source: internal/translator/openai/interactions/responses/interactions_openai_responses_response.go
 * (ConvertOpenAIResponsesResponseToInteractions and its non-stream variant).
 */
import { asInt, get, type Json, type JsonObject, set } from "../../../../json/index.ts";
import { sseEvent } from "../../../../http/sse.ts";
import type { ResponseContext, ResponseTransform } from "../../../registry.ts";
import { antigravityToolNameToUpstream } from "../../common/antigravity-tools.ts";
import { eachEntry, getStr, isArr } from "../../common/read.ts";
import {
  firstNonEmpty,
  isAntigravityModel,
  jsonStringValue,
  parseJson,
  responsesContentPartToInteractions,
  responsesFunctionCallToInteractions,
  ssePayloadOf,
} from "./shared.ts";

interface State {
  id: string;
  created: boolean;
  statusUpdated: boolean;
  completed: boolean;
  done: boolean;
  stepIndex: number;
  activeStepIndex: number;
  activeStepType: string;
  activeStepOpen: boolean;
  sentText: Set<string>;
  unkeyedTextDelta: boolean;
  functionArgsSent: Set<string>;
}

const newState = (): State => ({
  id: "",
  created: false,
  statusUpdated: false,
  completed: false,
  done: false,
  stepIndex: 0,
  activeStepIndex: 0,
  activeStepType: "",
  activeStepOpen: false,
  sentText: new Set(),
  unkeyedTextDelta: false,
  functionArgsSent: new Set(),
});

const nowRfc3339 = (): string => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

const ev = (event: string, payload: Json): string => sseEvent(event, JSON.stringify(payload));

const responseModel = (modelName: string, root: Json | undefined): string =>
  firstNonEmpty(
    modelName,
    getStr(root, "model"),
    getStr(root, "response.model"),
    getStr(root, "interaction.model"),
  );

/** `setInteractionsUsageFromResponses`. */
export const setInteractionsUsageFromResponses = (
  out: JsonObject,
  path: string,
  usage: Json | undefined,
): JsonObject => {
  if (usage === undefined) return out;

  const setInt = (name: string, value: Json | undefined, ...more: string[]): void => {
    if (value === undefined) return;
    const n = asInt(value);
    set(out, `${path}.${name}`, n);

    for (const extra of more) set(out, `${path}.${extra}`, n);
  };

  setInt("input_tokens", get(usage, "input_tokens"), "total_input_tokens");
  setInt("output_tokens", get(usage, "output_tokens"), "total_output_tokens");
  setInt("total_tokens", get(usage, "total_tokens"));
  setInt("cached_tokens", get(usage, "input_tokens_details.cached_tokens"), "total_cached_tokens");
  setInt(
    "reasoning_tokens",
    get(usage, "output_tokens_details.reasoning_tokens"),
    "total_thought_tokens",
  );

  return out;
};

const appendStatusUpdate = (out: string[], st: State): void => {
  if (st.statusUpdated) return;
  out.push(
    ev("interaction.status_update", {
      interaction_id: st.id,
      status: "in_progress",
      event_type: "interaction.status_update",
    }),
  );
  st.statusUpdated = true;
};

const appendCreated = (
  out: string[],
  st: State,
  modelName: string,
  response: Json | undefined,
): void => {
  if (st.created) return;
  st.id = firstNonEmpty(getStr(response, "id"), st.id, `interaction_${Date.now()}000000`);
  out.push(
    ev("interaction.created", {
      interaction: {
        id: st.id,
        status: "in_progress",
        object: "interaction",
        model: responseModel(modelName, response),
      },
      event_type: "interaction.created",
    }),
  );
  st.created = true;
  appendStatusUpdate(out, st);
};

const appendStepStop = (out: string[], st: State): void => {
  if (!st.activeStepOpen) return;
  out.push(ev("step.stop", { index: st.activeStepIndex, event_type: "step.stop" }));
  st.activeStepOpen = false;
  st.activeStepType = "";
};

const appendStepStart = (
  out: string[],
  st: State,
  stepType: string,
  step: Json | undefined,
): void => {
  const index = st.stepIndex;
  st.stepIndex++;
  st.activeStepIndex = index;
  st.activeStepType = stepType;
  st.activeStepOpen = true;
  const stepOut: JsonObject = { type: stepType };

  if (stepType === "function_call") {
    const id = firstNonEmpty(getStr(step, "call_id"), getStr(step, "id"));

    if (id !== "") {
      stepOut.id = id;
      stepOut.call_id = id;
    }

    stepOut.name = getStr(step, "name");
    stepOut.arguments = {};
  }

  out.push(ev("step.start", { index, step: stepOut, event_type: "step.start" }));
};

const ensureStep = (out: string[], st: State, modelName: string, stepType: string): void => {
  appendCreated(out, st, modelName, undefined);

  if (st.activeStepOpen && st.activeStepType === stepType) return;
  appendStepStop(out, st);
  appendStepStart(out, st, stepType, undefined);
};

const appendTextDelta = (out: string[], st: State, text: string, thought: boolean): void => {
  if (thought) {
    out.push(
      ev("step.delta", {
        index: st.activeStepIndex,
        delta: { content: { text, type: "text" }, type: "thought_summary" },
        event_type: "step.delta",
      }),
    );

    return;
  }

  out.push(
    ev("step.delta", {
      index: st.activeStepIndex,
      delta: { text, type: "text" },
      event_type: "step.delta",
    }),
  );
};

const appendArgumentsDelta = (out: string[], st: State, args: string): void => {
  out.push(
    ev("step.delta", {
      index: st.activeStepIndex,
      delta: { arguments: args, type: "arguments_delta" },
      event_type: "step.delta",
    }),
  );
};

const appendCompleted = (
  out: string[],
  st: State,
  modelName: string,
  response: Json | undefined,
): void => {
  if (st.completed) return;
  const now = nowRfc3339();

  const payload: JsonObject = {
    interaction: {
      id: st.id,
      status: "completed",
      usage: {},
      created: now,
      updated: now,
      service_tier: "standard",
      object: "interaction",
      model: responseModel(modelName, response),
    },
    event_type: "interaction.completed",
  };

  const status = getStr(response, "status");

  if (status !== "") set(payload, "interaction.status", status);
  setInteractionsUsageFromResponses(payload, "interaction.usage", get(response, "usage"));
  out.push(ev("interaction.completed", payload));
  st.completed = true;
};

const appendDone = (out: string[], st: State): void => {
  if (st.done) return;
  out.push(sseEvent("done", "[DONE]"));
  st.done = true;
};

const textKeys = (
  itemId: string,
  outputIndex: number,
  hasOutputIndex: boolean,
  contentIndex: number,
): string[] => {
  const keys: string[] = [];

  if (itemId !== "") keys.push(`item:${itemId}:content:${contentIndex}`);

  if (hasOutputIndex) keys.push(`output:${outputIndex}:content:${contentIndex}`);
  keys.push(`content:${contentIndex}`);

  return keys;
};

const unkeyedTextKeys = (
  itemId: string,
  outputIndex: number,
  hasOutputIndex: boolean,
): string[] => {
  const keys: string[] = [];

  if (itemId !== "") keys.push(`item:${itemId}`);

  if (hasOutputIndex) keys.push(`output:${outputIndex}`);

  return keys;
};

const textKeysFromEvent = (root: Json): string[] => {
  const itemId = getStr(root, "item_id");
  const outputIndexValue = get(root, "output_index");
  const outputIndex = asInt(outputIndexValue);
  const hasOutputIndex = outputIndexValue !== undefined;
  const contentIndexValue = get(root, "content_index");

  if (contentIndexValue === undefined) return unkeyedTextKeys(itemId, outputIndex, hasOutputIndex);

  return textKeys(itemId, outputIndex, hasOutputIndex, asInt(contentIndexValue));
};

const functionArgsKeysFromEvent = (root: Json): string[] => {
  const keys: string[] = [];

  for (const id of [
    getStr(root, "item_id"),
    getStr(root, "call_id"),
    getStr(root, "item.call_id"),
    getStr(root, "item.id"),
  ]) {
    if (id === "") continue;
    const key = `item:${id}`;

    if (!keys.includes(key)) keys.push(key);
  }

  const outputIndex = get(root, "output_index");

  if (outputIndex !== undefined) keys.push(`output:${asInt(outputIndex)}`);

  return keys;
};

const markTextSent = (st: State, keys: readonly string[]): void => {
  if (keys.length === 0) {
    st.unkeyedTextDelta = true;

    return;
  }

  for (const key of keys) st.sentText.add(key);
};

const hasSentText = (st: State, keys: readonly string[], hasContentIndex: boolean): boolean => {
  if (!hasContentIndex && st.unkeyedTextDelta) return true;

  return keys.some((key) => st.sentText.has(key));
};

const hasSentUnkeyedText = (st: State, keys: readonly string[]): boolean => {
  if (keys.length === 0) return st.unkeyedTextDelta;

  return keys.some((key) => st.sentText.has(key));
};

const ensureFunctionCallStep = (out: string[], st: State, modelName: string, root: Json): void => {
  if (st.activeStepOpen && st.activeStepType === "function_call") return;
  const item = get(root, "item") ?? root;
  let name = getStr(item, "name");

  if (isAntigravityModel(modelName)) name = antigravityToolNameToUpstream(name);
  const step: JsonObject = { type: "function_call", name, arguments: {} };

  const callId = firstNonEmpty(
    getStr(item, "call_id"),
    getStr(item, "id"),
    getStr(root, "call_id"),
    getStr(root, "item_id"),
  );

  if (callId !== "") {
    step.id = callId;
    step.call_id = callId;
  }

  appendCreated(out, st, modelName, undefined);
  appendStepStop(out, st);
  appendStepStart(out, st, "function_call", step);
};

/** `appendResponsesMessageFallbackToInteractions`. */
const appendMessageFallback = (
  out: string[],
  modelName: string,
  item: Json,
  root: Json,
  st: State,
  stop: boolean,
): void => {
  const itemId = getStr(item, "id");
  const outputIndexValue = get(root, "output_index");
  const outputIndex = asInt(outputIndexValue);
  const hasOutputIndex = outputIndexValue !== undefined;

  for (const [key, part] of eachEntry(get(item, "content"))) {
    const partType = getStr(part, "type");

    if (partType !== "output_text" && partType !== "text") continue;
    const contentIndex = asInt(key);
    const keys = textKeys(itemId, outputIndex, hasOutputIndex, contentIndex);
    const unkeyed = unkeyedTextKeys(itemId, outputIndex, hasOutputIndex);

    if (hasSentText(st, keys, true) || hasSentUnkeyedText(st, unkeyed)) continue;
    const text = getStr(part, "text");

    if (text === "") continue;
    ensureStep(out, st, modelName, "model_output");
    appendTextDelta(out, st, text, false);
    markTextSent(st, keys);
  }

  if (stop) appendStepStop(out, st);
};

const outputItemAdded = (modelName: string, root: Json, st: State): string[] => {
  const item = get(root, "item");
  const out: string[] = [];

  switch (getStr(item, "type")) {
    case "function_call": {
      appendCreated(out, st, modelName, undefined);
      appendStepStop(out, st);
      let name = getStr(item, "name");

      if (isAntigravityModel(modelName)) name = antigravityToolNameToUpstream(name);
      const step: JsonObject = { type: "function_call", name, arguments: {} };
      const callId = firstNonEmpty(getStr(item, "call_id"), getStr(item, "id"));

      if (callId !== "") {
        step.id = callId;
        step.call_id = callId;
      }

      appendStepStart(out, st, "function_call", step);

      return out;
    }

    case "message":
      ensureStep(out, st, modelName, "model_output");

      return out;
    case "reasoning":
      ensureStep(out, st, modelName, "thought");

      return out;
  }

  return [];
};

const outputItemDone = (modelName: string, root: Json, st: State): string[] => {
  const item = get(root, "item");
  const out: string[] = [];

  switch (getStr(item, "type")) {
    case "function_call": {
      ensureFunctionCallStep(out, st, modelName, root);
      const args = get(item, "arguments");

      if (args !== undefined && getStr(item, "arguments") !== "") {
        if (!functionArgsKeysFromEvent(root).some((key) => st.functionArgsSent.has(key))) {
          appendArgumentsDelta(out, st, jsonStringValue(args, "{}"));
        }
      }

      appendStepStop(out, st);

      return out;
    }

    case "reasoning": {
      ensureStep(out, st, modelName, "thought");
      const summary = get(item, "summary");

      for (const entry of isArr(summary) ? summary : []) {
        const text = getStr(entry, "text");

        if (text !== "") appendTextDelta(out, st, text, true);
      }

      appendStepStop(out, st);

      return out;
    }

    case "message":
      // SAFETY: the `message` case is only taken when getStr(item, "type") read "message" from `item`, so it exists.
      appendMessageFallback(out, modelName, item as Json, root, st, true);

      return out;
  }

  return [];
};

const completed = (modelName: string, response: Json | undefined, st: State): string[] => {
  const out: string[] = [];
  const output = get(response, "output");

  for (const [key, item] of eachEntry(output)) {
    if (getStr(item, "type") !== "message") continue;
    const root: JsonObject = { output_index: asInt(key) };
    const id = getStr(item, "id");

    if (id !== "") root.item_id = id;
    appendMessageFallback(out, modelName, item, root, st, false);
  }

  appendStepStop(out, st);
  appendCompleted(out, st, modelName, response);
  appendDone(out, st);

  return out;
};

const convertEvent = (modelName: string, rawLine: string, st: State): string[] => {
  const payload = ssePayloadOf(rawLine);

  if (payload === "") return [];

  if (payload.trim() === "[DONE]") {
    const out: string[] = [];
    appendDone(out, st);

    return out;
  }

  const root = parseJson(payload);

  if (root === undefined) return [];

  switch (getStr(root, "type")) {
    case "response.created": {
      const out: string[] = [];
      appendCreated(out, st, modelName, get(root, "response"));

      return out;
    }

    case "response.output_text.delta": {
      const out: string[] = [];
      ensureStep(out, st, modelName, "model_output");
      appendTextDelta(out, st, getStr(root, "delta"), false);
      markTextSent(st, textKeysFromEvent(root));

      return out;
    }

    case "response.reasoning_summary_text.delta": {
      const out: string[] = [];
      ensureStep(out, st, modelName, "thought");
      appendTextDelta(out, st, getStr(root, "delta"), true);

      return out;
    }

    case "response.output_item.added":
      return outputItemAdded(modelName, root, st);
    case "response.function_call_arguments.delta": {
      const out: string[] = [];
      ensureFunctionCallStep(out, st, modelName, root);
      appendArgumentsDelta(out, st, getStr(root, "delta"));

      for (const key of functionArgsKeysFromEvent(root)) st.functionArgsSent.add(key);

      return out;
    }

    case "response.output_item.done":
      return outputItemDone(modelName, root, st);
    case "response.completed":
    case "response.incomplete":
      return completed(modelName, get(root, "response"), st);
  }

  return [];
};

/** `openAIResponsesOutputItemToInteractionsStep`. */
const outputItemToStep = (item: Json, forAntigravity: boolean): JsonObject | undefined => {
  switch (getStr(item, "type")) {
    case "message": {
      const content: Json[] = [];
      const parts = get(item, "content");

      for (const [, part] of eachEntry(parts)) {
        const converted = responsesContentPartToInteractions(part);

        if (converted !== undefined) content.push(converted);
      }

      return { type: "model_output", content };
    }

    case "function_call":
      return responsesFunctionCallToInteractions(item, forAntigravity);
    case "reasoning": {
      const content: Json[] = [];

      for (const [, summary] of eachEntry(get(item, "summary"))) {
        const text = getStr(summary, "text");

        if (text !== "") content.push({ type: "text", text });
      }

      return { type: "thought", content };
    }
  }

  return undefined;
};

const stateOf = (context: ResponseContext): State => {
  if (context.state.value === undefined) context.state.value = newState();

  // SAFETY: this translator is the only writer of `state.value` and initialises it to a State before this read.
  return context.state.value as State;
};

/** Non-stream body: a Responses object -> an Interactions object. */
const convertNonStream = (context: ResponseContext, body: string): string | undefined => {
  const root = parseJson(body);

  const out: JsonObject = {
    id: "",
    object: "interaction",
    status: "completed",
    model: "",
    steps: [],
  };

  const status = getStr(root, "status");

  if (status !== "") out.status = status;
  out.id = getStr(root, "id");
  out.model = responseModel(context.model, root);
  const forAntigravity = isAntigravityModel(context.model);
  const steps: Json[] = [];

  for (const [, item] of eachEntry(get(root, "output"))) {
    const step = outputItemToStep(item, forAntigravity);

    if (step !== undefined) steps.push(step);
  }

  if (steps.length > 0) out.steps = steps;
  setInteractionsUsageFromResponses(out, "usage", get(root, "usage"));

  return JSON.stringify(out);
};

/** Responses upstream -> Interactions client (registered for `(Interactions, OpenAIResponse)`). */
export const openAIResponsesToInteractionsResponse: ResponseTransform = {
  stream: (context, line) => convertEvent(context.model, line, stateOf(context)),
  nonStream: convertNonStream,
};
