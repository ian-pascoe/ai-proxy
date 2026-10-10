/**
 * Responses tool declarations: namespace qualification and per-name winners.
 *
 * Go source: internal/util/responses_tools.go (QualifyResponsesNamespaceToolName, CollectResponsesToolDescriptors,
 * CollectResponsesToolWinners, UnwrapResponsesCustomToolInput, ResponsesToolIdentity, ResponsesToolDescription). The
 * Gemini declaration builders of that file live in `translator/gemini/openai/responses/tools.ts`.
 */
import { asString, get, isJsonArray, type Json } from "../../json/index.ts"
import { isApplyPatchCustomTool } from "./apply-patch.ts"

/** Resolved identity of a tool in OpenAI Responses format (`util.ResponsesToolIdentity`). */
export interface ResponsesToolIdentity {
  readonly name: string
  readonly namespace: string
  readonly custom: boolean
  /** Resolved from the winning original declaration, never from the upstream name. */
  readonly applyPatch: boolean
}

export interface ResponsesToolDescriptor {
  /** Qualified name (e.g. `functions__exec`). */
  readonly name: string
  readonly localName: string
  readonly namespace: string
  readonly toolType: string
  readonly tool: Json
  /** 0 for top-level tools, 1 for `additional_tools` input items. */
  readonly sourcePriority: number
  /** Declared directly (not as a namespace child). */
  readonly direct: boolean
  readonly order: number
}

/** `QualifyResponsesNamespaceToolName`. */
export const qualifyResponsesNamespaceToolName = (namespaceName: string, childName: string): string => {
  const child = childName.trim()
  const namespace = namespaceName.trim()

  if (child === "" || namespace === "" || child.startsWith("mcp__")) return child

  if (child === namespace || child.startsWith(`${namespace}__`)) return child

  if (namespace.endsWith("__")) return namespace + child

  return `${namespace}__${child}`
}

const responsesToolName = (tool: Json | undefined): string => {
  const name = asString(get(tool, "name")).trim()

  return name !== "" ? name : asString(get(tool, "function.name")).trim()
}

/** `util.ResponsesToolDescription`. */
export const responsesToolDescriptionOf = (tool: Json | undefined): string => {
  const description = asString(get(tool, "description"))

  return description !== "" ? description : asString(get(tool, "function.description"))
}

export { responsesToolParameters as responsesToolParametersOf } from "../openai/openai/responses/tools.ts"

const toolSources = (root: Json | undefined): Array<{ readonly tools: Json[]; readonly priority: number }> => {
  const sources: Array<{ readonly tools: Json[]; readonly priority: number }> = []
  const tools = get(root, "tools")

  if (isJsonArray(tools)) sources.push({ tools, priority: 0 })
  const input = get(root, "input")

  if (isJsonArray(input)) {
    for (const item of input) {
      if (asString(get(item, "type")) !== "additional_tools") continue
      const extra = get(item, "tools")

      if (isJsonArray(extra)) sources.push({ tools: extra, priority: 1 })
    }
  }

  return sources
}

/** `CollectResponsesToolDescriptors`. */
export const collectResponsesToolDescriptors = (root: Json | undefined): ResponsesToolDescriptor[] => {
  const descriptors: ResponsesToolDescriptor[] = []

  const append = (
    tool: Json,
    name: string,
    localName: string,
    namespace: string,
    toolType: string,
    sourcePriority: number,
    direct: boolean
  ) => {
    if (name === "") return
    descriptors.push({ name, localName, namespace, toolType, tool, sourcePriority, direct, order: descriptors.length })
  }

  const appendNamespaceChildren = (namespaceTool: Json, sourcePriority: number) => {
    const namespaceName = asString(get(namespaceTool, "name")).trim()
    let children = get(namespaceTool, "tools")

    if (!isJsonArray(children)) children = get(namespaceTool, "children")

    if (!isJsonArray(children)) return

    for (const child of children) {
      const childName = responsesToolName(child)

      if (childName === "") continue
      const qualified = qualifyResponsesNamespaceToolName(namespaceName, childName)

      switch (asString(get(child, "type")).trim()) {
        case "":
        case "function":
          append(child, qualified, childName, namespaceName, "function", sourcePriority, false)
          break
        case "custom":
          append(child, qualified, childName, namespaceName, "custom", sourcePriority, false)
          break
      }
    }
  }

  for (const source of toolSources(root)) {
    for (const tool of source.tools) {
      switch (asString(get(tool, "type")).trim()) {
        case "":
        case "function": {
          const name = responsesToolName(tool)
          append(tool, name, name, "", "function", source.priority, true)
          break
        }

        case "custom": {
          const name = responsesToolName(tool)
          append(tool, name, name, "", "custom", source.priority, true)
          break
        }

        case "namespace":
          appendNamespaceChildren(tool, source.priority)
          break
      }
    }
  }

  return descriptors
}

const precedes = (left: ResponsesToolDescriptor, right: ResponsesToolDescriptor): boolean => {
  if (left.sourcePriority !== right.sourcePriority) return left.sourcePriority < right.sourcePriority

  if (left.direct !== right.direct) return left.direct

  return left.order < right.order
}

/** `CollectResponsesToolWinners`: the winning descriptor per qualified tool name. */
export const collectResponsesToolWinners = (root: Json | undefined): Map<string, ResponsesToolDescriptor> => {
  const winners = new Map<string, ResponsesToolDescriptor>()

  for (const descriptor of collectResponsesToolDescriptors(root)) {
    const current = winners.get(descriptor.name)

    if (current === undefined || precedes(descriptor, current)) winners.set(descriptor.name, descriptor)
  }

  return winners
}

/** `util.UnwrapResponsesCustomToolInput`. */
export const unwrapResponsesCustomToolInput = (argumentsText: string): string => {
  const trimmed = argumentsText.trim()

  if (trimmed === "" || trimmed === "{}") return ""
  let parsed: Json

  try {
    parsed = JSON.parse(trimmed) as Json
  } catch {
    return trimmed
  }

  if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
    const input = parsed.input

    if (input !== undefined) return typeof input === "string" ? input : JSON.stringify(input)
  }

  if (typeof parsed === "string") return parsed

  return trimmed
}

export const isApplyPatchDescriptor = (descriptor: ResponsesToolDescriptor): boolean =>
  isApplyPatchCustomTool(descriptor.tool)
