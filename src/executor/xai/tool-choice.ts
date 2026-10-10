/**
 * xAI `tool_choice` handling, tool limit, X Search injection and the `web_search` client function alias.
 *
 * Go source: internal/runtime/executor/xai_executor_request.go (normalizeXAIToolChoiceForTools,
 * normalizeXAINamespaceToolChoiceWithFold, pruneXAIOrphanedToolChoice, normalizeXAIForcedHostedToolChoice,
 * xaiToolChoiceRequiresHostedToolOnly, clampXAIToolsLimit, ensureXAINativeXSearchTool, xaiHasClientWebSearchFunction,
 * xaiResolveClientWebSearchAlias, aliasXAIClientWebSearchFunction, aliasXAIClientWebSearchInput).
 * All functions mutate the parsed body in place.
 */
import { asString, del, get, isJsonArray, isJsonObject, type Json, set } from "../../json/index.ts"
import {
  hasFunctionToolNamed,
  type NamespaceRefs,
  qualifyNamespaceToolName,
  requestHasNativeXSearch,
  toolLists
} from "./tools.ts"

const trimmed = (value: Json | undefined, path: string): string => asString(get(value, path)).trim()

const arrayAt = (value: Json | undefined, path: string): Json[] => {
  const found = get(value, path)
  return isJsonArray(found) ? found : []
}

/** `normalizeXAIToolChoiceForTools`: xAI rejects `tool_choice` (and `parallel_tool_calls`) without tools. */
export const normalizeToolChoiceForTools = (body: Json): Json => {
  const tools = get(body, "tools")
  let hasTools = isJsonArray(tools) && tools.length > 0
  if (!hasTools) {
    hasTools = arrayAt(body, "input").some(
      (item) => asString(get(item, "type")) === "additional_tools" && arrayAt(item, "tools").length > 0
    )
  }
  if (hasTools) return body
  if (tools !== undefined) del(body, "tools")
  if (get(body, "tool_choice") !== undefined) del(body, "tool_choice")
  if (get(body, "parallel_tool_calls") !== undefined) del(body, "parallel_tool_calls")
  return body
}

/** `normalizeXAINamespaceToolChoiceWithFold`: qualifies namespaced function choices like the flattened tools. */
export const normalizeNamespaceToolChoice = (body: Json, shouldFold: boolean): Json => {
  const normalizeAt = (path: string): void => {
    const choice = get(body, path)
    if (!isJsonObject(choice) || asString(choice["type"]) !== "function") return
    const namespaceName = trimmed(choice, "namespace")
    const toolName = trimmed(choice, "name")
    if (namespaceName === "") return
    const qualified = qualifyNamespaceToolName(namespaceName, toolName)
    const target = hasFunctionToolNamed(body, namespaceName)
      ? namespaceName
      : hasFunctionToolNamed(body, qualified)
        ? qualified
        : shouldFold
          ? namespaceName
          : qualified
    if (target === "") return
    set(body, `${path}.name`, target)
    del(body, `${path}.namespace`)
  }
  normalizeAt("tool_choice")
  for (const index of arrayAt(body, "tool_choice.tools").keys()) normalizeAt(`tool_choice.tools.${index}`)
  return body
}

// ---------------------------------------------------------------------------------------------------------------
// Orphaned choices
// ---------------------------------------------------------------------------------------------------------------

const choiceKey = (toolType: string, name: string): string => `${toolType}\u0000${name}`

const availableChoiceKeys = (body: Json): Set<string> => {
  const keys = new Set<string>()
  for (const list of toolLists(body)) {
    for (const tool of list) {
      const toolType = trimmed(tool, "type")
      if (toolType === "") continue
      if (toolType === "function" || toolType === "custom") {
        const name = trimmed(tool, "name")
        if (name === "") continue
        keys.add(choiceKey(toolType, name))
      } else {
        keys.add(choiceKey(toolType, ""))
      }
    }
  }
  return keys
}

const choiceMatches = (choice: Json, available: ReadonlySet<string>): boolean => {
  const toolType = trimmed(choice, "type")
  if (toolType === "") return false
  let name = ""
  if (toolType === "function" || toolType === "custom") {
    name = trimmed(choice, "name")
    if (name === "") return false
  }
  return available.has(choiceKey(toolType, name))
}

