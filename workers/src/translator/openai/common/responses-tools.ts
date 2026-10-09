/**
 * Responses tool descriptors shared by the Interactions translators.
 *
 * Go source: internal/util/responses_tools.go (QualifyResponsesNamespaceToolName, CollectResponsesToolDescriptors,
 * CollectResponsesToolWinners, UnwrapResponsesCustomToolInput, ResponsesToolIdentity). The Gemini-specific
 * declaration builders of that file are not needed here.
 */
import { get, type Json } from "../../../json/index.ts"
import { isApplyPatchCustomTool } from "./apply-patch.ts"
import { getStr, isArr } from "./read.ts"

/** Resolved identity of a tool in OpenAI Responses format (`util.ResponsesToolIdentity`). */
export interface ResponsesToolIdentity {
  readonly name: string
  readonly namespace: string
  readonly custom: boolean
  /** Resolved from the winning original declaration, never from the upstream name. */
  readonly applyPatch: boolean
}

export interface ResponsesToolDescriptor {
  /** Qualified name (`functions__exec`). */
  readonly name: string
  readonly localName: string
  readonly namespace: string
  readonly toolType: string
  readonly tool: Json
  /** 0 for top-level tools, 1 for `additional_tools`. */
  readonly sourcePriority: number
  readonly direct: boolean
  readonly order: number
}

/** `util.QualifyResponsesNamespaceToolName` (no length cap). */
export const qualifyResponsesNamespaceToolName = (namespaceName: string, childName: string): string => {
  const child = childName.trim()
  const ns = namespaceName.trim()
  if (child === "" || ns === "" || child.startsWith("mcp__")) return child
  if (child === ns || child.startsWith(`${ns}__`)) return child
  if (ns.endsWith("__")) return ns + child
  return `${ns}__${child}`
}

const toolNameOf = (tool: Json | undefined): string => {
  const name = getStr(tool, "name").trim()
  return name !== "" ? name : getStr(tool, "function.name").trim()
}

/** `util.ResponsesToolDescription`. */
export const responsesToolDescriptionOf = (tool: Json | undefined): string => {
  const description = getStr(tool, "description")
  return description !== "" ? description : getStr(tool, "function.description")
}

export { responsesToolParameters as responsesToolParametersOf } from "../openai/responses/tools.ts"

/** `util.CollectResponsesToolDescriptors` over a request root (`tools` plus `additional_tools` input items). */
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
  ): void => {
    if (name === "") return
    descriptors.push({ name, localName, namespace, toolType, tool, sourcePriority, direct, order: descriptors.length })
  }
  const appendChildren = (namespaceTool: Json, sourcePriority: number): void => {
    const namespaceName = getStr(namespaceTool, "name").trim()
    let children = get(namespaceTool, "tools")
    if (!isArr(children)) children = get(namespaceTool, "children")
    if (!isArr(children)) return
    for (const child of children) {
      const childName = toolNameOf(child)
      if (childName === "") continue
      const qualified = qualifyResponsesNamespaceToolName(namespaceName, childName)
      switch (getStr(child, "type").trim()) {
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
  const sources: Array<{ tools: readonly Json[]; priority: number }> = []
  const tools = get(root, "tools")
  if (isArr(tools)) sources.push({ tools, priority: 0 })
  const input = get(root, "input")
  if (isArr(input)) {
    for (const item of input) {
      if (getStr(item, "type") !== "additional_tools") continue
      const extra = get(item, "tools")
      if (isArr(extra)) sources.push({ tools: extra, priority: 1 })
    }
  }
  for (const source of sources) {
    for (const tool of source.tools) {
      const toolType = getStr(tool, "type").trim()
      if (toolType === "" || toolType === "function") {
        const name = toolNameOf(tool)
        append(tool, name, name, "", "function", source.priority, true)
      } else if (toolType === "custom") {
        const name = toolNameOf(tool)
        append(tool, name, name, "", "custom", source.priority, true)
      } else if (toolType === "namespace") {
        appendChildren(tool, source.priority)
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

/** `util.CollectResponsesToolWinners`: the winning descriptor of every qualified name (insertion ordered). */
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

export const isApplyPatchDescriptor = (descriptor: ResponsesToolDescriptor): boolean => isApplyPatchCustomTool(descriptor.tool)
