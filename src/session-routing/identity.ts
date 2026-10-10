/**
 * Session identities that need no client marker: the derived content-hash identity and the message-hash fallback.
 *
 * Go source: sdk/cliproxy/session/identity.go (`DeriveID`, `hasExplicitSession`, `NormalizeToCanonicalUUID`,
 * `CandidateSessionPrefixes`), info.go (`BoundSessionIdentity`) and sdk/cliproxy/auth/selector.go
 * (`extractMessageHashIDs`, `computeSessionHash`). Docs: credentials.md §6.9.
 */
import { createHash } from "node:crypto";
import { claudeMetadataIdentities, normalizeExplicitId, requestRoot } from "../handlers/session.ts";
import {
  asString,
  get,
  isJsonArray,
  isJsonObject,
  type Json,
  type JsonObject,
} from "../json/index.ts";
import { forEachValue, goTrimSpace, prop } from "./canonical.ts";
import { goMarshal } from "./go-json.ts";

const encoder = new TextEncoder();

/** `BoundSessionIdentity`: identities over 256 bytes are shortened to a valid-UTF-8 prefix plus a SHA-256 digest. */
export const boundSessionIdentity = (id: string): string => {
  const bytes = encoder.encode(id);

  if (bytes.length <= 256) return id;
  const hex = createHash("sha256").update(bytes).digest("hex");
  const prefixLength = Math.min(255 - 1 - hex.length, bytes.length);
  let end = prefixLength;

  // Do not split a multi-byte character: back up to a character boundary (continuation bytes are 10xxxxxx).
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;

  return `${new TextDecoder().decode(bytes.subarray(0, end))}#${hex}`;
};

const KNOWN_PREFIXES = [
  "lcp:v1:",
  "lcp:",
  "ctx:v1:",
  "ctx:",
  "codex:",
  "claude:",
  "header:",
  "session:",
  "affinity:",
  "slot:",
  "task:",
  "conv:",
  "thread:",
  "clientreq:",
  "geminicache:",
  "pck:",
  "user:",
  "execution:",
  "agy:",
  "derived:",
];

const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * `NormalizeToCanonicalUUID`: any session identifier as a lowercase UUID (UUIDs keep their value, everything else
 * is projected to an RFC 9562 UUIDv8 with SHA-256 and domain separation). Idempotent.
 */
export const normalizeToCanonicalUuid = (rawId: string): string => {
  let clean = goTrimSpace(rawId);

  if (clean === "") return "";

  if (UUID_PATTERN.test(clean)) return clean.toLowerCase();

  for (;;) {
    const prefix = KNOWN_PREFIXES.find((candidate) => clean.startsWith(candidate));

    if (prefix === undefined) break;
    clean = goTrimSpace(clean.slice(prefix.length));
  }

  if (clean === "") return "";

  if (UUID_PATTERN.test(clean)) return clean.toLowerCase();
  const colon = clean.indexOf(":");

  if (colon > 0) {
    const candidate = goTrimSpace(clean.slice(colon + 1));

    if (UUID_PATTERN.test(candidate)) return candidate.toLowerCase();
  }

  const sum = createHash("sha256").update(`cpa:canonical-uuid:v1\0${clean}`).digest();
  sum[6] = ((sum[6] as number) & 0x0f) | 0x80;
  sum[8] = ((sum[8] as number) & 0x3f) | 0x80;
  const hex = sum.subarray(0, 16).toString("hex");

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
};

// --- hasExplicitSession --------------------------------------------------------------------------------------

const EXPLICIT_HEADERS = [
  "X-Claude-Code-Session-Id",
  "X-Claude-Code-Agent-Id",
  "X-Claude-Code-Parent-Agent-Id",
  "Session-Id",
  "Session_id",
  "X-Codex-Parent-Thread-Id",
  "X-Codex-Turn-Metadata",
  "X-Openai-Subagent",
  "X-Http-Session-Id",
  "X-Session-ID",
  "X-Session-Affinity",
  "X-Parent-Session-ID",
  "X-Parent-Session-Affinity",
  "X-Parent-ID",
  "X-Slot-Session-Id",
  "X-Parent-Slot-Session-Id",
  "X-Task-ID",
  "X-Parent-Task-ID",
  "X-Conversation-Id",
  "X-Parent-Conversation-Id",
  "X-Thread-Id",
  "X-Parent-Thread-Id",
  "Thread-Id",
  "X-Client-Request-Id",
];

