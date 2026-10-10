/**
 * Shared OpenAI Responses item helpers.
 *
 * Go source: internal/translator/common/responses.go.
 */
import { del, get, type Json, type JsonObject, set } from "../../json/index.ts"
import { isObj, str } from "./gjson.ts"

/** `ExtractResponsesCallID`: call_id -> tool_call_id -> callId -> id (excluding `fco_` output item ids). */
export const extractResponsesCallID = (node: Json | undefined): string => {
  for (const key of ["call_id", "tool_call_id", "callId"]) {
    const value = str(get(node, key)).trim()

    if (value !== "") return value
  }

  const id = str(get(node, "id")).trim()

  return id.startsWith("fco_") ? "" : id
}

const isOutputType = (type: string): boolean => type === "function_call_output" || type === "custom_tool_call_output"

/**
 * `NormalizeResponsesToolCallOutputs`: assigns missing call ids to tool outputs by explicit id, then function name,
 * then FIFO order. Outputs that already carry an unmatched explicit id are never rewritten.
 */
export const normalizeResponsesToolCallOutputs = (items: readonly Json[]): Json[] => {
  if (items.length === 0) return [...items]
  const normalized: Json[] = [...items]
  const explicitOutputCounts = new Map<string, number>()

  for (const item of items) {
    if (isOutputType(str(get(item, "type")))) {
      const id = extractResponsesCallID(item)

      if (id !== "") explicitOutputCounts.set(id, (explicitOutputCounts.get(id) ?? 0) + 1)
    }
  }

  let pendingCallIDs: string[] = []
  const pendingCallNames = new Map<string, string>()
  const reserved = (id: string): boolean => (explicitOutputCounts.get(id) ?? 0) > 0

  let i = 0

  while (i < normalized.length) {
    const itemType = str(get(normalized[i], "type"))

    if (itemType === "function_call" || itemType === "custom_tool_call") {
      const callID = extractResponsesCallID(normalized[i])

      if (callID !== "") {
        pendingCallIDs.push(callID)
        pendingCallNames.set(callID, str(get(normalized[i], "name")))
      }

      i++
    } else if (isOutputType(itemType)) {
      const start = i

      while (i < normalized.length && isOutputType(str(get(normalized[i], "type")))) i++
      const outputs = normalized.slice(start, i)

      if (pendingCallIDs.length > 0) {
        const used = outputs.map(() => false)
        const matched = pendingCallIDs.map(() => -1)

        pendingCallIDs.forEach((pendingID, pendingIdx) => {
          const outIdx = outputs.findIndex((out, idx) => !used[idx] && extractResponsesCallID(out) === pendingID)

          if (outIdx >= 0) {
            used[outIdx] = true
            matched[pendingIdx] = outIdx
            explicitOutputCounts.set(pendingID, (explicitOutputCounts.get(pendingID) ?? 0) - 1)
          }
        })

        pendingCallIDs.forEach((pendingID, pendingIdx) => {
          if ((matched[pendingIdx] as number) >= 0 || reserved(pendingID)) return
          const expectedName = pendingCallNames.get(pendingID) ?? ""

          if (expectedName === "") return

          const outIdx = outputs.findIndex(
            (out, idx) =>
              !used[idx] &&
              extractResponsesCallID(out) === "" &&
              str(get(out, "name")).trim() !== "" &&
              str(get(out, "name")).trim() === expectedName
          )

          if (outIdx >= 0) {
            used[outIdx] = true
            matched[pendingIdx] = outIdx
          }
        })

        pendingCallIDs.forEach((pendingID, pendingIdx) => {
          if ((matched[pendingIdx] as number) >= 0 || reserved(pendingID)) return
          const expectedName = pendingCallNames.get(pendingID) ?? ""

          const outIdx = outputs.findIndex((out, idx) => {
            if (used[idx] || extractResponsesCallID(out) !== "") return false
            const outName = str(get(out, "name")).trim()

            return outName === "" || expectedName === "" || outName === expectedName
          })

          if (outIdx >= 0) {
            used[outIdx] = true
            matched[pendingIdx] = outIdx
          }
        })

        const remaining: string[] = []
        pendingCallIDs.forEach((pendingID, pendingIdx) => {
          const outIdx = matched[pendingIdx] as number

          if (outIdx < 0) {
            remaining.push(pendingID)

            return
          }

          const out = outputs[outIdx]

          if (str(get(out, "call_id")) !== pendingID && isObj(out)) {
            normalized[start + outIdx] = { ...out, call_id: pendingID } satisfies JsonObject
          }
        })
        pendingCallIDs = remaining
      }
    } else {
      i++
    }
  }

  return normalized
}

/** `SetResponsesToolCallIdentity`: writes a resolved Responses tool name and namespace (mutates `item`). */
export const setResponsesToolCallIdentity = (item: Json, name: string, namespace: string, itemPath: string): Json => {
  const namePath = itemPath !== "" ? `${itemPath}.name` : "name"
  const namespacePath = itemPath !== "" ? `${itemPath}.namespace` : "namespace"
  set(item, namePath, name)

  if (namespace !== "") set(item, namespacePath, namespace)
  else del(item, namespacePath)

  return item
}
