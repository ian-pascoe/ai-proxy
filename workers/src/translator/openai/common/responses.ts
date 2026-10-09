/** Go source: internal/translator/common/responses.go. */
import { del, type Json, set } from "../../../json/index.ts"
import { getStr } from "./read.ts"

/** `SetResponsesToolCallIdentity`: writes a resolved Responses tool name and namespace (mutates `item`). */
export const setResponsesToolCallIdentity = (item: Json, name: string, namespace: string, itemPath: string): Json => {
  const namePath = itemPath !== "" ? `${itemPath}.name` : "name"
  const namespacePath = itemPath !== "" ? `${itemPath}.namespace` : "namespace"
  set(item, namePath, name)
  if (namespace !== "") set(item, namespacePath, namespace)
  else del(item, namespacePath)
  return item
}

/**
 * `ExtractResponsesCallID`: call_id -> tool_call_id -> callId -> id (excluding `fco_` output item ids).
 */
export const extractResponsesCallId = (node: Json | undefined): string => {
  const callId = getStr(node, "call_id").trim()
  if (callId !== "") return callId
  const toolCallId = getStr(node, "tool_call_id").trim()
  if (toolCallId !== "") return toolCallId
  const camel = getStr(node, "callId").trim()
  if (camel !== "") return camel
  const id = getStr(node, "id").trim()
  return id.startsWith("fco_") ? "" : id
}

const isOutputType = (type: string): boolean => type === "function_call_output" || type === "custom_tool_call_output"

/**
 * `NormalizeResponsesToolCallOutputs`: pairs tool outputs with preceding pending calls and assigns missing call ids
 * (exact id, then function name, then FIFO). Returns a new array; changed items are copies.
 */
export const normalizeResponsesToolCallOutputs = (items: readonly Json[]): Json[] => {
  if (items.length === 0) return [...items]
  const normalized: Json[] = [...items]

  const explicitOutputCounts = new Map<string, number>()
  for (const item of items) {
    if (isOutputType(getStr(item, "type"))) {
      const id = extractResponsesCallId(item)
      if (id !== "") explicitOutputCounts.set(id, (explicitOutputCounts.get(id) ?? 0) + 1)
    }
  }

  let pendingCallIds: string[] = []
  const pendingCallNames = new Map<string, string>()

  let i = 0
  while (i < normalized.length) {
    const item = normalized[i] as Json
    const itemType = getStr(item, "type")
    if (itemType === "function_call" || itemType === "custom_tool_call") {
      const callId = extractResponsesCallId(item)
      if (callId !== "") {
        pendingCallIds.push(callId)
        pendingCallNames.set(callId, getStr(item, "name"))
      }
      i++
    } else if (isOutputType(itemType)) {
      const start = i
      while (i < normalized.length && isOutputType(getStr(normalized[i], "type"))) i++
      const outputs = normalized.slice(start, i)

      if (pendingCallIds.length > 0) {
        const used = outputs.map(() => false)
        const matchedForPending = pendingCallIds.map(() => -1)

        // Pass 1: exact explicit call id match.
        pendingCallIds.forEach((pendingId, pendingIdx) => {
          for (let outIdx = 0; outIdx < outputs.length; outIdx++) {
            if (!used[outIdx] && extractResponsesCallId(outputs[outIdx]) === pendingId) {
              used[outIdx] = true
              matchedForPending[pendingIdx] = outIdx
              explicitOutputCounts.set(pendingId, (explicitOutputCounts.get(pendingId) ?? 0) - 1)
              break
            }
          }
        })

        // Pass 2: match by function name for outputs without a call id (skipping ids reserved by explicit outputs).
        pendingCallIds.forEach((pendingId, pendingIdx) => {
          if ((matchedForPending[pendingIdx] as number) >= 0 || (explicitOutputCounts.get(pendingId) ?? 0) > 0) return
          const expectedName = pendingCallNames.get(pendingId) ?? ""
          if (expectedName === "") return
          for (let outIdx = 0; outIdx < outputs.length; outIdx++) {
            if (!used[outIdx] && extractResponsesCallId(outputs[outIdx]) === "") {
              const outName = getStr(outputs[outIdx], "name").trim()
              if (outName !== "" && outName === expectedName) {
                used[outIdx] = true
                matchedForPending[pendingIdx] = outIdx
                break
              }
            }
          }
        })

        // Pass 3: FIFO fallback.
        pendingCallIds.forEach((pendingId, pendingIdx) => {
          if ((matchedForPending[pendingIdx] as number) >= 0 || (explicitOutputCounts.get(pendingId) ?? 0) > 0) return
          for (let outIdx = 0; outIdx < outputs.length; outIdx++) {
            if (!used[outIdx] && extractResponsesCallId(outputs[outIdx]) === "") {
              const outName = getStr(outputs[outIdx], "name").trim()
              const expectedName = pendingCallNames.get(pendingId) ?? ""
              if (outName === "" || expectedName === "" || outName === expectedName) {
                used[outIdx] = true
                matchedForPending[pendingIdx] = outIdx
                break
              }
            }
          }
        })

        const remainingPending: string[] = []
        pendingCallIds.forEach((pendingId, pendingIdx) => {
          const outIdx = matchedForPending[pendingIdx] as number
          if (outIdx < 0) {
            remainingPending.push(pendingId)
            return
          }
          const matchedOut = outputs[outIdx] as Json
          if (getStr(matchedOut, "call_id") !== pendingId) {
            const copy = structuredClone(matchedOut)
            set(copy, "call_id", pendingId)
            normalized[start + outIdx] = copy
          }
        })
        pendingCallIds = remainingPending
      }
    } else {
      i++
    }
  }
  return normalized
}