const EXPLICIT_PATHS = [
  "session_id",
  "sessionId",
  "sessionID",
  "child_session_id",
  "childSessionId",
  "task_id",
  "taskId",
  "taskID",
  "action_id",
  "actionId",
  "cachedContent",
  "cached_content",
  "thread_id",
  "threadId",
  "conversation_id",
  "conversationId",
  "chat_id",
  "chatId",
  "prompt_cache_key",
  "promptCacheKey",
  "parent_session_id",
  "parentSessionId",
  "parent_thread_id",
  "parentThreadId",
  "parent_id",
  "parentId",
  "parentID",
  "parent_task_id",
  "parentTaskId",
  "parent_action_id",
  "parentActionId",
  "parent_session",
  "parentSession",
  "parent_subagent_id",
  "forkSource.sessionId",
  "previousSessionId",
  "forked_from_thread_id",
  "forked_from_id",
  "metadata.session_id",
  "metadata.sessionId",
  "metadata.task_id",
  "metadata.taskId",
  "metadata.thread_id",
  "metadata.conversation_id",
  "metadata.parent_id",
  "metadata.parent_task_id",
  "metadata.parent_agent_id",
  "extra_body.session_id",
  "extra_body.task_id",
  "extra_body.parent_id",
  "extra_body.parent_task_id",
];

/** `hasExplicitSession`: any client-provided session marker (headers or body fields). */
export const hasExplicitSession = (headers: Headers, body: Json | undefined): boolean => {
  for (const name of EXPLICIT_HEADERS) {
    if (normalizeExplicitId(headers.get(name) ?? undefined) !== "") return true;
  }

  if (body === undefined) return false;
  const { root, nested } = requestRoot(body);

  for (const path of EXPLICIT_PATHS) {
    if (normalizeExplicitId(asString(get(root, path))) !== "") return true;

    if (nested !== undefined && normalizeExplicitId(asString(get(nested, path))) !== "")
      return true;
  }

  if (claudeMetadataIdentities(body).sessionId !== "") return true;
  let userId = asString(get(root, "metadata.user_id")).trim();

  if (userId === "" && nested !== undefined)
    userId = asString(get(nested, "metadata.user_id")).trim();

  if (normalizeExplicitId(userId) !== "") return true;
  let conversation = get(root, "conversation");

  if (conversation === undefined && nested !== undefined)
    conversation = get(nested, "conversation");

  if (normalizeExplicitId(asString(get(conversation, "id"))) !== "") return true;

  return typeof conversation === "string" && normalizeExplicitId(conversation) !== "";
};

// --- DeriveID ------------------------------------------------------------------------------------------------

interface DerivedPart {
  readonly kind: string;
  readonly mime: string;
  readonly value: string;
}

const normalizedString = (value: Json | undefined): string =>
  typeof value === "string" ? goTrimSpace(value).toLowerCase() : "";

const stringField = (object: JsonObject, ...keys: string[]): string => {
  for (const key of keys) {
    if (Object.hasOwn(object, key)) {
      const value = object[key];

      return typeof value === "string" ? goTrimSpace(value) : "";
    }
  }

  return "";
};

const firstField = (
  object: JsonObject,
  ...keys: string[]
): { readonly value: Json } | undefined => {
  for (const key of keys) if (Object.hasOwn(object, key)) return { value: object[key] as Json };

  return undefined;
};

const stripCacheControl = (value: Json): Json => {
  if (isJsonArray(value)) return value.map(stripCacheControl);

  if (isJsonObject(value)) {
    const out: JsonObject = {};

    for (const [key, child] of Object.entries(value)) {
      if (goTrimSpace(key).toLowerCase() === "cache_control") continue;
      out[key] = stripCacheControl(child);
    }

    return out;
  }

  return value;
};

const appendMediaPart = (
  parts: DerivedPart[],
  kindInput: string,
  value: Json,
  fallbackMime: string,
): void => {
  const kind = goTrimSpace(kindInput) === "" ? "media" : goTrimSpace(kindInput);

  if (typeof value === "string") {
    if (value !== "") parts.push({ kind, mime: fallbackMime, value });
  } else if (isJsonObject(value)) {
    const mime = stringField(value, "mimeType", "mime_type", "media_type") || fallbackMime;
    const mediaValue = stringField(value, "url", "uri", "fileUri", "file_uri", "data");

    if (mediaValue !== "") parts.push({ kind, mime, value: mediaValue });
  } else {
    appendParts(parts, value);
  }
};

