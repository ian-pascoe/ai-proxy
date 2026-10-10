/**
 * Converts a complete Claude Messages JSON body into the SSE event text that the streaming translators consume.
 *
 * Go source: internal/translator/common/claude_native_response.go. Go marshals the events through `map[string]any`,
 * so event keys are sorted; the literals below keep that order.
 */
import { cloneJson, get, type Json, type JsonObject, tryParseJson } from "../../json/index.ts";
import { isArr, isObj, str, toArray } from "./gjson.ts";

/** `ClaudeMessagesJSONToSSE`: returns the input unchanged (empty model) when it is not a Messages body. */
export const claudeMessagesJSONToSSE = (raw: string): readonly [string, string] => {
  const root = tryParseJson(raw);

  if (root === undefined || str(get(root, "type")) !== "message" || !isArr(get(root, "content")))
    return [raw, ""];
  let out = "";

  const emit = (event: JsonObject): void => {
    out += `data: ${JSON.stringify(event)}\n\n`;
  };

  const message = cloneJson(root as JsonObject);
  message.content = [];
  message.stop_reason = null;
  message.stop_sequence = null;
  emit({ message, type: "message_start" });

  toArray(get(root, "content")).forEach((block, index) => {
    const start = cloneJson(block) as JsonObject;
    let delta: JsonObject | undefined;
    const blockType = str(get(block, "type"));

    switch (blockType) {
      case "text":
        start.text = "";
        delta = { text: str(get(block, "text")), type: "text_delta" };
        break;
      case "tool_use": {
        start.input = {};
        const input = get(block, "input");
        delta = {
          partial_json: input === undefined ? "{}" : JSON.stringify(input),
          type: "input_json_delta",
        };
        break;
      }

      case "thinking":
        start.thinking = "";
        start.signature = "";
        delta = { thinking: str(get(block, "thinking")), type: "thinking_delta" };
        break;
    }

    emit({ content_block: start, index, type: "content_block_start" });

    if (delta !== undefined) emit({ delta, index, type: "content_block_delta" });

    if (blockType === "text") {
      for (const citation of toArray(get(block, "citations"))) {
        emit({ delta: { citation, type: "citations_delta" }, index, type: "content_block_delta" });
      }
    }

    if (blockType === "thinking" && get(block, "signature") !== undefined) {
      emit({
        delta: { signature: str(get(block, "signature")), type: "signature_delta" },
        index,
        type: "content_block_delta",
      });
    }

    emit({ index, type: "content_block_stop" });
  });
  const usage = get(root, "usage");
  const stopReason = get(root, "stop_reason");
  const stopSequence = get(root, "stop_sequence");
  emit({
    delta: {
      stop_reason: (stopReason ?? null) as Json,
      stop_sequence: (stopSequence ?? null) as Json,
    },
    type: "message_delta",
    usage: isObj(usage) || isArr(usage) ? usage : {},
  });
  emit({ type: "message_stop" });

  return [out, str(get(root, "model"))];
};
