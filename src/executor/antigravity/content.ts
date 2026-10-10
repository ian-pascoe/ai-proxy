/**
 * Content-level request fixes applied by the Antigravity executor between thinking and the envelope.
 *
 * Go source: internal/runtime/executor/antigravity_executor.go (`sanitizeAntigravityGeminiRequestSignatures`,
 * `normalizeAntigravityGeminiFunctionResponseRoles`, `repairAntigravityGeminiFunctionResponseNames`,
 * `ensureAntigravityGeminiBoundaryUserContent`, `validateAntigravityRequestSignatures`) and
 * antigravity_reasoning_replay.go (`antigravityUsesReasoningReplayCache`).
 */
import { asString, exists, get, isJsonArray, isJsonObject, type Json, set } from "../../json/index.ts"
import {
  stripEmptySignatureThinkingBlocks,
  stripInvalidBypassSignatureThinkingBlocks,
  stripInvalidGeminiSignatureThinkingBlocks
} from "../../translator/antigravity/claude/carrier.ts"
import { sanitizeGeminiRequestThoughtSignatures } from "../../translator/gemini/common/signature.ts"
import { signatureBypassStrictMode, signatureCacheEnabled } from "../../signature/cache.ts"
import {
  ensureGeminiBoundaryUserContent,
  ensureGeminiLeadingUserContent,
  ensureGeminiTrailingUserContent
} from "../gemini/content-turns.ts"

/** `antigravityUsesReasoningReplayCache`: Gemini-family models that need thought signatures replayed. */
export const usesReasoningReplay = (modelName: string): boolean => {
  const lower = modelName.toLowerCase()

  if (lower.includes("claude")) return false

  return lower.includes("gemini") || lower.includes("flash") || lower.includes("agent")
}

const isClaude = (modelName: string): boolean => modelName.toLowerCase().includes("claude")

/** Boundary turns are skipped for Claude targets: the adapter rejects empty text parts. */
export const ensureLeadingUserContent = (modelName: string, payload: Json): Json =>
  isClaude(modelName) ? payload : ensureGeminiLeadingUserContent(payload, "request.contents")

export const ensureTrailingUserContent = (modelName: string, payload: Json): Json =>
  isClaude(modelName) ? payload : ensureGeminiTrailingUserContent(payload, "request.contents")

export const ensureBoundaryUserContent = (modelName: string, payload: Json): Json =>
  isClaude(modelName) ? payload : ensureGeminiBoundaryUserContent(payload, "request.contents")

interface FunctionRef {
  readonly id: string
  readonly name: string
}

/** `repairAntigravityGeminiFunctionResponseNames`: missing or `unknown` response names come from the matching call id. */
const repairFunctionResponseNames = (payload: Json): void => {
  const contents = get(payload, "request.contents")

  if (!isJsonArray(contents)) return
  const callIdToName = new Map<string, string>()

  for (const content of contents) {
    const parts = get(content, "parts")

    if (!isJsonArray(parts)) continue

    for (const part of parts) {
      const call = get(part, "functionCall")

      if (call === undefined) continue
      const id = asString(get(call, "id")).trim()
      const name = asString(get(call, "name")).trim()

      if (id !== "" && name !== "" && name !== "unknown") callIdToName.set(id, name)
    }
  }

  if (callIdToName.size === 0) return

  for (const content of contents) {
    const parts = get(content, "parts")

    if (!isJsonArray(parts)) continue

    for (const part of parts) {
      const response = get(part, "functionResponse")

      if (response === undefined) continue
      const id = asString(get(response, "id")).trim()
      const name = asString(get(response, "name")).trim()

      if (id === "" || (name !== "" && name !== "unknown")) continue
      const realName = callIdToName.get(id)

      if (realName !== undefined) set(part, "functionResponse.name", realName)
    }
  }
}

/**
 * `normalizeAntigravityGeminiFunctionResponseRoles`: repairs response names, orders every response turn like the
 * pending calls and gives response-only turns the `model` role (what the upstream expects).
 */
export const normalizeFunctionResponseRoles = (payload: Json): Json => {
  repairFunctionResponseNames(payload)
  const contents = get(payload, "request.contents")

  if (!isJsonArray(contents)) return payload
  let pending: FunctionRef[] = []

  for (const content of contents) {
    const parts = get(content, "parts")

    if (!isJsonArray(parts)) {
      pending = []
      continue
    }

    const calls: FunctionRef[] = []
    const responses: FunctionRef[] = []
    const responseParts: Json[] = []
    const otherParts: Json[] = []
    let hasOtherPart = false

    for (const part of parts) {
      if (exists(part, "functionCall")) {
        calls.push({ id: asString(get(part, "functionCall.id")), name: asString(get(part, "functionCall.name")) })
      } else if (exists(part, "functionResponse")) {
        responses.push({
          id: asString(get(part, "functionResponse.id")),
          name: asString(get(part, "functionResponse.name"))
        })
        responseParts.push(part)
      } else {
        hasOtherPart = true
        otherParts.push(part)
      }
    }

    if (parts.length === 0) {
      pending = []
      continue
    }

    if (calls.length > 0 && responses.length === 0) {
      pending = calls
      continue
    }

    if (responses.length === 0) {
      if (hasOtherPart) pending = []
      continue
    }

    if (calls.length > 0) {
      pending = []
      continue
    }

    if (isJsonObject(content)) {
      if (pending.length > 0) {
        const ordered: Json[] = []
        const used = responses.map(() => false)

        for (const call of pending) {
          const index = responses.findIndex(
            (response, i) =>
              !used[i] &&
              ((call.id !== "" && response.id === call.id) ||
                (call.id === "" && call.name !== "" && response.name === call.name))
          )

          if (index >= 0) {
            used[index] = true
            ordered.push(responseParts[index] as Json)
          }
        }

        responses.forEach((_, index) => {
          if (!used[index]) ordered.push(responseParts[index] as Json)
        })

        if (ordered.length === responseParts.length) {
          const next = [...ordered, ...otherParts]

          if (next.some((part, index) => part !== parts[index])) content["parts"] = next
        }
      }

      if (!hasOtherPart && asString(content["role"]) !== "model") content["role"] = "model"
    }

    pending = []
  }

  return payload
}

/** `sanitizeAntigravityGeminiRequestSignatures`: Gemini-family models only. */
export const sanitizeGeminiRequestSignatures = (modelName: string, payload: Json): Json => {
  if (!usesReasoningReplay(modelName)) return payload
  sanitizeGeminiRequestThoughtSignatures(payload, "request.contents")

  return normalizeFunctionResponseRoles(payload)
}

/**
 * `validateAntigravityRequestSignatures`: Claude-format clients only. Gemini models keep Gemini carriers, Claude models
 * accept only Claude-format signatures (strict bypass additionally validates the protobuf tree).
 */
export const validateRequestSignatures = (modelName: string, sourceFormat: string, payload: Json): Json => {
  if (sourceFormat !== "claude") return payload

  if (usesReasoningReplay(modelName)) return stripInvalidGeminiSignatureThinkingBlocks(payload)
  stripEmptySignatureThinkingBlocks(payload)

  if (signatureCacheEnabled()) return payload

  if (!signatureBypassStrictMode()) return payload

  return stripInvalidBypassSignatureThinkingBlocks(payload)
}
