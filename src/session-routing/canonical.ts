/**
 * Canonical conversation turns and their fingerprints for the LCP conversation matcher.
 *
 * Go source: sdk/cliproxy/session/lcp.go (`ExtractCanonicalTurns`, `FastTurnFingerprint`, `normalizeCanonicalTurn`,
 * `sparseSample`, `EnvironmentDigest`, `minimumAffinityPrefixLength`). Sizes and sampling are in UTF-8 bytes like Go.
 * Deviations: JSON parts are measured and sampled over the compact re-serialisation of the parsed body (Go uses the
 * client's raw bytes), and a sparse sample cut inside a multi-byte character decodes to U+FFFD instead of keeping the
 * partial bytes. Fingerprints never leave the Durable Object, so only their determinism matters.
 */
import { createHash } from "node:crypto"
import { isJsonArray, isJsonObject, type Json } from "../json/index.ts"
import { compareUtf8, goMarshal } from "./go-json.ts"

const CANONICAL_TURN_VERSION = "cpa-session-turn-v1"

const LARGE_PART_THRESHOLD = 16 * 1024

const SPARSE_FINGERPRINT_BYTES = 12 * 1024

export const MAX_CANONICAL_TURNS = 4096

const MAX_CANONICAL_PARTS_PER_TURN = 256

export const MAX_COMPACTION_PROBE_WINDOW = 32

// RE2 `\s` is ASCII-only; JS `\s` is not, so the character class is spelled out.
const ISO8601 = /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/g

const UUID = /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}\b/g

const THINK = /[\t\n\f\r ]*<(?:think|thinking)>.*?<\/(?:think|thinking)>[\t\n\f\r ]*/gis

const encoder = new TextEncoder()

const decoder = new TextDecoder()

export const byteLength = (value: string): number => encoder.encode(value).length

