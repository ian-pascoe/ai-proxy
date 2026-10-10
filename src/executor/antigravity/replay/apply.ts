/**
 * Re-inserts cached Gemini thought signatures and native function calls into an Antigravity request.
 *
 * Go source: internal/runtime/executor/antigravity_reasoning_replay.go (`applyAntigravityReasoningReplayItems`
 * sequential path, `filterAntigravityReasoningReplayItemsForRequestWithIndex`, `mergeAntigravityFunctionCallPartReplay…`,
 * `restoreAntigravityNativeFunctionCallReplay`, the tool schema normalisation). Deviation: Go also has a batched
 * splice path that is an optimisation of the sequential one ("retain the exact legacy behavior"); only the sequential
 * semantics are ported (payloads are mutated in place, the index is rebuilt after each applied item).
 */
import {
  asInt,
  asString,
  cloneJson,
  del,
  get,
  isJsonArray,
  isJsonObject,
  type Json,
  type JsonObject,
  jsonEquals,
  tryParseJson
} from "../../../json/index.ts"
import { geminiClaudeToolUseID, isGeminiClaudeToolUseID } from "../../../translator/common/claude-util.ts"
import { mapSanitizedFunctionName, sanitizedFunctionNameMap } from "../../../translator/common/tool-names.ts"
import {
  canonicalJson,
  hasNativeThoughtSignature,
  isModelRole,
  type IndexedPart,
  nativePartThoughtSignature,
  partFingerprint,
  RequestIndex,
  SIGNATURE_PATHS,
  SKIP_VALIDATOR
} from "./request-index.ts"

export type ToolSchemas = ReadonlyMap<string, Json>

const argsRaw = (args: Json | undefined): string => (args === undefined ? "" : JSON.stringify(args))

const contentsOf = (payload: Json): Json[] | undefined => {
  const contents = get(payload, "request.contents")

  return isJsonArray(contents) ? contents : undefined
}

const partsOf = (payload: Json, contentIndex: number): Json[] | undefined => {
  const contents = contentsOf(payload)
  const parts = contents === undefined ? undefined : get(contents[contentIndex], "parts")

  return isJsonArray(parts) ? parts : undefined
}

// ---------------------------------------------------------------------------------------------------------------
// Tool schemas (Claude callers: argument values are compared after dropping schema defaults)
// ---------------------------------------------------------------------------------------------------------------

/** `antigravityReplayToolSchemasFromRequests`. */
export const replayToolSchemasFromRequests = (...requests: ReadonlyArray<Json | undefined>): Map<string, Json> => {
  const schemas = new Map<string, Json>()

  for (const request of requests) {
    if (request === undefined) continue
    const nameMap = sanitizedFunctionNameMap(request)
    const tools = get(request, "tools")

    if (!isJsonArray(tools)) continue

    for (const tool of tools) {
      const candidates: Json[] = [tool]
      const fn = get(tool, "function")

      if (fn !== undefined) candidates.push(fn)

      for (const candidate of candidates) {
        const name = asString(get(candidate, "name")).trim()

        if (name === "") continue
        let schema: Json | undefined

        for (const path of ["input_schema", "parameters", "parametersJsonSchema"]) {
          const value = get(candidate, path)

          if (isJsonObject(value)) {
            schema = value
            break
          }
        }

        if (schema === undefined) continue

        for (const schemaName of [name, mapSanitizedFunctionName(nameMap, name)]) {
          if (schemaName !== "" && !schemas.has(schemaName)) schemas.set(schemaName, schema)
        }
      }
    }
  }

  return schemas
}

/** `antigravityReplayJSONValue`: string arguments hold JSON text. */
const replayJsonValue = (value: Json | undefined): { ok: boolean; value?: Json } => {
  if (value === undefined) return { ok: false }
  const text = typeof value === "string" ? value : JSON.stringify(value)

  if (text.trim() === "") return { ok: false }
  const parsed = tryParseJson(text)

  return parsed === undefined ? { ok: false } : { ok: true, value: parsed }
}

