/**
 * Cache-control propagation helpers.
 *
 * Go source: internal/translator/common/cache_control.go.
 */
import { cloneJson, get, type Json, type JsonObject } from "../../json/index.ts";
import { exists, isArr, isObj, str } from "./gjson.ts";

/** Only `{"type":"ephemeral"}` style objects are propagated. */
export const isValidCacheControl = (cc: Json | undefined): cc is JsonObject =>
  isObj(cc) && typeof cc.type === "string" && cc.type === "ephemeral";

/** `AttachCacheControl`: copies a valid `cache_control` from `src` onto `dst`. */
export const attachCacheControl = (dst: JsonObject, src: Json | undefined): JsonObject => {
  const cc = get(src, "cache_control");

  if (!isValidCacheControl(cc)) return dst;
  dst.cache_control = cloneJson(cc);

  return dst;
};

/** `AttachMessageCacheControl`: puts message-level `cache_control` on the last content block. */
export const attachMessageCacheControl = (msg: JsonObject, src: Json | undefined): JsonObject => {
  const cc = get(src, "cache_control");

  if (!isValidCacheControl(cc)) return msg;
  const content = msg.content;

  if (isArr(content)) {
    if (content.length === 0) return msg;
    const last = content[content.length - 1];

    if (exists(get(last, "cache_control"))) return msg;

    if (isObj(last)) last.cache_control = cloneJson(cc);

    return msg;
  }

  if (typeof content !== "string") return msg;
  msg.content = [{ type: "text", text: content, cache_control: cloneJson(cc) }];

  return msg;
};

const extractFirstPartCacheControl = (src: Json | undefined): JsonObject | undefined => {
  let content = get(src, "content");

  if (content === undefined) content = src;

  if (isArr(content)) {
    for (const part of content) {
      const cc = get(part, "cache_control");

      if (isValidCacheControl(cc)) return cc;
    }

    return undefined;
  }

  if (isObj(content)) {
    const cc = get(content, "cache_control");

    if (isValidCacheControl(cc)) return cc;
  }

  return undefined;
};

/** `AttachToolMessageCacheControl`: hoists part/message cache_control onto the first `tool_result` block. */
export const attachToolMessageCacheControl = (
  msg: JsonObject,
  src: Json | undefined,
): JsonObject => {
  let cc = extractFirstPartCacheControl(src);

  if (cc === undefined) {
    const own = get(src, "cache_control");

    if (isValidCacheControl(own)) cc = own;
  }

  if (cc === undefined) return msg;
  const content = msg.content;

  if (!isArr(content) || content.length === 0) return msg;
  const target = content.find((block) => str(get(block, "type")) === "tool_result");

  if (target === undefined || !isObj(target)) return msg;
  target.cache_control = cloneJson(cc);

  return msg;
};
