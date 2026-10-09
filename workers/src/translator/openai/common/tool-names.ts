/**
 * Go sources: internal/util/translator.go (FixJSON, CanonicalToolName, ToolNameMapFromClaudeRequest, MapToolName)
 * and internal/util/claude_tool_id.go (SanitizeClaudeToolID).
 */
import { get, type Json } from "../../../json/index.ts"
import { getStr, isArr } from "./read.ts"

/**
 * `FixJSON`: converts single-quoted strings to double-quoted ones (best effort) so partially malformed tool
 * arguments can still be parsed. Everything else is forwarded unchanged.
 */
export const fixJson = (input: string): string => {
  let out = ""
  let inDouble = false
  let inSingle = false
  let escaped = false
  const runes = Array.from(input)
  for (let i = 0; i < runes.length; i++) {
    const r = runes[i] as string
    if (inDouble) {
      out += r
      if (escaped) {
        escaped = false
        continue
      }
      if (r === "\\") {
        escaped = true
        continue
      }
      if (r === '"') inDouble = false
      continue
    }
    if (inSingle) {
      if (escaped) {
        escaped = false
        switch (r) {
          case "n":
          case "r":
          case "t":
          case "b":
          case "f":
          case "/":
          case '"':
            out += `\\${r}`
            break
          case "\\":
            out += "\\\\"
            break
          case "'":
            out += "'"
            break
          case "u": {
            out += "\\u"
            for (let k = 0; k < 4 && i + 1 < runes.length; k++) {
              const peek = runes[i + 1] as string
              if (/^[0-9a-fA-F]$/.test(peek)) {
                out += peek
                i++
              } else break
            }
            break
          }
          default:
            out += `\\${r}`
        }
        continue
      }
      if (r === "\\") {
        escaped = true
        continue
      }
      if (r === "'") {
        out += '"'
        inSingle = false
        continue
      }
      out += r === '"' ? '\\"' : r
      continue
    }
    if (r === '"') {
      inDouble = true
      out += r
      continue
    }
    if (r === "'") {
      inSingle = true
      out += '"'
      continue
    }
    out += r
  }
  if (inSingle) out += '"'
  return out
}

/** `CanonicalToolName`. */
export const canonicalToolName = (name: string): string => name.trim().replace(/^_+/, "").toLowerCase()

/** `ToolNameMapFromClaudeRequest`: canonical name -> original name (undefined when the request has no tools). */
export const toolNameMapFromClaudeRequest = (request: Json | undefined): Map<string, string> | undefined => {
  if (request === undefined) return undefined
  const tools = get(request, "tools")
  if (!isArr(tools)) return undefined
  const out = new Map<string, string>()
  for (const tool of tools) {
    let name = getStr(tool, "name").trim()
    if (name === "") name = getStr(tool, "function.name").trim()
    if (name === "") continue
    const key = canonicalToolName(name)
    if (key === "") continue
    if (!out.has(key)) out.set(key, name)
  }
  return out.size === 0 ? undefined : out
}

/** `MapToolName`. */
export const mapToolName = (toolNameMap: Map<string, string> | undefined, name: string): string => {
  if (name === "" || toolNameMap === undefined) return name
  const mapped = toolNameMap.get(canonicalToolName(name))
  return mapped !== undefined && mapped !== "" ? mapped : name
}

let claudeToolUseIdCounter = 0

/** `SanitizeClaudeToolID`: `^[a-zA-Z0-9_-]+$`, with a generated fallback for empty ids. */
export const sanitizeClaudeToolId = (id: string): string => {
  const s = id.replace(/[^a-zA-Z0-9_-]/gu, "_")
  if (s !== "") return s
  claudeToolUseIdCounter += 1
  return `toolu_${Date.now()}000000_${claudeToolUseIdCounter}`
}
