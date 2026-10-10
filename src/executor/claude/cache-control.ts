/**
 * Claude `cache_control` placement, limits and TTL normalisation.
 *
 * Go source: internal/runtime/executor/claude_executor_cloaking.go (ensureCacheControl, injectToolsCacheControl,
 * injectSystemCacheControl, injectMessagesCacheControl, enforceCacheControlLimit, upgradeClaudeCacheControlTTL,
 * stripClaudeCacheControlTTL, normalizeCacheControlTTL, isExplicitPromptCacheMode, stripPromptCacheOptions,
 * shouldEnsureCacheControl, countCacheControls). Functions mutate the parsed body in place.
 */
import { get, type Json, type JsonObject } from "../../json/index.ts"
import { isArr, isObj, str } from "../../translator/common/gjson.ts"

export const CACHE_TTL_1H = "1h"

/** A text block with an optional ephemeral marker (`buildTextBlock`). */
export const textBlock = (text: string, cacheControl?: JsonObject): JsonObject =>
  cacheControl === undefined ? { type: "text", text } : { type: "text", text, cache_control: cacheControl }

const ephemeral = (): JsonObject => ({ type: "ephemeral" })

const hasKey = (value: Json | undefined, key: string): boolean => isObj(value) && Object.hasOwn(value, key)

/** `isExplicitPromptCacheMode`: `prompt_cache_options.mode == "explicit"` in any payload. */
export const isExplicitPromptCacheMode = (...payloads: ReadonlyArray<Json | undefined>): boolean =>
  payloads.some((payload) => str(get(payload, "prompt_cache_options.mode")).trim().toLowerCase() === "explicit")

export const stripPromptCacheOptions = (body: JsonObject): JsonObject => {
  delete body.prompt_cache_options
  return body
}

/** Every block that may carry `cache_control`, in evaluation order: tools, system, message content. */
const cacheBlocks = (body: JsonObject): JsonObject[] => {
  const blocks: JsonObject[] = []
  const push = (items: Json | undefined): void => {
    if (isArr(items)) for (const item of items) if (isObj(item)) blocks.push(item)
  }
  push(body.tools)
  push(body.system)
  if (isArr(body.messages)) for (const message of body.messages) if (isObj(message)) push(message.content)
  return blocks
}

export const countCacheControls = (body: JsonObject): number =>
  cacheBlocks(body).filter((block) => hasKey(block, "cache_control")).length

/** `shouldEnsureCacheControl`. */
export const shouldEnsureCacheControl = (
  body: JsonObject,
  cloaked: boolean,
  confirmedClaudeCode: boolean,
  ...candidates: ReadonlyArray<Json | undefined>
): boolean => {
  if (isExplicitPromptCacheMode(body, ...candidates)) return false
  return !confirmedClaudeCode && (cloaked || countCacheControls(body) === 0)
}

/** `upgradeClaudeCacheControlTTL`: markers without `ttl` get `ttl`. */
export const upgradeCacheControlTTL = (body: JsonObject, ttl: string): JsonObject => {
  if (ttl === "") return body
  for (const block of cacheBlocks(body)) {
    const cc = block.cache_control
    if (!isObj(cc) || Object.hasOwn(cc, "ttl") || typeof cc.type !== "string") continue
    const upgraded: JsonObject = { type: cc.type, ttl }
    if (Object.hasOwn(cc, "scope")) upgraded.scope = cc.scope as Json
    block.cache_control = upgraded
  }
  return body
}

export const stripCacheControlTTL = (body: JsonObject): JsonObject => {
  for (const block of cacheBlocks(body)) {
    const cc = block.cache_control
    if (isObj(cc)) delete cc.ttl
  }
  return body
}

/** `normalizeCacheControlTTL`: a 1h marker must not follow a 5m marker. */
export const normalizeCacheControlTTL = (body: JsonObject): JsonObject => {
  let seen5m = false
  for (const block of cacheBlocks(body)) {
    if (!hasKey(block, "cache_control")) continue
    const cc = block.cache_control
    if (!isObj(cc)) {
      seen5m = true
      continue
    }
    if (cc.ttl !== CACHE_TTL_1H) {
      seen5m = true
      continue
    }
    if (seen5m) delete cc.ttl
  }
  return body
}

/** `ClaudePayloadHas1hTTL`. */
export const payloadHas1hTTL = (body: JsonObject): boolean =>
  cacheBlocks(body).some((block) => isObj(block.cache_control) && block.cache_control.ttl === CACHE_TTL_1H)