const appendParts = (parts: DerivedPart[], value: Json | undefined): void => {
  if (value === undefined || value === null) return;

  if (typeof value === "string") {
    if (value !== "") parts.push({ kind: "text", mime: "", value });

    return;
  }

  if (isJsonArray(value)) {
    for (const child of value) appendParts(parts, child);

    return;
  }

  if (!isJsonObject(value)) {
    parts.push({ kind: "json", mime: "", value: goMarshal(value) });

    return;
  }

  const text = prop(value, "text");

  if (typeof text === "string") return appendParts(parts, text);

  if (Object.hasOwn(value, "content")) return appendParts(parts, value["content"]);

  if (Object.hasOwn(value, "parts")) return appendParts(parts, value["parts"]);

  if (Object.hasOwn(value, "image_url"))
    return appendMediaPart(parts, "image", value["image_url"] as Json, "");
  const inline = firstField(value, "inlineData", "inline_data");

  if (inline !== undefined) return appendMediaPart(parts, "inline_data", inline.value, "");
  const file = firstField(value, "fileData", "file_data");

  if (file !== undefined) return appendMediaPart(parts, "file", file.value, "");

  if (Object.hasOwn(value, "source")) {
    return appendMediaPart(
      parts,
      normalizedString(value["type"]),
      value["source"] as Json,
      normalizedString(value["media_type"]),
    );
  }

  parts.push({ kind: "json", mime: "", value: goMarshal(stripCacheControl(value)) });
};

const canonicalParts = (value: Json | undefined): DerivedPart[] => {
  const parts: DerivedPart[] = [];
  appendParts(parts, value);

  return parts;
};

const truncateRunes = (value: string, limit: number): string => {
  const runes = Array.from(value);

  return runes.length <= limit ? value : runes.slice(0, limit).join("");
};

const appendInstruction = (instructions: string[], value: Json | undefined): void => {
  const text = canonicalParts(value)
    .filter((part) => part.kind === "text" && part.value !== "")
    .map((part) => part.value)
    .join("\n");

  if (text !== "") instructions.push(truncateRunes(text, 50));
};

const contentValue = (value: Json | undefined): Json | undefined => {
  if (!isJsonObject(value)) return value;

  if (Object.hasOwn(value, "content")) return value["content"];

  if (Object.hasOwn(value, "parts")) return value["parts"];

  if (Object.hasOwn(value, "text")) return value["text"];

  return value;
};

interface Root {
  readonly instructions: string[];
  readonly user: DerivedPart[];
}

const messagesRoot = (body: JsonObject, includeTopLevelSystem: boolean): Root => {
  const instructions: string[] = [];

  if (includeTopLevelSystem && Object.hasOwn(body, "system"))
    appendInstruction(instructions, body["system"]);
  const messages = body["messages"];

  for (const message of isJsonArray(messages) ? messages : []) {
    if (!isJsonObject(message)) continue;
    const role = normalizedString(message["role"]);

    if (role === "system" || role === "developer")
      appendInstruction(instructions, message["content"]);
    else if (role === "user") {
      const parts = canonicalParts(message["content"]);

      if (parts.length > 0) return { instructions, user: parts };
    }
  }

  return { instructions, user: [] };
};

const responsesRoot = (body: JsonObject): Root => {
  const instructions: string[] = [];

  if (Object.hasOwn(body, "instructions")) appendInstruction(instructions, body["instructions"]);

  if (!Object.hasOwn(body, "input")) return { instructions, user: [] };
  const input = body["input"];

  if (typeof input === "string") return { instructions, user: canonicalParts(input) };

  for (const item of isJsonArray(input) ? input : []) {
    if (!isJsonObject(item)) continue;
    const role = normalizedString(item["role"]);

    if (role === "system" || role === "developer") appendInstruction(instructions, item["content"]);
    else if (role === "user") {
      const parts = canonicalParts(item["content"]);

      if (parts.length > 0) return { instructions, user: parts };
    }
  }

  return { instructions, user: [] };
};

const geminiRoot = (bodyInput: JsonObject): Root => {
  const request = bodyInput["request"];
  const body = isJsonObject(request) ? request : bodyInput;
  const instructions: string[] = [];
  const system = firstField(body, "systemInstruction", "system_instruction");

  if (system !== undefined) appendInstruction(instructions, contentValue(system.value));
  const contents = body["contents"];

  for (const content of isJsonArray(contents) ? contents : []) {
    if (!isJsonObject(content) || normalizedString(content["role"]) !== "user") continue;
    const parts = canonicalParts(contentValue(content));

    if (parts.length > 0) return { instructions, user: parts };
  }

  return { instructions, user: [] };
};

