/**
 * Go source: internal/translator/common/openai_tools.go (AlignOpenAIToolCallMessages).
 *
 * Reorders tool result messages so they immediately follow the assistant message that issued the matching
 * `tool_calls`; ambiguous, orphan and incomplete histories are left untouched.
 */
import { get, type Json } from "../../../json/index.ts";
import { getStr, isArr } from "./read.ts";

interface AssistantRecord {
  readonly msgIndex: number;
  readonly callIds: string[];
  readonly hasInvalidOrEmptyId: boolean;
}

export const alignOpenAIToolCallMessages = (
  messages: Json[],
  extraAmbiguousIds: readonly string[] = [],
): Json[] => {
  if (messages.length <= 1) return messages;

  const assistants: AssistantRecord[] = [];
  const assistantByCallId = new Map<string, number>();
  const ambiguous = new Set<string>();

  for (const id of extraAmbiguousIds) {
    const t = id.trim();

    if (t !== "") ambiguous.add(t);
  }

  const toolMsgIndices = new Map<string, number[]>();

  messages.forEach((message, i) => {
    const role = getStr(message, "role");

    if (role === "assistant") {
      const toolCalls = get(message, "tool_calls");

      if (isArr(toolCalls) && toolCalls.length > 0) {
        const callIds: string[] = [];
        let hasEmpty = false;

        for (const tc of toolCalls) {
          const callId = getStr(tc, "id");

          if (callId === "") {
            ambiguous.add("");
            hasEmpty = true;
            continue;
          }

          if (assistantByCallId.has(callId)) ambiguous.add(callId);
          assistantByCallId.set(callId, i);
          callIds.push(callId);
        }

        if (callIds.length > 0 || hasEmpty)
          assistants.push({ msgIndex: i, callIds, hasInvalidOrEmptyId: hasEmpty });
      }
    } else if (role === "tool") {
      const callId = getStr(message, "tool_call_id");

      if (callId === "") {
        ambiguous.add("");
      } else {
        const list = toolMsgIndices.get(callId) ?? [];
        list.push(i);
        toolMsgIndices.set(callId, list);

        if (list.length > 1) ambiguous.add(callId);
      }
    }
  });

  if (assistants.length === 0) return messages;

  const groups: Array<{ assistantIndex: number; toolIndices: number[] }> = [];
  let needsReorder = false;

  for (const ast of assistants) {
    if (ast.hasInvalidOrEmptyId) continue;
    let eligible = true;
    const matched: number[] = [];

    for (const callId of ast.callIds) {
      if (ambiguous.has(callId)) {
        eligible = false;
        break;
      }

      const indices = toolMsgIndices.get(callId) ?? [];

      if (indices.length !== 1) {
        eligible = false;
        break;
      }

      // SAFETY: the check above `continue`s unless indices.length === 1.
      const toolIdx = indices[0] as number;

      if (toolIdx <= ast.msgIndex) {
        eligible = false;
        break;
      }

      matched.push(toolIdx);
    }

    if (!eligible) continue;
    matched.sort((a, b) => a - b);

    const alreadyAdjacent = matched.every(
      (toolIdx, offset) => toolIdx === ast.msgIndex + offset + 1,
    );

    if (!alreadyAdjacent) {
      needsReorder = true;
      groups.push({ assistantIndex: ast.msgIndex, toolIndices: matched });
    }
  }

  if (!needsReorder) return messages;

  const moved = new Set<number>();
  const toInsert = new Map<number, Json[]>();

  for (const g of groups) {
    const list: Json[] = [];

    for (const idx of g.toolIndices) {
      moved.add(idx);
      // SAFETY: toolIndices only holds positions recorded while scanning `messages`.
      list.push(messages[idx] as Json);
    }

    toInsert.set(g.assistantIndex, list);
  }

  const reordered: Json[] = [];
  messages.forEach((message, i) => {
    if (moved.has(i)) return;
    reordered.push(message);
    const tools = toInsert.get(i);

    if (tools !== undefined) reordered.push(...tools);
  });

  return reordered;
};