/** `strings.TrimSpace` (Unicode White_Space, which differs from JS `trim` for U+0085 and U+FEFF). */
export const goTrimSpace = (value: string): string =>
  value
    .replace(/^[\t-\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/, "")
    .replace(/[\t-\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/, "")

export interface CanonicalPart {
  kind: string
  mime: string
  value: string
  digest: string
  originalSize: number
  sampled: boolean
}

export interface CanonicalTurn {
  role: string
  parts: CanonicalPart[]
}

const part = (kind: string, value: string, extra: Partial<CanonicalPart> = {}): CanonicalPart => ({
  kind,
  mime: "",
  value,
  digest: "",
  originalSize: 0,
  sampled: false,
  ...extra
})

const sha256Hex = (data: string): string => createHash("sha256").update(data, "utf8").digest("hex")

/** `sparseSample`: head/middle/tail thirds of `limit` bytes. */
export const sparseSample = (value: string, limit: number): string => {
  const bytes = encoder.encode(value)

  if (limit <= 0 || bytes.length <= limit) return value
  const head = Math.floor(limit / 3)
  const middle = Math.floor(limit / 3)
  const tail = limit - head - middle
  const middleStart = Math.floor((bytes.length - middle) / 2)
  const out = new Uint8Array(limit)
  out.set(bytes.subarray(0, head), 0)
  out.set(bytes.subarray(middleStart, middleStart + middle), head)
  out.set(bytes.subarray(bytes.length - tail), head + middle)

  return decoder.decode(out)
}

const normalizeText = (value: string, maskSystemDynamics: boolean): string => {
  let out = value.replaceAll("\r\n", "\n").replaceAll("\r", "\n").replace(THINK, " ")

  if (maskSystemDynamics) out = out.replace(ISO8601, "<timestamp>").replace(UUID, "<uuid>")

  return goTrimSpace(out)
}

export const canonicalRole = (role: string): string => {
  const trimmed = goTrimSpace(role).toLowerCase()

  switch (trimmed) {
    case "system":
    case "developer":
      return "system"
    case "assistant":
    case "model":
    case "ai":
      return "assistant"
    case "tool":
    case "function":
      return "tool"
    default:
      return trimmed
  }
}

// --- gjson-like accessors ------------------------------------------------------------------------------------

export const prop = (value: Json | undefined, key: string): Json | undefined =>
  isJsonObject(value) && Object.hasOwn(value, key) ? value[key] : undefined

/** gjson `.String()`. */
export const gString = (value: Json | undefined): string => {
  if (value === undefined || value === null) return ""

  if (typeof value === "string") return value

  if (typeof value === "number" || typeof value === "boolean") return String(value)

  return JSON.stringify(value)
}

const typeOf = (value: Json | undefined): string => goTrimSpace(gString(prop(value, "type"))).toLowerCase()

/** gjson `ForEach`: arrays and objects iterate their values, any other existing value is visited once. */
export const forEachValue = (value: Json | undefined, visit: (child: Json) => boolean): void => {
  if (value === undefined) return

  if (isJsonArray(value)) {
    for (const child of value) if (!visit(child)) return
  } else if (isJsonObject(value)) {
    for (const child of Object.values(value)) if (!visit(child)) return
  } else {
    visit(value)
  }
}

// --- parts ---------------------------------------------------------------------------------------------------

const textPart = (raw: string): CanonicalPart => {
  const text = normalizeText(raw, false)
  const size = byteLength(text)

  if (size > LARGE_PART_THRESHOLD) {
    return part("text", sparseSample(text, SPARSE_FINGERPRINT_BYTES), {
      digest: sha256Hex(text),
      originalSize: size,
      sampled: true
    })
  }

  return part("text", text, { originalSize: size })
}

const jsonPart = (kind: string, value: Json): CanonicalPart => {
  let raw = JSON.stringify(value)
  const rawSize = byteLength(raw)

  if (rawSize > LARGE_PART_THRESHOLD) {
    return part(kind, sparseSample(raw, SPARSE_FINGERPRINT_BYTES), {
      digest: sha256Hex(raw),
      originalSize: rawSize,
      sampled: true
    })
  }

  raw = goMarshal(value)

  return part(kind, raw, { originalSize: byteLength(raw) })
}

const truncatedMarker = (p: CanonicalPart): boolean => p.kind === "value" && p.value.startsWith("<truncated:")

const limitPartsCount = (parts: CanonicalPart[], dropped: number): CanonicalPart[] => {
  if (dropped <= 0) return parts
  const last = parts[parts.length - 1]

  if (last !== undefined && truncatedMarker(last)) {
    last.originalSize += dropped
    last.value = `<truncated:${last.originalSize} parts>`

    return parts
  }

  parts.push(part("value", `<truncated:${dropped} parts>`, { originalSize: dropped }))

  return parts
}

/** `limitCanonicalParts`: dropped parts fold into one deterministic marker. */
const limitParts = (parts: CanonicalPart[], addedInput: CanonicalPart[]): CanonicalPart[] => {
  if (addedInput.length === 0) return parts
  let added = addedInput
  let existingDropped = 0
  let hasAddedMarker = false
  const lastAdded = added[added.length - 1] as CanonicalPart

  if (truncatedMarker(lastAdded)) {
    hasAddedMarker = true
    existingDropped = lastAdded.originalSize
    added = added.slice(0, -1)
  }

  const space = MAX_CANONICAL_PARTS_PER_TURN - parts.length

  if (space <= 0) return limitPartsCount(parts, added.length + existingDropped)

  if (added.length > space) {
    const dropped = added.length - space + existingDropped
    parts.push(...added.slice(0, space))

    return limitPartsCount(parts, dropped)
  }

  parts.push(...added)

  if (hasAddedMarker || existingDropped > 0) return limitPartsCount(parts, existingDropped)

  return parts
}

const isReasoning = (value: Json): boolean => {
  if (!isJsonObject(value)) return false
  const typ = typeOf(value)

  return (
    typ === "thinking" ||
    typ === "reasoning" ||
    typ === "thought" ||
    typ.includes("reasoning") ||
    value.thought === true
  )
}

const isToolType = (value: string): boolean =>
  value.includes("tool") || value.includes("function_call") || value === "function"

const geminiToolKind = (value: Json): string => {
  if (prop(value, "functionCall") !== undefined || prop(value, "function_call") !== undefined)
    return "tool:function_call"

  if (prop(value, "functionResponse") !== undefined || prop(value, "function_response") !== undefined) {
    return "tool:function_response"
  }

  return ""
}

const MEDIA_KEYS = ["image_url", "inlineData", "inline_data", "fileData", "file_data", "source"] as const

/** `canonicalPartsFromJSON`. */
export const canonicalPartsFromJson = (value: Json | undefined): CanonicalPart[] => {
  if (value === undefined) return []

  if (typeof value === "string") return [textPart(value)]

  if (typeof value === "number" || typeof value === "boolean") {
    const raw = String(value)

    return [part("value", raw, { originalSize: byteLength(raw) })]
  }

  if (value === null) return [jsonPart("value", value)]

  if (isReasoning(value)) return []

  if (isJsonArray(value)) {
    const parts: CanonicalPart[] = []
    let dropped = 0

    for (const child of value) {
      if (parts.length >= MAX_CANONICAL_PARTS_PER_TURN) {
        dropped += 1
        continue
      }

      limitParts(parts, canonicalPartsFromJson(child))
    }

    return dropped > 0 ? limitPartsCount(parts, dropped) : parts
  }

  const text = prop(value, "text")

  if (typeof text === "string") return [textPart(text)]
  const content = prop(value, "content")

  if (content !== undefined) return canonicalPartsFromJson(content)
  const parts = prop(value, "parts")

  if (parts !== undefined) return canonicalPartsFromJson(parts)
  const typ = typeOf(value)

  if (typ === "input_text" || typ === "output_text" || typ === "text") {
    if (text !== undefined) return [textPart(gString(text))]
  }

  if (isToolType(typ)) return [jsonPart(`tool:${typ}`, value)]
  const kind = geminiToolKind(value)

  if (kind !== "") return [jsonPart(kind, value)]

  if (MEDIA_KEYS.some((key) => prop(value, key) !== undefined)) return [jsonPart("media", value)]

  return [jsonPart("json", value)]
}

// --- turns ---------------------------------------------------------------------------------------------------

const hasCapacity = (turns: CanonicalTurn[]): boolean => turns.length < MAX_CANONICAL_TURNS

const appendTurn = (turns: CanonicalTurn[], role: string, parts: CanonicalPart[]): void => {
  if (!hasCapacity(turns) || parts.length === 0) return
  turns.push({ role, parts: limitParts([], parts) })
}

const appendMessagesTurns = (turns: CanonicalTurn[], root: Json, includeTopLevelSystem: boolean): void => {
  if (includeTopLevelSystem) {
    const system = prop(root, "system")

    if (system !== undefined) appendTurn(turns, "system", canonicalPartsFromJson(system))
  }

  forEachValue(prop(root, "messages"), (message) => {
    if (!hasCapacity(turns)) return false
    const role = canonicalRole(gString(prop(message, "role"))) || "unknown"
    const content = prop(message, "content")
    const parts = canonicalPartsFromJson(content)

    for (const key of ["tool_calls", "tool_call", "function_call", "tool_use"]) {
      const value = prop(message, key)

      if (value !== undefined) parts.push(...canonicalPartsFromJson(value))
    }

    if (parts.length === 0 && content === undefined) parts.push(...canonicalPartsFromJson(message))
    appendTurn(turns, role, parts)

    return true
  })
}

const appendResponsesTurns = (turns: CanonicalTurn[], root: Json): void => {
  const instructions = prop(root, "instructions")

  if (instructions !== undefined) appendTurn(turns, "system", canonicalPartsFromJson(instructions))

  if (!hasCapacity(turns)) return
  const input = prop(root, "input")

  if (input === undefined) return

  if (typeof input === "string") {
    appendTurn(turns, "user", canonicalPartsFromJson(input))

    return
  }

  forEachValue(input, (item) => {
    if (!hasCapacity(turns)) return false
    const typ = typeOf(item)

    if (typ === "reasoning" || typ === "response.output_text") return true
    let role = canonicalRole(gString(prop(item, "role")))

    if (role === "") {
      if (typ.includes("function_call_output") || typ.includes("tool_result")) role = "tool"
      else if (typ.includes("function_call") || typ.includes("tool_call")) role = "assistant"
      else if (typ.includes("compaction")) role = "system"
      else role = "unknown"
    }

    const content = prop(item, "content")
    let parts = canonicalPartsFromJson(content)

    if (parts.length === 0 && content === undefined) parts = canonicalPartsFromJson(item)
    appendTurn(turns, role, parts)

    return true
  })
}

const appendGeminiTurns = (turns: CanonicalTurn[], rootInput: Json): void => {
  let root = rootInput
  const request = prop(root, "request")

  if (request !== undefined && prop(root, "contents") === undefined) root = request
  const cached = prop(root, "cachedContent") ?? prop(root, "cached_content")

  if (cached !== undefined) {
    const resource = textPart(gString(cached))
    resource.kind = "resource"
    appendTurn(turns, "system", [resource])
  }

  const system = prop(root, "systemInstruction") ?? prop(root, "system_instruction")

  if (system !== undefined) appendTurn(turns, "system", canonicalPartsFromJson(system))
  forEachValue(prop(root, "contents"), (content) => {
    if (!hasCapacity(turns)) return false
    const role = canonicalRole(gString(prop(content, "role"))) || "unknown"
    const contentParts = prop(content, "parts")
    let parts = canonicalPartsFromJson(contentParts)

    if (parts.length === 0 && contentParts === undefined) parts = canonicalPartsFromJson(content)
    appendTurn(turns, role, parts)

    return true
  })
}

const defaultInteractionRole = (inherited: string): string => canonicalRole(inherited) || "user"

const appendInteractionValue = (turns: CanonicalTurn[], value: Json | undefined, inheritedRole: string): boolean => {
  if (value === undefined) return true

  if (!hasCapacity(turns)) return false

  if (isJsonArray(value)) {
    for (const child of value) if (!appendInteractionValue(turns, child, inheritedRole)) return false

    return hasCapacity(turns)
  }

  if (!isJsonObject(value)) {
    appendTurn(turns, defaultInteractionRole(inheritedRole), canonicalPartsFromJson(value))

    return hasCapacity(turns)
  }

  const steps = prop(value, "steps")

  if (isJsonArray(steps)) {
    const role = canonicalRole(gString(prop(value, "role"))) || inheritedRole

    for (const child of steps) if (!appendInteractionValue(turns, child, role)) return false

    return hasCapacity(turns)
  }

  const typ = typeOf(value)
  let role = canonicalRole(gString(prop(value, "role")))

  if (role === "") {
    if (typ.includes("system") || typ.includes("developer")) role = "system"
    else if (typ.includes("user")) role = "user"
    else if (typ.includes("model") || typ.includes("assistant")) role = "assistant"
    else if (typ.includes("tool") || typ.includes("function")) role = "tool"
    else role = defaultInteractionRole(inheritedRole)
  }

  const content = prop(value, "content")
  let parts = canonicalPartsFromJson(content)

  if (parts.length === 0 && content === undefined) parts = canonicalPartsFromJson(value)
  appendTurn(turns, role, parts)

  return hasCapacity(turns)
}

const appendInteractionTurns = (turns: CanonicalTurn[], root: Json): void => {
  const system = prop(root, "system_instruction") ?? prop(root, "systemInstruction")

  if (system !== undefined) appendTurn(turns, "system", canonicalPartsFromJson(system))
  appendInteractionValue(turns, prop(root, "input"), "")
}

// --- normalisation -------------------------------------------------------------------------------------------

const normalizeTurn = (input: CanonicalTurn): CanonicalTurn => {
  const role = canonicalRole(input.role)
  const kept: CanonicalPart[] = []

  for (const original of input.parts) {
    if (original.value === "") continue

    const next = {
      ...original,
      kind: goTrimSpace(original.kind).toLowerCase(),
      mime: goTrimSpace(original.mime).toLowerCase()
    }

    if (next.originalSize <= 0) next.originalSize = byteLength(next.value)

    if (next.kind === "text") {
      if (role === "system") next.value = normalizeText(next.value, true)
      else if (!next.sampled) next.value = normalizeText(next.value, false)

      if (!next.sampled) next.originalSize = byteLength(next.value)
    }

    if (next.value !== "") kept.push(next)
  }

  const parts = limitParts([], kept)
  const toolIndexes: number[] = []
  const toolParts: CanonicalPart[] = []
  parts.forEach((candidate, index) => {
    if (candidate.kind.startsWith("tool:") || candidate.kind.includes("function_call")) {
      toolIndexes.push(index)
      toolParts.push(candidate)
    }
  })

  if (toolParts.length > 1) {
    const sorted = toolParts.toSorted((a, b) => compareUtf8(a.value, b.value) || compareUtf8(a.digest, b.digest))
    toolIndexes.forEach((partIndex, index) => {
      parts[partIndex] = sorted[index] as CanonicalPart
    })
  }

  return { role, parts }
}

const normalizeTurns = (turns: CanonicalTurn[]): CanonicalTurn[] => {
  const out: CanonicalTurn[] = []

  for (const turn of turns) {
    const normalized = normalizeTurn(turn)

    if (normalized.role === "" || normalized.parts.length === 0) continue
    out.push(normalized)

    if (out.length >= MAX_CANONICAL_TURNS) break
  }

  return out
}

/** `ExtractCanonicalTurns` for the protocols the Worker accepts. Invalid or empty payloads yield no turns. */
export const extractCanonicalTurns = (format: string, payload: Json | undefined): CanonicalTurn[] => {
  if (payload === undefined || !isJsonObject(payload)) return []
  const turns: CanonicalTurn[] = []

  switch (format.trim().toLowerCase()) {
    case "claude":
      appendMessagesTurns(turns, payload, true)
      break
    case "gemini":
    case "antigravity":
      appendGeminiTurns(turns, payload)
      break
    case "interactions":
      appendInteractionTurns(turns, payload)
      break
    case "openai-response":
    case "codex":
      appendResponsesTurns(turns, payload)
      break
    default:
      appendMessagesTurns(turns, payload, false)
  }

  return normalizeTurns(turns)
}

// --- fingerprints --------------------------------------------------------------------------------------------

const writeField = (hash: ReturnType<typeof createHash>, value: string): void => {
  hash.update(`${byteLength(value)}:`)
  hash.update(value, "utf8")
  hash.update("\0")
}

/** `FastTurnFingerprint`. */
export const fastTurnFingerprint = (input: CanonicalTurn): string => {
  const turn = normalizeTurn(input)
  const hash = createHash("sha256")
  writeField(hash, CANONICAL_TURN_VERSION)
  writeField(hash, turn.role)

  for (const p of turn.parts) {
    writeField(hash, p.kind)
    writeField(hash, p.mime)
    writeField(hash, String(p.originalSize))

    if (turn.role !== "system" || !p.sampled) writeField(hash, p.digest)
    let value = p.value

    if (!p.sampled && (p.originalSize > LARGE_PART_THRESHOLD || byteLength(value) > LARGE_PART_THRESHOLD)) {
      value = sparseSample(value, SPARSE_FINGERPRINT_BYTES)
    }

    writeField(hash, value)
  }

  return hash.digest("hex")
}

/** `EnvironmentDigest`: digest across all system turns. */
export const environmentDigest = (turns: ReadonlyArray<CanonicalTurn>): string => {
  const hash = createHash("sha256")
  let hasSystem = false

  for (const turn of turns) {
    if (canonicalRole(turn.role) === "system") {
      hasSystem = true
      writeField(hash, fastTurnFingerprint(turn))
    }
  }

  return hasSystem ? hash.digest("hex") : ""
}

/** `minimumAffinityPrefixLength`: a prefix of system turns only is no evidence of a shared conversation. */
export const minimumAffinityPrefixLength = (turns: ReadonlyArray<CanonicalTurn>): number => {
  for (const [index, turn] of turns.entries()) if (canonicalRole(turn.role) !== "system") return index + 1

  return 0
}

export interface LcpPrepared {
  readonly fingerprints: ReadonlyArray<string>
  readonly minPrefixLength: number
  readonly tailFingerprints: ReadonlyArray<string>
  readonly envDigest: string
}

/** `PrepareExt`. */
export const prepareFingerprints = (turns: ReadonlyArray<CanonicalTurn>): LcpPrepared => {
  if (turns.length === 0) return { fingerprints: [], minPrefixLength: 0, tailFingerprints: [], envDigest: "" }
  const limit = Math.min(turns.length, MAX_CANONICAL_TURNS)
  const fingerprints = turns.slice(0, limit).map(fastTurnFingerprint)
  const start = Math.max(0, turns.length - MAX_COMPACTION_PROBE_WINDOW)
  const tailFingerprints = turns.slice(start).map(fastTurnFingerprint)

  return {
    fingerprints,
    minPrefixLength: minimumAffinityPrefixLength(turns),
    tailFingerprints,
    envDigest: environmentDigest(turns)
  }
}

/** Export for tests: the canonical parts of a value. */
export const canonicalPartsOf = canonicalPartsFromJson
