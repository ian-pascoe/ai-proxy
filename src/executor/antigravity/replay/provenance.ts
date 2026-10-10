/**
 * Repairs around reasoning replay: reserved Claude-facing tool ids that the ledger could not resolve, first function
 * calls left unsigned, and the Gemini function call pairing check.
 *
 * Go source: internal/runtime/executor/antigravity_reasoning_replay.go (`antigravityPayloadHasClaudeToolProvenanceID`,
 * `antigravitySyntheticToolCallID`, `degradeAntigravityClaudeToolProvenanceIDs`,
 * `antigravityRepairUnsignedFirstFunctionCalls`) and internal/signature/gemini_validation.go
 * (`ValidateGeminiFunctionCallPairing`).
 */
import { createHash } from "node:crypto";
import { asString, get, isJsonArray, isJsonObject, type Json, del } from "../../../json/index.ts";
import { isGeminiClaudeToolUseID } from "../../../translator/common/claude-util.ts";
import { isModelRole, nativePartThoughtSignature, SKIP_VALIDATOR } from "./request-index.ts";

const contentsOf = (payload: Json): Json[] => {
  const contents = get(payload, "request.contents");

  return isJsonArray(contents) ? contents : [];
};

/** `antigravityPayloadHasClaudeToolProvenanceID`. */
export const payloadHasToolProvenanceId = (payload: Json): boolean => {
  const reserved = (part: Json): boolean =>
    ["functionCall.id", "functionResponse.id"].some((path) =>
      isGeminiClaudeToolUseID(asString(get(part, path))),
    );

  for (const content of contentsOf(payload)) {
    const parts = get(content, "parts");

    if (isJsonArray(parts)) {
      if (parts.some(reserved)) return true;
    } else if (parts !== undefined && parts !== null && reserved(parts)) {
      return true;
    }
  }

  return false;
};

/** `antigravitySyntheticToolCallID`: a stable neutral id outside the reserved namespace. */
export const syntheticToolCallId = (reservedId: string): string =>
  `call_${createHash("sha256").update(`antigravity-degraded-tool-call\u0000${reservedId}`).digest("hex").slice(0, 12)}`;

/**
 * `degradeAntigravityClaudeToolProvenanceIDs`: rewrites unresolved reserved ids to synthetic ones (the same reserved
 * id always maps to the same synthetic id, so calls and responses stay paired); stale signatures on degraded calls
 * become the bypass sentinel (first call of a turn) or are dropped. Mutates `payload`; returns the rewritten count.
 */
export const degradeToolProvenanceIds = (payload: Json): number => {
  let count = 0;

  for (const content of contentsOf(payload)) {
    const parts = get(content, "parts");

    if (!isJsonArray(parts)) continue;
    let seenFunctionCall = false;

    for (const part of parts) {
      const call = get(part, "functionCall");

      if (call !== undefined) {
        const isFirst = !seenFunctionCall;
        seenFunctionCall = true;
        const id = asString(get(call, "id")).trim();

        if (!isGeminiClaudeToolUseID(id) || !isJsonObject(part) || !isJsonObject(call)) continue;
        call["id"] = syntheticToolCallId(id);

        if (asString(part["thoughtSignature"]) !== "") {
          if (isFirst) part["thoughtSignature"] = SKIP_VALIDATOR;
          else del(part, "thoughtSignature");
        }

        count++;
        continue;
      }

      const response = get(part, "functionResponse");

      if (response === undefined) continue;
      const id = asString(get(response, "id")).trim();

      if (!isGeminiClaudeToolUseID(id) || !isJsonObject(response)) continue;
      response["id"] = syntheticToolCallId(id);
      count++;
    }
  }

  return count;
};

/**
 * `antigravityRepairUnsignedFirstFunctionCalls`: Gemini rejects a model turn whose first function call carries no
 * signature; only a missing signature is filled in (with the bypass sentinel), native ones are never touched.
 */