/** `enforceCacheControlLimit`: keeps at most `maxBlocks` markers (3 when the body has a `thread`). */
export const enforceCacheControlLimit = (body: JsonObject, maxBlocks: number): JsonObject => {
  let max = maxBlocks
  if (body.thread !== undefined && body.thread !== null && max > 0) max--
  let excess = countCacheControls(body) - max
  if (excess <= 0) return body

  const strip = (block: JsonObject): boolean => {
    if (excess <= 0) return false
    if (!hasKey(block, "cache_control")) return true
    delete block.cache_control
    excess--
    return true
  }
  const stripEarlier = (items: Json | undefined): void => {
    if (!isArr(items)) return
    let last = -1
    items.forEach((item, index) => {
      if (hasKey(item, "cache_control")) last = index
    })
    if (last < 0) return
    items.forEach((item, index) => {
      if (index !== last && isObj(item)) strip(item)
    })
  }
  stripEarlier(body.system)
  if (excess <= 0) return body
  stripEarlier(body.tools)
  if (excess <= 0) return body
  if (isArr(body.messages)) {
    for (const message of body.messages) {
      const content = get(message, "content")
      if (!isArr(content)) continue
      for (const item of content) if (isObj(item) && !strip(item)) break
      if (excess <= 0) break
    }
  }
  if (excess <= 0) return body
  if (isArr(body.system)) for (const item of body.system) if (isObj(item) && !strip(item)) break
  if (excess <= 0) return body
  if (isArr(body.tools)) for (const item of body.tools) if (isObj(item) && !strip(item)) break
  return body
}

const messageEligibleForRollingCache = (message: Json): boolean => {
  const content = get(message, "content")
  if (typeof content === "string") return true
  if (!isArr(content) || content.length === 0) return false
  if (str(get(message, "role")) !== "assistant") return true
  const lastType = str(get(content[content.length - 1], "type"))
  return lastType !== "thinking" && lastType !== "redacted_thinking"
}

const injectMessagesCacheControl = (body: JsonObject): void => {
  const messages = body.messages
  if (!isArr(messages)) return
  let lastEligible = -1
  messages.forEach((message, index) => {
    const role = str(get(message, "role"))
    if ((role === "user" || role === "assistant") && messageEligibleForRollingCache(message)) lastEligible = index
  })
  if (lastEligible < 0) return
  const final = messages[messages.length - 1]
  const finalContent = get(final, "content")
  if (str(get(final, "role")) === "system" && typeof finalContent === "string" && finalContent.trim() !== "") {
    ;(final as JsonObject).content = [textBlock(finalContent, ephemeral())]
    return
  }
  const target = messages[lastEligible] as JsonObject
  const content = target.content
  if (isArr(content)) {
    if (content.some((item) => hasKey(item, "cache_control"))) return
    const last = content[content.length - 1]
    if (content.length > 0 && isObj(last)) last.cache_control = ephemeral()
  } else if (typeof content === "string") {
    target.content = [textBlock(content, ephemeral())]
  }
}

const injectToolsCacheControl = (body: JsonObject): void => {
  const tools = body.tools
  if (!isArr(tools)) return
  let lastEligible = -1
  for (const [index, tool] of tools.entries()) {
    if (hasKey(tool, "cache_control")) return
    if (get(tool, "defer_loading") !== true) lastEligible = index
  }
  if (lastEligible >= 0) (tools[lastEligible] as JsonObject).cache_control = ephemeral()
}

const injectSystemCacheControl = (body: JsonObject): void => {
  const system = body.system
  if (isArr(system)) {
    if (system.length === 0 || system.some((item) => hasKey(item, "cache_control"))) return
    const last = system[system.length - 1]
    if (isObj(last)) last.cache_control = ephemeral()
  } else if (typeof system === "string" && system.trim() !== "") {
    body.system = [textBlock(system, ephemeral())]
  }
}

const hasCacheableSystem = (body: JsonObject): boolean => {
  const system = body.system
  if (isArr(system)) return system.length > 0
  return typeof system === "string" && system.trim() !== ""
}

/** `ensureCacheControl`: tools (only without cacheable system), system and the rolling last message. */
export const ensureCacheControl = (body: JsonObject): JsonObject => {
  if (!hasCacheableSystem(body)) injectToolsCacheControl(body)
  injectSystemCacheControl(body)
  injectMessagesCacheControl(body)
  return body
}