const flattenInteractionEntries = (value: Json | undefined): Json[] => {
  const entries: Json[] = [];

  const visit = (current: Json | undefined, inheritedRole: string): void => {
    if (isJsonArray(current)) {
      for (const child of current) visit(child, inheritedRole);
    } else if (isJsonObject(current)) {
      const own = normalizedString(current["role"]);
      const role = own === "" ? inheritedRole : own;
      const steps = current["steps"];

      if (isJsonArray(steps)) {
        for (const child of steps) visit(child, role);

        return;
      }

      entries.push(role !== "" && own === "" ? { ...current, role } : current);
    } else if (current !== undefined) {
      entries.push(current);
    }
  };

  visit(value, "");

  return entries;
};

const interactionsRoot = (body: JsonObject): Root => {
  const instructions: string[] = [];
  const system = firstField(body, "system_instruction", "systemInstruction");

  if (system !== undefined) appendInstruction(instructions, contentValue(system.value));

  if (!Object.hasOwn(body, "input")) return { instructions, user: [] };
  const input = body["input"];

  if (typeof input === "string") return { instructions, user: canonicalParts(input) };

  for (const entry of flattenInteractionEntries(input)) {
    if (typeof entry === "string") return { instructions, user: canonicalParts(entry) };

    if (!isJsonObject(entry)) continue;
    const role = normalizedString(entry["role"]);
    const stepType = normalizedString(entry["type"]);

    if (
      role === "system" ||
      role === "developer" ||
      stepType === "system_instruction" ||
      stepType === "developer_instruction"
    ) {
      appendInstruction(instructions, contentValue(entry));
      continue;
    }

    if (
      role === "user" ||
      stepType === "user_input" ||
      ((stepType === "message" || stepType === "") && role === "")
    ) {
      return { instructions, user: canonicalParts(contentValue(entry)) };
    }
  }

  return { instructions, user: [] };
};

const jsonString = (value: string): string => goMarshal(value);

/**
 * `DeriveID`: a stable identity from the leading instructions and the first complete user input
 * (`ctx:v1:<sha256 hex>`), or "" when the request has no user input.
 */
export const deriveId = (
  format: string,
  payload: Json | undefined,
  callerScope: string,
): string => {
  if (!isJsonObject(payload)) return "";
  const normalizedFormat = goTrimSpace(format).toLowerCase();
  const isGemini = normalizedFormat === "gemini" || normalizedFormat === "antigravity";
  let resource = "";

  if (isGemini) {
    const request = payload["request"];
    resource = stringField(
      isJsonObject(request) ? request : payload,
      "cachedContent",
      "cached_content",
    );
  }

  let root: Root;

  if (isGemini) root = geminiRoot(payload);
  else if (normalizedFormat === "interactions") root = interactionsRoot(payload);
  else if (normalizedFormat === "openai-response" || normalizedFormat === "codex")
    root = responsesRoot(payload);
  else if (normalizedFormat === "claude") root = messagesRoot(payload, true);
  else root = messagesRoot(payload, false);

  if (root.user.length === 0) return "";

  // Field order and omitempty rules of Go's `canonicalRoot` struct.
  const fields = [
    `"version":"cpa-session-root-v1"`,
    `"format":${jsonString(format)}`,
    `"caller_scope":${jsonString(goTrimSpace(callerScope))}`,
  ];

  if (root.instructions.length > 0)
    fields.push(`"instructions":[${root.instructions.map(jsonString).join(",")}]`);
  fields.push(
    `"user":[${root.user
      .map(
        (part) =>
          `{"kind":${jsonString(part.kind)}${part.mime === "" ? "" : `,"mime":${jsonString(part.mime)}`},"value":${jsonString(part.value)}}`,
      )
      .join(",")}]`,
  );

  if (resource !== "") fields.push(`"resource":${jsonString(resource)}`);

  return `ctx:v1:${createHash("sha256")
    .update(`{${fields.join(",")}}`)
    .digest("hex")}`;
};

// --- message hash fallback -----------------------------------------------------------------------------------

const FNV_OFFSET = 0xcbf29ce484222325n;

const FNV_PRIME = 0x100000001b3n;

const MASK64 = 0xffffffffffffffffn;

/** `truncateString`: at most `max` bytes (may cut a character, the hash only sees bytes). */
const truncateBytes = (value: string, max: number): Uint8Array =>
  encoder.encode(value).subarray(0, max);