/** `antigravityNormalizeReplayToolValue`. */
const normalizeToolValue = (value: Json, schema: Json | undefined): Json => {
  const schemaObject = isJsonObject(schema) ? schema : undefined

  if (isJsonObject(value)) {
    const propertiesValue = schemaObject?.["properties"]
    const properties = isJsonObject(propertiesValue) ? propertiesValue : undefined
    const normalized: JsonObject = {}

    for (const [key, child] of Object.entries(value)) {
      const childSchema = properties?.[key]
      const normalizedChild = normalizeToolValue(child as Json, childSchema)

      if (isJsonObject(childSchema) && Object.hasOwn(childSchema, "default")) {
        if (jsonEquals(normalizedChild, normalizeToolValue(childSchema["default"] as Json, childSchema))) continue
      }

      normalized[key] = normalizedChild
    }

    return normalized
  }

  if (isJsonArray(value)) {
    const itemSchema = schemaObject?.["items"]

    return value.map((child) => normalizeToolValue(child, itemSchema))
  }

  return value
}

/** `antigravityFunctionCallMatchesReplayItem`. */
const functionCallMatchesItem = (functionCall: Json | undefined, item: Json, schemas: ToolSchemas): boolean => {
  const name = asString(get(item, "name")).trim()

  if (name === "" || asString(get(functionCall, "name")).trim() !== name) return false
  const current = get(functionCall, "args")
  const native = get(item, "args")

  if (current === undefined || native === undefined) return false

  if (canonicalJson(current) === canonicalJson(native)) return true
  const schema = schemas.get(name)

  if (schema === undefined) return false
  const currentValue = replayJsonValue(current)
  const nativeValue = replayJsonValue(native)

  if (!currentValue.ok || !nativeValue.ok) return false

  return jsonEquals(
    normalizeToolValue(currentValue.value as Json, schema),
    normalizeToolValue(nativeValue.value as Json, schema)
  )
}

// ---------------------------------------------------------------------------------------------------------------
// Locating the parts an item belongs to
// ---------------------------------------------------------------------------------------------------------------

const itemCallId = (item: Json): string => {
  let callId = asString(get(item, "call_id")).trim()

  if (callId === "") callId = asString(get(item, "id")).trim()

  return callId
}

/** `functionResponseContentIndexForReplay`. */
const functionResponseContentIndexForReplay = (
  index: RequestIndex,
  item: Json
): { contentIndex: number; callId: string } | undefined => {
  const callId = asString(get(item, "call_id")).trim()
  const name = asString(get(item, "name")).trim()
  const candidates = [callId]
  const stableId = geminiClaudeToolUseID(callId, name, argsRaw(get(item, "args")))

  if (stableId !== "" && stableId !== callId) candidates.push(stableId)

  for (const candidate of candidates) {
    const contentIndex = index.functionResponseContentIndex(candidate)

    if (contentIndex !== undefined) return { contentIndex, callId: candidate }
  }

  return undefined
}

/** `functionCallPartLocationForReplayWithSchemas`. */
const functionCallPartLocation = (index: RequestIndex, item: Json, schemas: ToolSchemas): IndexedPart | undefined => {
  const name = asString(get(item, "name")).trim()
  const args = get(item, "args")

  if (name === "" || args === undefined) return undefined
  const callId = itemCallId(item)
  const stableId = geminiClaudeToolUseID(callId, name, argsRaw(args))
  const candidates = [callId]

  if (stableId !== "" && stableId !== callId) candidates.push(stableId)

  for (const candidate of candidates) {
    if (candidate === "") continue
    const location = index.functionCallPartLocation(candidate)

    if (location === undefined) continue

    if (index.contextMatches(item, location.contentIndex)) {
      return functionCallMatchesItem(location.functionCall, item, schemas) ? location : undefined
    }

    // The ID matched exactly: only the surrounding context drifted.
    return undefined
  }

  const cachedContentIndex = asInt(get(item, "contentIndex"))
  const targetOccurrence = get(item, "targetOccurrence")

  if (targetOccurrence !== undefined) {
    if (
      cachedContentIndex < 0 ||
      cachedContentIndex >= index.contents.length ||
      !index.contextMatches(item, cachedContentIndex)
    ) {
      return undefined
    }

    const wanted = asInt(targetOccurrence)
    let occurrence = 0
    const parts = (index.contents[cachedContentIndex] as { parts: ReadonlyArray<Json> }).parts

    for (let partIndex = 0; partIndex < parts.length; partIndex++) {
      const part = parts[partIndex] as Json
      const functionCall = get(part, "functionCall")
      const functionCallId = asString(get(functionCall, "id"))
      const mismatchedOpaqueId = isGeminiClaudeToolUseID(functionCallId) && functionCallId !== stableId

      if (functionCall === undefined || mismatchedOpaqueId || !functionCallMatchesItem(functionCall, item, schemas)) {
        continue
      }

      if (occurrence === wanted) return { contentIndex: cachedContentIndex, partIndex, part, functionCall }
      occurrence++
    }

    return undefined
  }

  const matches: IndexedPart[] = []
  index.contents.forEach((content, contentIndex) => {
    if (!index.contextMatches(item, contentIndex)) return
    content.parts.forEach((part, partIndex) => {
      const functionCall = get(part, "functionCall")
      const functionCallId = asString(get(functionCall, "id"))
      const mismatchedOpaqueId = isGeminiClaudeToolUseID(functionCallId) && functionCallId !== stableId

      if (functionCall === undefined || mismatchedOpaqueId) return

      if (functionCallMatchesItem(functionCall, item, schemas)) {
        matches.push({ contentIndex, partIndex, part, functionCall })
      }
    })
  })

  return matches.length === 1 ? (matches[0] as IndexedPart) : undefined
}