/** `pruneXAIOrphanedToolChoice`: drops choices that point at tools the normalisation removed. */
export const pruneOrphanedToolChoice = (body: Json): Json => {
  const choice = get(body, "tool_choice")
  if (choice === undefined || !isJsonObject(choice)) return body
  const available = availableChoiceKeys(body)
  const choiceType = trimmed(choice, "type")
  if (choiceType === "allowed_tools") {
    const allowed = choice["tools"]
    if (!isJsonArray(allowed)) return del(body, "tool_choice")
    const filtered = allowed.filter((tool) => choiceMatches(tool, available))
    if (filtered.length === allowed.length) return body
    return filtered.length === 0 ? del(body, "tool_choice") : set(body, "tool_choice.tools", filtered)
  }
  if (choiceType === "" || choiceMatches(choice, available)) return body
  return del(body, "tool_choice")
}

// ---------------------------------------------------------------------------------------------------------------
// Hosted tools
// ---------------------------------------------------------------------------------------------------------------

const keepOnlyHostedTools = (body: Json, toolType: string): void => {
  const tools = get(body, "tools")
  if (!isJsonArray(tools)) return
  const kept = tools.filter((tool) => trimmed(tool, "type") === toolType)
  if (kept.length === 0 || kept.length === tools.length) return
  set(body, "tools", kept)
}

/** `normalizeXAIForcedHostedToolChoice` for `web_search` and `image_generation`. */
const normalizeForcedHostedToolChoice = (body: Json, toolType: string): Json => {
  const choice = get(body, "tool_choice")
  if (!isJsonObject(choice)) return body
  const choiceType = trimmed(choice, "type")
  if (choiceType === toolType) {
    keepOnlyHostedTools(body, toolType)
    return set(body, "tool_choice", "required")
  }
  if (choiceType !== "allowed_tools") return body
  const allowed = choice["tools"]
  if (!isJsonArray(allowed)) return body
  const filtered = allowed.filter((tool) => trimmed(tool, "type") !== toolType)
  if (filtered.length === allowed.length) return body
  if (filtered.length === 0) {
    const mode = trimmed(choice, "mode") === "auto" ? "auto" : "required"
    keepOnlyHostedTools(body, toolType)
    return set(body, "tool_choice", mode)
  }
  return set(body, "tool_choice.tools", filtered)
}

export const normalizeForcedWebSearchToolChoice = (body: Json): Json =>
  normalizeForcedHostedToolChoice(body, "web_search")

export const normalizeForcedImageGenerationToolChoice = (body: Json): Json =>
  normalizeForcedHostedToolChoice(body, "image_generation")

const choiceRequiresHostedToolOnly = (body: Json, toolType: string): boolean => {
  const choice = get(body, "tool_choice")
  if (choice !== "required" && choice !== "auto") return false
  const tools = get(body, "tools")
  return isJsonArray(tools) && tools.length > 0 && tools.every((tool) => trimmed(tool, "type") === toolType)
}

/** `xaiToolChoiceRequiresHostedToolOnlyAny`. */
export const toolChoiceRequiresHostedToolOnly = (body: Json): boolean =>
  choiceRequiresHostedToolOnly(body, "image_generation") || choiceRequiresHostedToolOnly(body, "web_search")

/** `clampXAIToolsLimit`: dispatchers first, then regular tools up to `maxTools`. */
export const clampToolsLimit = (body: Json, maxTools: number, refs: NamespaceRefs): Json => {
  const tools = get(body, "tools")
  if (!isJsonArray(tools) || tools.length <= maxTools) return body
  const dispatchers: Json[] = []
  const regular: Json[] = []
  for (const tool of tools) {
    const ref = refs.get(trimmed(tool, "name"))
    if (ref !== undefined && ref.isDispatcher) dispatchers.push(tool)
    else regular.push(tool)
  }
  const capped =
    dispatchers.length >= maxTools
      ? dispatchers.slice(0, maxTools)
      : [...dispatchers, ...regular.slice(0, maxTools - dispatchers.length)]
  set(body, "tools", capped)
  pruneOrphanedToolChoice(body)
  return normalizeToolChoiceForTools(body)
}

/** `ensureXAINativeXSearchTool`: appends the native X Search tool (and allows it in `allowed_tools`). */
export const ensureNativeXSearchTool = (body: Json): Json => {
  if (!requestHasNativeXSearch(body)) {
    const tools = get(body, "tools")
    if (isJsonArray(tools)) tools.push({ type: "x_search" })
    else set(body, "tools", [{ type: "x_search" }])
  }
  const choice = get(body, "tool_choice")
  if (!isJsonObject(choice) || asString(choice["type"]) !== "allowed_tools") return body
  const allowed = choice["tools"]
  if (!isJsonArray(allowed)) {
    choice["tools"] = [{ type: "x_search" }]
  } else if (!allowed.some((tool) => trimmed(tool, "type") === "x_search")) {
    allowed.push({ type: "x_search" })
  }
  return body
}

