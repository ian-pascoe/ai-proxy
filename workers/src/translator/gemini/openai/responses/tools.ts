/**
 * Responses tools -> Gemini function declarations, tool choice and reverse identity mapping.
 *
 * Go source: internal/util/responses_tools.go (BuildGeminiFunctionDeclarations, ResponsesToolReverseIdentityMap,
 * MapResponsesToolName, ConvertResponsesToolChoiceToGemini, UnwrapResponsesCustomToolInput).
 */
import { createHash } from "node:crypto"
import { asString, get, isJsonObject, type Json, type JsonObject, set, tryParseJson } from "../../../../json/index.ts"
import { applyPatchDescription, applyPatchParameters, isApplyPatchCustomTool } from "../../../common/apply-patch.ts"
import {
  collectResponsesToolDescriptors,
  collectResponsesToolWinners,
  qualifyResponsesNamespaceToolName,
  type ResponsesToolDescriptor
} from "../../../common/responses-tools.ts"
import { sanitizeFunctionName } from "../../util/claude.ts"
import { cleanJsonSchemaForGeminiJsonSchema } from "../../util/json-schema.ts"

export interface ResponsesToolIdentity {
  readonly name: string
  readonly namespace: string
  readonly custom: boolean
  /** Resolved from the winning original declaration, never from the upstream name. */
  readonly applyPatch: boolean
}

const sha256Hex = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex")

const compareStrings = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

const disambiguateSanitizedName = (base: string, original: string, used: ReadonlyMap<string, string>): string => {
  for (let attempt = 0; ; attempt++) {
    const suffix = `_${sha256Hex(`${original}\u0000${attempt}`).slice(0, 12)}`
    const maxPrefix = 64 - suffix.length
    const prefix = base.length > maxPrefix ? base.slice(0, maxPrefix) : base
    const candidate = prefix + suffix
    if (!used.has(candidate)) return candidate
  }
}

/** `sanitizeResponsesToolNames`. */
const sanitizeResponsesToolNames = (names: readonly string[]): Map<string, string> => {
  const unique = new Set<string>()
  const baseCounts = new Map<string, number>()
  for (const name of names) {
    if (name === "" || unique.has(name)) continue
    unique.add(name)
    const base = sanitizeFunctionName(name)
    baseCounts.set(base, (baseCounts.get(base) ?? 0) + 1)
  }
  const out = new Map<string, string>()
  const used = new Map<string, string>()
  for (const name of [...unique].toSorted(compareStrings)) {
    const base = sanitizeFunctionName(name)
    const mapped =
      (baseCounts.get(base) ?? 0) > 1 || used.has(base) ? disambiguateSanitizedName(base, name, used) : base
    out.set(name, mapped)
    used.set(mapped, name)
  }
  return out
}

const toolDescription = (tool: Json | undefined): string => {
  const description = asString(get(tool, "description"))
  return description !== "" ? description : asString(get(tool, "function.description"))
}

const toolParameters = (tool: Json | undefined): Json | undefined => {
  for (const path of [
    "parameters",
    "parametersJsonSchema",
    "input_schema",
    "function.parameters",
    "function.parametersJsonSchema"
  ]) {
    const parameters = get(tool, path)
    if (parameters !== undefined) return parameters
  }
  return undefined
}

export interface GeminiFunctionDeclarations {
  readonly declarations: Json[]
  readonly forwardMap: Map<string, string>
  readonly reverseMap: Map<string, ResponsesToolIdentity>
}

