/**
 * Claude message helpers shared by non-Claude targets.
 *
 * Go source: internal/translator/common/claude_system.go, claude_messages.go (ClaudeMessageAccumulator), (SystemReminderText, ClaudeMessageSystemReminderText),
 * internal/translator/common/claude_messages.go (AlignClaudeToolResults), internal/util/claude_attribution.go
 * (IsClaudeCodeAttributionSystemText).
 */
import {
  asString,
  get,
  isJsonArray,
  isJsonObject,
  type Json,
  type JsonObject,
} from "../../json/index.ts";

const ATTRIBUTION_PREFIX = "x-anthropic-billing-header:";

/** Go `strings.TrimLeftFunc(text, unicode.IsSpace)` + prefix test. */
export const isClaudeCodeAttributionSystemText = (text: string): boolean =>
  text.trimStart().startsWith(ATTRIBUTION_PREFIX);

/** `SystemReminderText`: wraps text in the `<system-reminder>` envelope. */
export const systemReminderText = (text: string): string =>
  `<system-reminder>\n${text}\n</system-reminder>`;

const claudeSystemTextParts = (content: Json | undefined): string[] => {
  if (content === undefined) return [];

  if (typeof content === "string") {
    return content === "" || isClaudeCodeAttributionSystemText(content) ? [] : [content];
  }

  if (!isJsonArray(content)) return [];
  const parts: string[] = [];

  for (const item of content) {
    if (asString(get(item, "type")) !== "text") continue;
    const text = asString(get(item, "text"));

    if (text === "" || isClaudeCodeAttributionSystemText(text)) continue;
    parts.push(text);
  }

  return parts;
};

/** `ClaudeMessageSystemReminderText`: a message-level system value as reminder text, if it has any. */
export const claudeMessageSystemReminderText = (content: Json | undefined): string | undefined => {
  const parts = claudeSystemTextParts(content);

  if (parts.length === 0) return undefined;
  const text = parts.join("\n");

  return text.trim() === "" ? undefined : systemReminderText(text);
};

const claudeMessageContentParts = (content: Json | undefined): JsonObject[] => {
  if (content === undefined || content === null) return [];

  if (typeof content === "string") return content === "" ? [] : [{ type: "text", text: content }];

  if (!isJsonArray(content)) return [];

  return content.filter(isJsonObject);
};

/** Merges consecutive same-role messages; assistant `tool_use` blocks move behind the other content. */
export class ClaudeMessageAccumulator {
  readonly #messages: JsonObject[] = [];
  #role = "";
  #content: JsonObject[] = [];
  #toolUseParts: JsonObject[] = [];

  append(message: JsonObject | undefined): void {
    if (message === undefined) return;
    const role = asString(message.role);

    if (role !== "user" && role !== "assistant") return;
    const parts = claudeMessageContentParts(message.content);

    if (parts.length === 0) return;

    if (this.#role !== "" && this.#role !== role) this.flush();
    this.#role = role;

    for (const part of parts) {
      if (role === "assistant" && asString(part.type) === "tool_use") {
        this.#toolUseParts.push(part);
        continue;
      }

      this.#content.push(part);
    }
  }

  flush(): void {
    if (this.#role === "") return;

    const parts =
      this.#toolUseParts.length > 0 ? [...this.#content, ...this.#toolUseParts] : this.#content;

    if (parts.length > 0) this.#messages.push({ role: this.#role, content: parts });
    this.#role = "";
    this.#content = [];
    this.#toolUseParts = [];
  }

  messages(): JsonObject[] {
    this.flush();

    return this.#messages;
  }
}

/**
 * `AlignClaudeToolResults`: orders `tool_result` blocks by the preceding `tool_use` ids, keeping other blocks at
 * their indexes. Without a complete one-to-one match (or when `content` is not an array) the original content is
 * returned.
 */
export function alignClaudeToolResults(content: Json[], toolUseIds: readonly string[]): Json[];
export function alignClaudeToolResults(
  content: Json | undefined,
  toolUseIds: readonly string[],
): Json | undefined;
export function alignClaudeToolResults(
  content: Json | undefined,
  toolUseIds: readonly string[],
): Json | undefined {
  if (!isJsonArray(content) || toolUseIds.length === 0) return content;
  const results: Json[] = [];
  const indices: number[] = [];
  content.forEach((part, index) => {
    if (asString(get(part, "type")) === "tool_result") {
      results.push(part);
      indices.push(index);
    }
  });

  if (results.length !== toolUseIds.length) return content;
  const reordered: Json[] = [];
  const used = results.map(() => false);

  for (const toolUseId of toolUseIds) {
    const matched = results.findIndex(
      (result, i) =>
        !used[i] && toolUseId !== "" && asString(get(result, "tool_use_id")) === toolUseId,
    );

    if (matched < 0) return content;
    used[matched] = true;
    // SAFETY: `matched >= 0` was checked above and indexes into `results`.
    reordered.push(results[matched] as Json);
  }

  const ordered = [...content];
  indices.forEach((slot, i) => {
    // SAFETY: `reordered` was built with one entry per index in `indices`, so i is in range.
    ordered[slot] = reordered[i] as Json;
  });

  return ordered;
}