// ---------------------------------------------------------------------------------------------------------------
// Client function named web_search
// ---------------------------------------------------------------------------------------------------------------

export const CLIENT_WEB_SEARCH_ALIAS = "clientfn_web_search"

/** `xaiHasClientWebSearchFunction`: an un-namespaced client function/custom tool named `web_search`. */
export const hasClientWebSearchFunction = (body: Json, refs: NamespaceRefs): boolean =>
  arrayAt(body, "tools").some((tool) => {
    const type = trimmed(tool, "type")
    return (
      (type === "function" || type === "custom") && trimmed(tool, "name") === "web_search" && !refs.has("web_search")
    )
  })

const bodyHasToolNamed = (body: Json, name: string): boolean => {
  for (const tool of arrayAt(body, "tools")) {
    if (trimmed(tool, "name") === name) return true
    if (arrayAt(tool, "tools").some((child) => trimmed(child, "name") === name)) return true
  }
  return arrayAt(body, "input").some((item) => trimmed(item, "name") === name)
}

/** `xaiResolveClientWebSearchAlias`: an alias that does not collide with any client tool. */
export const resolveClientWebSearchAlias = (body: Json): string => {
  if (!bodyHasToolNamed(body, CLIENT_WEB_SEARCH_ALIAS)) return CLIENT_WEB_SEARCH_ALIAS
  for (let index = 1; ; index++) {
    const next = `${CLIENT_WEB_SEARCH_ALIAS}_${index}`
    if (!bodyHasToolNamed(body, next)) return next
  }
}

/** `aliasXAIClientWebSearchInput`: renames replayed calls in the input history. */
export const aliasClientWebSearchInput = (body: Json, alias: string, refs: NamespaceRefs): Json => {
  if (alias === "" || refs.has("web_search")) return body
  for (const [index, item] of arrayAt(body, "input").entries()) {
    const type = trimmed(item, "type")
    if (
      (type === "function_call" || type === "custom_tool_call" || type === "function_call_output") &&
      trimmed(item, "name") === "web_search" &&
      trimmed(item, "namespace") === ""
    ) {
      set(body, `input.${index}.name`, alias)
    }
  }
  return body
}

/** `aliasXAIClientWebSearchFunction`: tools, `tool_choice` and input history. */
export const aliasClientWebSearchFunction = (body: Json, alias: string, refs: NamespaceRefs): Json => {
  if (alias === "") return body
  const isDispatcher = refs.has("web_search")
  for (const [index, tool] of arrayAt(body, "tools").entries()) {
    const type = trimmed(tool, "type")
    if ((type === "function" || type === "custom") && trimmed(tool, "name") === "web_search" && !isDispatcher) {
      set(body, `tools.${index}.name`, alias)
    }
  }
  const choice = get(body, "tool_choice")
  if (isJsonObject(choice)) {
    if (trimmed(choice, "function.name") === "web_search" && get(choice, "function.name") !== undefined) {
      if (trimmed(choice, "function.namespace") === "" && !isDispatcher) set(body, "tool_choice.function.name", alias)
    }
    if (get(choice, "name") !== undefined && trimmed(choice, "name") === "web_search") {
      const choiceType = trimmed(choice, "type")
      if (
        trimmed(choice, "namespace") === "" &&
        (choiceType === "function" || choiceType === "tool") &&
        !isDispatcher
      ) {
        set(body, "tool_choice.name", alias)
      }
    }
    for (const [index, allowedTool] of arrayAt(choice, "tools").entries()) {
      if (trimmed(allowedTool, "namespace") !== "" || isDispatcher) continue
      const allowedType = trimmed(allowedTool, "type")
      const allowedName = trimmed(allowedTool, "name")
      if (
        ((allowedType === "function" || allowedType === "tool") && allowedName === "web_search") ||
        (allowedName === "web_search" && allowedType !== "web_search")
      ) {
        set(body, `tool_choice.tools.${index}.name`, alias)
      }
    }
  }
  return aliasClientWebSearchInput(body, alias, refs)
}