/** `BuildGeminiFunctionDeclarations`. */
export const buildGeminiFunctionDeclarations = (root: Json | undefined): GeminiFunctionDeclarations => {
  const descriptors = collectResponsesToolDescriptors(root)
  const winners = collectResponsesToolWinners(root)
  const seen = new Set<string>()
  const winning: ResponsesToolDescriptor[] = []
  for (const descriptor of descriptors) {
    const winner = winners.get(descriptor.name)
    if (winner === undefined || winner.order !== descriptor.order) continue
    if (seen.has(descriptor.name)) continue
    seen.add(descriptor.name)
    winning.push(descriptor)
  }
  const forwardMap = new Map<string, string>()
  const reverseMap = new Map<string, ResponsesToolIdentity>()
  const declarations: Json[] = []
  if (winning.length === 0) return { declarations, forwardMap, reverseMap }
  const sanitized = sanitizeResponsesToolNames(winning.map((descriptor) => descriptor.name))
  for (const descriptor of winning) {
    const mapped = sanitized.get(descriptor.name)
    const geminiName = mapped !== undefined && mapped !== "" ? mapped : sanitizeFunctionName(descriptor.name)
    forwardMap.set(descriptor.name, geminiName)
    if (
      descriptor.localName !== "" &&
      descriptor.localName !== descriptor.name &&
      !forwardMap.has(descriptor.localName)
    ) {
      forwardMap.set(descriptor.localName, geminiName)
    }
    const applyPatch = isApplyPatchCustomTool(descriptor.tool)
    const identity: ResponsesToolIdentity = {
      name: descriptor.localName,
      namespace: descriptor.namespace,
      custom: descriptor.toolType === "custom",
      applyPatch
    }
    reverseMap.set(geminiName, identity)
    if (descriptor.name !== geminiName) reverseMap.set(descriptor.name, identity)

    const declaration: JsonObject = { name: geminiName, description: "", parametersJsonSchema: {} }
    const description = toolDescription(descriptor.tool)
    if (description !== "") declaration["description"] = description
    if (applyPatch) {
      declaration["description"] = applyPatchDescription(descriptor.tool)
      declaration["parametersJsonSchema"] = applyPatchParameters()
    } else if (descriptor.toolType === "custom") {
      declaration["parametersJsonSchema"] = {
        type: "object",
        properties: { input: { type: "string" } },
        required: ["input"]
      }
    } else {
      const params = toolParameters(descriptor.tool)
      if (params !== undefined) declaration["parametersJsonSchema"] = cleanJsonSchemaForGeminiJsonSchema(params)
    }
    declarations.push(declaration)
  }
  return { declarations, forwardMap, reverseMap }
}

/** `ResponsesToolReverseIdentityMap`: Gemini function name -> Responses identity (empty for unusable input). */
export const responsesToolReverseIdentityMap = (request: Json | undefined): Map<string, ResponsesToolIdentity> => {
  if (request === undefined) return new Map()
  let root: Json | undefined = request
  const nested = get(request, "request")
  if (
    nested !== undefined &&
    (get(nested, "model") !== undefined || get(nested, "input") !== undefined || get(nested, "tools") !== undefined)
  ) {
    root = nested
  }
  return buildGeminiFunctionDeclarations(root).reverseMap
}

/** `MapResponsesToolName`. */
export const mapResponsesToolName = (forwardMap: ReadonlyMap<string, string> | undefined, name: string): string => {
  const mapped = forwardMap?.get(name)
  return mapped !== undefined && mapped !== "" ? mapped : sanitizeFunctionName(name)
}

/** `ConvertResponsesToolChoiceToGemini`: the `functionCallingConfig` object, or `undefined`. */
export const convertResponsesToolChoiceToGemini = (
  toolChoice: Json | undefined,
  forwardMap: ReadonlyMap<string, string> | undefined
): JsonObject | undefined => {
  if (toolChoice === undefined) return undefined
  let mode = ""
  const allowed: string[] = []
  const modeOf = (value: string): string => {
    switch (value) {
      case "none":
        return "NONE"
      case "auto":
        return "AUTO"
      case "required":
      case "any":
        return "ANY"
      default:
        return ""
    }
  }
  if (typeof toolChoice === "string") {
    mode = modeOf(toolChoice.trim().toLowerCase())
  } else if (isJsonObject(toolChoice)) {
    const toolType = asString(toolChoice["type"]).trim().toLowerCase()
    mode = modeOf(toolType)
    if (["function", "custom", "tool", ""].includes(toolType)) {
      mode = "ANY"
      const trimmed = (path: string): string => asString(get(toolChoice, path)).trim()
      let name = trimmed("name") || trimmed("function.name") || trimmed("custom.name")
      const namespace = trimmed("namespace") || trimmed("function.namespace") || trimmed("custom.namespace")
      if (namespace !== "") name = qualifyResponsesNamespaceToolName(namespace, name)
      if (name !== "") allowed.push(mapResponsesToolName(forwardMap, name))
    }
  }
  if (mode === "") return undefined
  const config: JsonObject = { mode }
  if (allowed.length > 0) set(config, "allowedFunctionNames", allowed)
  return config
}

/** `UnwrapResponsesCustomToolInput`: the raw input string of custom tool arguments (JSON envelope or plain text). */
export const unwrapResponsesCustomToolInput = (argumentsText: string): string => {
  const trimmed = argumentsText.trim()
  if (trimmed === "" || trimmed === "{}") return ""
  const parsed = tryParseJson(trimmed)
  if (parsed !== undefined) {
    const input = get(parsed, "input")
    if (input !== undefined) return typeof input === "string" ? input : JSON.stringify(input)
    if (typeof parsed === "string") return parsed
  }
  return trimmed
}
