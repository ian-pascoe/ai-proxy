/**
 * Responses `shell` tool bridge: item builders and argument validation.
 *
 * Go source: internal/translator/openai/openai/responses/shell_tool.go (shellCallItem, shellCallPlaceholder,
 * responsesToolInputFailure).
 */
import {
  asFloat,
  get,
  isJsonObject,
  type Json,
  type JsonObject,
  set,
} from "../../../../json/index.ts";
import { applyPatchFailure } from "../../../common/apply-patch.ts";
import { isArr } from "../../common/read.ts";

export const INVALID_SHELL_ACTION_MESSAGE =
  "invalid shell action: expected nonempty commands strings and optional positive integer limits";

export const shellCallPlaceholder = (callId: string): JsonObject => ({
  id: `sh_${callId}`,
  type: "shell_call",
  status: "in_progress",
  call_id: callId,
  action: { commands: [] },
});

/** `shellCallItem`: validates the function arguments as a shell action; returns the item or an error message. */
export const shellCallItem = (
  callId: string,
  argumentsText: string,
  status: string,
): { readonly item: JsonObject } | { readonly error: string } => {
  let action: Json;

  try {
    action = JSON.parse(argumentsText);
  } catch {
    return { error: INVALID_SHELL_ACTION_MESSAGE };
  }

  if (!isJsonObject(action)) return { error: INVALID_SHELL_ACTION_MESSAGE };
  const commands = get(action, "commands");

  if (!isArr(commands) || commands.length === 0) return { error: INVALID_SHELL_ACTION_MESSAGE };

  for (const command of commands) {
    if (typeof command !== "string" || command.trim() === "")
      return { error: INVALID_SHELL_ACTION_MESSAGE };
  }

  for (const [key, value] of Object.entries(action)) {
    if (key === "commands") continue;

    if (key === "timeout_ms" || key === "max_output_length") {
      if (
        value !== null &&
        (typeof value !== "number" || asFloat(value) <= 0 || Math.trunc(value) !== value)
      ) {
        return { error: INVALID_SHELL_ACTION_MESSAGE };
      }

      continue;
    }

    return { error: INVALID_SHELL_ACTION_MESSAGE };
  }

  const item = shellCallPlaceholder(callId);
  item.status = status;
  item.action = action;

  return { item };
};

/** `responsesToolInputFailure`. */
export const responsesToolInputFailure = (
  responseId: string,
  sequence: number,
  error: string,
): Json => {
  const failure = applyPatchFailure(responseId, sequence);

  if (error === INVALID_SHELL_ACTION_MESSAGE)
    set(failure, "response.error.message", INVALID_SHELL_ACTION_MESSAGE);

  return failure;
};