/** `functionCallProvenanceLocation`: an exact opaque-ID match without the context check. */
const functionCallProvenanceLocation = (
  index: RequestIndex,
  item: Json,
  schemas: ToolSchemas
): IndexedPart | undefined => {
  const name = asString(get(item, "name")).trim()
  const args = get(item, "args")
  const callId = asString(get(item, "call_id")).trim()

  if (name === "" || args === undefined || callId === "") return undefined
  const stableId = geminiClaudeToolUseID(callId, name, argsRaw(args))

  if (stableId === "" || stableId === callId) return undefined
  const location = index.functionCallPartLocation(stableId)

  return location !== undefined && functionCallMatchesItem(location.functionCall, item, schemas) ? location : undefined
}

/** `thoughtSignaturePartIndex`: the single locator shared by the eligibility check and the write path. */
const thoughtSignaturePartIndex = (
  index: RequestIndex,
  item: Json
): { contentIndex: number; partIndex: number } | undefined => {
  const contentIndex = asInt(get(item, "contentIndex"))

  if (contentIndex < 0 || contentIndex >= index.contents.length) return undefined
  const content = index.contents[contentIndex] as { content: Json; parts: ReadonlyArray<Json> }

  if (!isModelRole(content.content)) return undefined
  const parts = content.parts
  const targetKind = asString(get(item, "targetKind")).trim()
  const targetHash = asString(get(item, "targetHash")).trim()

  const kindMatches = (kind: string, fingerprint: string): boolean =>
    fingerprint === targetHash && (targetKind === "" || kind === targetKind)

  let partIndex = -1

  if (targetHash !== "") {
    const targetOccurrence = get(item, "targetOccurrence")

    if (targetOccurrence !== undefined) {
      const wanted = asInt(targetOccurrence)
      let occurrence = 0

      for (let candidate = 0; candidate < parts.length; candidate++) {
        const { kind, fingerprint } = partFingerprint(parts[candidate])

        if (!kindMatches(kind, fingerprint)) continue

        if (occurrence === wanted) {
          partIndex = candidate
          break
        }

        occurrence++
      }
    } else {
      const candidate = asInt(get(item, "partIndex"))

      if (candidate >= 0 && candidate < parts.length) {
        const { kind, fingerprint } = partFingerprint(parts[candidate])

        if (kindMatches(kind, fingerprint)) partIndex = candidate
      }

      if (partIndex < 0) {
        for (let next = 0; next < parts.length; next++) {
          const { kind, fingerprint } = partFingerprint(parts[next])

          if (kindMatches(kind, fingerprint)) {
            partIndex = next
            break
          }
        }
      }
    }
  } else {
    // Nothing proves which part the signature belongs to: only a matching context makes the positional guess safe.
    if (!index.contextMatches(item, contentIndex)) return undefined
    const candidate = asInt(get(item, "partIndex"))

    if (candidate >= 0 && candidate < parts.length && parts[candidate] !== null) {
      if (partFingerprint(parts[candidate]).kind !== "") partIndex = candidate
    }

    if (partIndex < 0) {
      for (let next = parts.length - 1; next >= 0; next--) {
        if (partFingerprint(parts[next]).kind !== "") {
          partIndex = next
          break
        }
      }
    }
  }

  return partIndex < 0 ? undefined : { contentIndex, partIndex }
}

// ---------------------------------------------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------------------------------------------