export const repairUnsignedFirstFunctionCalls = (payload: Json): void => {
  for (const content of contentsOf(payload)) {
    if (!isModelRole(content)) continue;
    const parts = get(content, "parts");

    if (!isJsonArray(parts)) continue;

    for (const part of parts) {
      if (get(part, "functionCall") === undefined) continue;

      if (nativePartThoughtSignature(part) === "" && isJsonObject(part))
        part["thoughtSignature"] = SKIP_VALIDATOR;
      break;
    }
  }
};

interface CallRef {
  readonly id: string;
  readonly name: string;
  readonly path: string;
}

/** `ValidateGeminiFunctionCallPairing`: the error message, or undefined when the history is well formed. */
export const validateFunctionCallPairing = (payload: Json): string | undefined => {
  const top = get(payload, "contents");
  const contentsPath = top !== undefined ? "contents" : "request.contents";
  const contents = top ?? get(payload, "request.contents");

  if (!isJsonArray(contents)) return undefined;
  let pending: CallRef[] = [];

  for (let i = 0; i < contents.length; i++) {
    const content = contents[i] as Json;
    const parts = get(content, "parts");

    if (!isJsonArray(parts) || parts.length === 0) {
      if (pending.length > 0) {
        return `${contentsPath}[${i}]: content appears before ${pending.length} pending functionResponse part(s)`;
      }

      continue;
    }

    const calls: CallRef[] = [];
    const responses: Array<{ part: Json; path: string }> = [];

    for (let j = 0; j < parts.length; j++) {
      const part = parts[j] as Json;
      const partPath = `${contentsPath}[${i}].parts[${j}]`;
      const call = get(part, "functionCall");

      if (call !== undefined) {
        if (asString(get(call, "name")) === "") return `${partPath}: missing functionCall.name`;
        calls.push({
          id: asString(get(call, "id")),
          name: asString(get(call, "name")),
          path: partPath,
        });
      }

      if (get(part, "functionResponse") !== undefined) responses.push({ part, path: partPath });
    }

    if (calls.length > 0 && responses.length > 0) {
      return `${contentsPath}[${i}]: functionCall and functionResponse parts must not be interleaved in the same content`;
    }

    if (calls.length > 0 && pending.length > 0) {
      return `${contentsPath}[${i}]: functionCall appears before ${pending.length} pending functionResponse part(s)`;
    }

    if (calls.length > 0) {
      pending = calls;
      continue;
    }

    if (responses.length === 0 && pending.length > 0) {
      // Intervening user content may precede the pending functionResponse turn; a model turn breaks turn ownership.
      if (asString(get(content, "role")).trim().toLowerCase() === "model") {
        return `${contentsPath}[${i}]: model content appears before ${pending.length} pending functionResponse part(s)`;
      }

      continue;
    }

    if (responses.length === 0) continue;

    if (pending.length === 0)
      return `${contentsPath}[${i}]: functionResponse without preceding functionCall`;

    if (responses.length !== pending.length) {
      return `${contentsPath}[${i}]: functionResponse count ${responses.length} does not match pending functionCall count ${pending.length}`;
    }

    for (let k = 0; k < responses.length; k++) {
      const { part, path } = responses[k] as { part: Json; path: string };
      const response = get(part, "functionResponse");
      const call = pending[k] as CallRef;
      const responseId = asString(get(response, "id"));
      const responseName = asString(get(response, "name"));

      if (call.id !== "" && responseId === "")
        return `${path}: missing functionResponse.id for ${call.path}`;

      if (call.id !== "" && responseId !== call.id) {
        return `${path}: functionResponse.id ${JSON.stringify(responseId)} does not match functionCall.id ${JSON.stringify(call.id)} at ${call.path}`;
      }

      if (responseName === "") return `${path}: missing functionResponse.name`;

      if (call.name !== "" && responseName !== call.name) {
        return `${path}: functionResponse.name ${JSON.stringify(responseName)} does not match functionCall.name ${JSON.stringify(call.name)} at ${call.path}`;
      }
    }

    pending = [];
  }

  return undefined;
};