const messageContent = (content: Json | undefined): string => {
  if (typeof content === "string") return content;

  if (!isJsonArray(content)) return "";
  const texts: string[] = [];

  for (const part of content) {
    if (prop(part, "type") === "text") {
      const text = prop(part, "text");

      if (typeof text === "string" && text !== "") texts.push(text);
    }
  }

  return texts.join(" ");
};

const responsesContent = (content: Json | undefined): string => {
  if (!isJsonArray(content)) return "";
  const texts: string[] = [];

  for (const part of content) {
    const type = prop(part, "type");

    if (type === "input_text" || type === "output_text" || type === "text") {
      const text = prop(part, "text");

      if (typeof text === "string" && text !== "") texts.push(text);
    }
  }

  return texts.join(" ");
};

const sessionHash = (system: Uint8Array, user: Uint8Array, assistant: Uint8Array): string => {
  let hash = FNV_OFFSET;

  const write = (bytes: Uint8Array): void => {
    for (const byte of bytes) hash = ((hash ^ BigInt(byte)) * FNV_PRIME) & MASK64;
  };

  const field = (label: string, bytes: Uint8Array): void => {
    if (bytes.length === 0) return;
    write(encoder.encode(label));
    write(bytes);
    write(encoder.encode("\n"));
  };

  field("sys:", system);
  field("usr:", user);
  field("ast:", assistant);

  return `msg:${hash.toString(16).padStart(16, "0")}`;
};

const asText = (value: Json | undefined): string => (typeof value === "string" ? value : "");

/**
 * `extractMessageHashIDs`: FNV hash of the first system/user/assistant messages. `primary` covers all three,
 * `fallback` only system + user (the earlier binding of the same conversation).
 */
export const messageHashIds = (
  payload: Json | undefined,
): { primary: string; fallback: string } => {
  const none = { primary: "", fallback: "" };

  if (payload === undefined || !isJsonObject(payload)) return none;
  let system = "";
  let user = "";
  let assistant = "";
  const messages = payload["messages"];

  if (isJsonArray(messages)) {
    for (const message of messages) {
      const content = messageContent(prop(message, "content"));

      if (content !== "") {
        const role = asText(prop(message, "role"));

        if (role === "system") system ||= content;
        else if (role === "user") user ||= content;
        else if (role === "assistant") assistant ||= content;
      }

      if (system !== "" && user !== "" && assistant !== "") break;
    }
  }

  if (system === "") {
    const top = payload["system"];

    if (isJsonArray(top)) {
      for (const part of top) {
        const text = asText(prop(part, "text"));

        if (text !== "") {
          system = text;
          break;
        }
      }
    } else if (typeof top === "string") {
      system = top;
    }
  }

  if (system === "" && user === "") {
    const instruction = get(payload, "systemInstruction.parts");

    if (isJsonArray(instruction)) {
      for (const part of instruction) {
        const text = asText(prop(part, "text"));

        if (text !== "") {
          system = text;
          break;
        }
      }
    }

    const contents = payload["contents"];

    if (isJsonArray(contents)) {
      for (const message of contents) {
        const role = asText(prop(message, "role"));
        forEachValue(prop(message, "parts"), (part) => {
          const text = asText(prop(part, "text"));

          if (text === "") return true;

          if (role === "user") user ||= text;
          else if (role === "model") assistant ||= text;

          return false;
        });

        if (user !== "" && assistant !== "") break;
      }
    }
  }

  if (system === "" && user === "") {
    const instructions = asString(payload["instructions"]);

    if (instructions !== "") system = instructions;
    const input = payload["input"];

    if (isJsonArray(input)) {
      for (const item of input) {
        const itemType = asText(prop(item, "type"));

        if (itemType === "reasoning") continue;

        if (itemType !== "" && itemType !== "message") continue;
        const role = asText(prop(item, "role"));

        if (itemType === "" && role === "") continue;
        const content = prop(item, "content");
        const text = typeof content === "string" ? content : responsesContent(content);

        if (text === "") continue;

        if (role === "developer" || role === "system") system ||= text;
        else if (role === "user") user ||= text;
        else if (role === "assistant") assistant ||= text;

        if (user !== "" && assistant !== "") break;
      }
    }
  }

  if (user === "") return none;
  const systemBytes = truncateBytes(system, 100);
  const userBytes = truncateBytes(user, 100);
  const empty = new Uint8Array(0);
  const short = sessionHash(systemBytes, userBytes, empty);

  if (assistant === "") return { primary: short, fallback: "" };

  return {
    primary: sessionHash(systemBytes, userBytes, truncateBytes(assistant, 100)),
    fallback: short,
  };
};