/** `filterAntigravityReasoningReplayItemsForRequestWithIndex` for one item. */
export const itemIsEligible = (index: RequestIndex, item: Json, schemas: ToolSchemas): boolean => {
  switch (asString(get(item, "type")).trim()) {
    case "function_call_part": {
      const signature = asString(get(item, "thoughtSignature")).trim()
      const location = functionCallPartLocation(index, item, schemas)

      if (location !== undefined) {
        const currentId = asString(get(location.functionCall, "id")).trim()
        const nativeId = asString(get(item, "call_id")).trim()

        const needsNativeRestore =
          currentId !== nativeId ||
          canonicalJson(get(location.functionCall, "args")) !== canonicalJson(get(item, "args"))

        return (
          needsNativeRestore ||
          (signature !== "" && !hasNativeThoughtSignature(asString(get(location.part, "thoughtSignature"))))
        )
      }

      // Even without a context match, an exact opaque ID match can still restore the native call identity.
      if (functionCallProvenanceLocation(index, item, schemas) !== undefined) return true
      const callId = asString(get(item, "call_id")).trim()

      if (callId === "") return false
      const response = functionResponseContentIndexForReplay(index, item)

      if (response === undefined) return false
      let contextMatches = index.contextMatches(item, response.contentIndex)

      if (!contextMatches && response.contentIndex > 0) {
        const previous = index.contents[response.contentIndex - 1]
        contextMatches = isModelRole(previous?.content) && index.contextMatches(item, response.contentIndex - 1)
      }

      return contextMatches
    }

    case "thought_signature": {
      const located = thoughtSignaturePartIndex(index, item)

      if (located === undefined) return true
      const part = (index.contents[located.contentIndex] as { parts: ReadonlyArray<Json> }).parts[located.partIndex]

      return !hasNativeThoughtSignature(asString(get(part, "thoughtSignature")))
    }

    default:
      return false
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------------------------------------------

/** `antigravityRemoveThoughtSignatureFromOtherParts`; true when a part changed. */
const removeSignatureFromOtherParts = (
  payload: Json,
  contentIndex: number,
  signature: string,
  keepPartIndex: number
): boolean => {
  const wanted = signature.trim()
  const parts = partsOf(payload, contentIndex)

  if (wanted === "" || parts === undefined) return false
  let changed = false
  parts.forEach((part, partIndex) => {
    if (partIndex === keepPartIndex || nativePartThoughtSignature(part) !== wanted) return

    for (const path of SIGNATURE_PATHS) {
      if (get(part, path) === undefined) continue
      del(part, path)
      changed = true
    }
  })

  return changed
}

/** `restoreAntigravityFunctionResponseReplayIdentity`; true when a response changed. */
const restoreFunctionResponseIdentity = (
  payload: Json,
  currentId: string,
  nativeId: string,
  nativeName: string
): boolean => {
  const current = currentId.trim()
  const native = nativeId.trim()
  const name = nativeName.trim()

  if (current === "" || native === "" || name === "" || current === native) return false
  let changed = false

  for (const content of contentsOf(payload) ?? []) {
    const parts = get(content, "parts")

    if (!isJsonArray(parts)) continue

    for (const part of parts) {
      const response = get(part, "functionResponse")

      if (!isJsonObject(response) || asString(response["id"]).trim() !== current) continue

      if (response["id"] !== native || response["name"] !== name) changed = true
      response["id"] = native
      response["name"] = name
    }
  }

  return changed
}

/** `antigravityFunctionResponsesCanRestoreID`. */
const functionResponsesCanRestoreId = (payload: Json, currentId: string, nativeName: string): boolean => {
  if (currentId === "") return true
  const contents = contentsOf(payload)

  if (contents === undefined) return false

  for (const content of contents) {
    const parts = get(content, "parts")

    if (!isJsonArray(parts)) continue

    for (const part of parts) {
      const response = get(part, "functionResponse")

      if (response === undefined || asString(get(response, "id")).trim() !== currentId) continue
      const name = asString(get(response, "name")).trim()

      if (!(name === "" || name === "unknown" || name === nativeName)) return false
    }
  }

  return true
}

/** `antigravityNativeFunctionCallJSON`. */
const nativeFunctionCall = (item: Json, fallbackId: string): JsonObject | undefined => {
  const name = asString(get(item, "name")).trim()
  const args = get(item, "args")

  if (name === "" || args === undefined) return undefined
  const call: JsonObject = { name }
  const callId = asString(get(item, "call_id")).trim() || fallbackId

  if (callId !== "") call["id"] = callId

  if (typeof args === "string") {
    const parsed = tryParseJson(args)
    call["args"] = parsed === undefined ? args : parsed
  } else {
    call["args"] = cloneJson(args)
  }

  return call
}

const clearSignatureFields = (part: Json): void => {
  for (const path of SIGNATURE_PATHS) del(part, path)
}

/** `restoreAntigravityNativeFunctionCallReplay`; true when the payload changed. */
const restoreNativeFunctionCall = (
  payload: Json,
  contentIndex: number,
  partIndex: number,
  item: Json,
  allowLegacyIdRestore: boolean,
  allowSignature: boolean
): boolean => {
  const parts = partsOf(payload, contentIndex)
  const part = parts?.[partIndex]
  const currentCall = get(part, "functionCall")

  if (!isJsonObject(part) || currentCall === undefined) return false
  const currentId = asString(get(currentCall, "id")).trim()
  const nativeId = asString(get(item, "call_id")).trim()
  const nativeName = asString(get(item, "name")).trim()
  const restoreIdentity = currentId === nativeId || isGeminiClaudeToolUseID(currentId) || allowLegacyIdRestore

  if (!restoreIdentity) {
    const signature = asString(get(item, "thoughtSignature")).trim()

    if (!allowSignature || signature === "" || hasNativeThoughtSignature(asString(part["thoughtSignature"])))
      return false
    removeSignatureFromOtherParts(payload, contentIndex, signature, partIndex)
    part["thoughtSignature"] = signature

    return true
  }

  if (currentId !== nativeId && !functionResponsesCanRestoreId(payload, currentId, nativeName)) return false
  const nativeCall = nativeFunctionCall(item, currentId)

  if (nativeCall === undefined) return false
  const before = JSON.stringify(part)
  part["functionCall"] = nativeCall
  clearSignatureFields(part)
  let changed = false
  const signature = asString(get(item, "thoughtSignature")).trim()

  if (allowSignature && signature !== "") {
    changed = removeSignatureFromOtherParts(payload, contentIndex, signature, partIndex) || changed
    part["thoughtSignature"] = signature
  }

  if (currentId !== "" && nativeId !== "" && currentId !== nativeId) {
    changed = restoreFunctionResponseIdentity(payload, currentId, nativeId, nativeName) || changed
  }

  return changed || JSON.stringify(part) !== before
}

const functionCallObject = (name: string, callId: string, args: Json | undefined): JsonObject => {
  const call: JsonObject = { name }

  if (callId !== "") call["id"] = callId

  if (args !== undefined) call["args"] = cloneJson(args)

  return call
}

/** `insertAntigravityModelFunctionCallBeforeContent`. */
const insertModelFunctionCallBefore = (
  payload: Json,
  beforeIndex: number,
  name: string,
  callId: string,
  signature: string,
  args: Json | undefined
): boolean => {
  const contents = contentsOf(payload)

  if (contents === undefined || beforeIndex < 0 || beforeIndex > contents.length) return false

  const part: JsonObject = {
    functionCall: functionCallObject(name, callId, args),
    thoughtSignature: signature === "" ? SKIP_VALIDATOR : signature
  }

  contents.splice(beforeIndex, 0, { role: "model", parts: [part] })

  return true
}

/** `appendAntigravityFunctionCallToModelContent`. */
const appendFunctionCallToModelContent = (
  payload: Json,
  contentIndex: number,
  name: string,
  callId: string,
  signature: string,
  args: Json | undefined
): boolean => {
  const contents = contentsOf(payload)
  const content = contents?.[contentIndex]
  const parts = get(content, "parts")

  if (!isModelRole(content) || !isJsonArray(parts)) return false
  const part: JsonObject = { functionCall: functionCallObject(name, callId, args) }
  let sig = signature

  if (sig === "" && !parts.some((existing) => get(existing, "functionCall") !== undefined)) sig = SKIP_VALIDATOR

  if (sig !== "") part["thoughtSignature"] = sig
  parts.push(part)

  return true
}

/** `mergeAntigravityFunctionCallPartReplayWithSchemas`; true when the payload changed. */
const mergeFunctionCallPart = (index: RequestIndex, payload: Json, item: Json, schemas: ToolSchemas): boolean => {
  const name = asString(get(item, "name")).trim()
  const args = get(item, "args")
  const callId = asString(get(item, "call_id")).trim()
  const signature = asString(get(item, "thoughtSignature")).trim()

  if (name === "" || args === undefined) return false
  const located = functionCallPartLocation(index, item, schemas)

  if (located !== undefined) {
    return restoreNativeFunctionCall(payload, located.contentIndex, located.partIndex, item, schemas.has(name), true)
  }

  // The context drifted, but an exact opaque ID proves the call's identity: restore the call and its signature.
  const provenance = functionCallProvenanceLocation(index, item, schemas)

  if (provenance !== undefined) {
    return restoreNativeFunctionCall(payload, provenance.contentIndex, provenance.partIndex, item, false, true)
  }

  if (callId === "") {
    // Without a native call ID only an exact semantic match is safe.
    return false
  }

  const stableId = geminiClaudeToolUseID(callId, name, argsRaw(args))
  const hasNativeId = index.functionCallPartLocation(callId) !== undefined
  const hasStableId = stableId !== "" && index.functionCallPartLocation(stableId) !== undefined

  if (hasNativeId || hasStableId) {
    // The client changed a call that is already in the history: never replay onto it, never insert a second copy.
    return false
  }

  const response = functionResponseContentIndexForReplay(index, item)

  if (response !== undefined) {
    const parallelModelIndex = response.contentIndex - 1
    const parallel = index.contents[parallelModelIndex]

    if (
      parallelModelIndex >= 0 &&
      isModelRole(parallel?.content) &&
      index.contextMatches(item, parallelModelIndex) &&
      appendFunctionCallToModelContent(payload, parallelModelIndex, name, callId, signature, args)
    ) {
      restoreFunctionResponseIdentity(payload, response.callId, callId, name)

      return true
    }

    if (
      index.contextMatches(item, response.contentIndex) &&
      insertModelFunctionCallBefore(payload, response.contentIndex, name, callId, signature, args)
    ) {
      restoreFunctionResponseIdentity(payload, response.callId, callId, name)

      return true
    }
  }

  // `antigravityReasoningReplayResolveContentIndex`
  const contents = contentsOf(payload)
  const cached = asInt(get(item, "contentIndex"))

  if (contents === undefined || cached < 0 || cached >= contents.length) return false

  if (!index.contextMatches(item, cached)) return false
  const partIndex = asInt(get(item, "partIndex"))
  const content = contents[cached]
  const parts = get(content, "parts")
  const existing = isJsonArray(parts) && partIndex >= 0 && partIndex < parts.length ? parts[partIndex] : undefined
  const functionCallArgs = typeof args === "string" ? args : cloneJson(args)

  if (existing === undefined || existing === null) {
    const part: JsonObject = { functionCall: functionCallObject(name, callId, functionCallArgs) }

    if (signature !== "") part["thoughtSignature"] = signature

    if (isJsonArray(parts)) parts.push(part)
    else if (isJsonObject(content)) content["parts"] = [part]
    else return false

    return true
  }

  if (!isJsonObject(existing)) return false
  let changed = false

  if (signature !== "" && !hasNativeThoughtSignature(asString(existing["thoughtSignature"]))) {
    removeSignatureFromOtherParts(payload, cached, signature, partIndex)
    existing["thoughtSignature"] = signature
    changed = true
  }

  if (existing["functionCall"] === undefined) {
    existing["functionCall"] = functionCallObject(name, callId, functionCallArgs)
    changed = true
  }

  return changed
}

/** `insertAntigravityReasoningReplayItemsWithSchemas` for one eligible item. */
const insertItem = (index: RequestIndex, payload: Json, item: Json, schemas: ToolSchemas): boolean => {
  switch (asString(get(item, "type")).trim()) {
    case "thought_signature": {
      const signature = asString(get(item, "thoughtSignature")).trim()

      if (signature === "") return false
      const located = thoughtSignaturePartIndex(index, item)

      if (located === undefined) return false
      const part = partsOf(payload, located.contentIndex)?.[located.partIndex]

      if (!isJsonObject(part) || hasNativeThoughtSignature(asString(part["thoughtSignature"]))) return false
      removeSignatureFromOtherParts(payload, asInt(get(item, "contentIndex")), signature, located.partIndex)
      part["thoughtSignature"] = signature

      return true
    }

    case "function_call_part":
      return mergeFunctionCallPart(index, payload, item, schemas)
    default:
      return false
  }
}

/**
 * `applyAntigravityReasoningReplayItems` (sequential semantics): applies every eligible ledger item to `payload`
 * in place; returns whether anything changed.
 */
export const applyReplayItems = (payload: Json, items: ReadonlyArray<Json>, schemas: ToolSchemas): boolean => {
  let index = new RequestIndex(payload)
  let changed = false
  items.forEach((item, itemIndex) => {
    if (!itemIsEligible(index, item, schemas) || !insertItem(index, payload, item, schemas)) return
    changed = true

    if (itemIndex + 1 < items.length) index = new RequestIndex(payload)
  })

  return changed
}
