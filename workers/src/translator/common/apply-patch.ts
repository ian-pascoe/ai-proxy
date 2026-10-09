/**
 * Codex `apply_patch` custom-tool bridge helpers.
 *
 * Go source: internal/client/codex/apply-patch/apply_patch.go (IsCustomTool, Parameters, Description, WrapInput,
 * UnwrapInput, EscapeInputFragment).
 */
import { asString, get, isJsonObject, type Json, tryParseJson } from "../../json/index.ts"
import { goMarshal } from "../../http/json-text.ts"

const PARAMETERS =
  '{"type":"object","properties":{"input":{"type":"string","description":"The complete apply_patch patch text."}},"required":["input"],"additionalProperties":false}'

const PATCH_INSTRUCTIONS = `Call this function with a JSON object whose input field contains the complete patch text.
Use the Codex apply_patch format, not a conventional git unified diff.
Start with *** Begin Patch and end with *** End Patch.
Use *** Add File: path, *** Delete File: path, or *** Update File: path.
Every added-file content line starts with +.
For updates, use @@; context lines start with one space, removed lines with -, and added lines with +.
Use *** Move to: path for a rename and *** End of File when required by the patch grammar.
Example input:
*** Begin Patch
*** Update File: src/main.go
@@
-old
+new
*** End Patch`

/** `IsCustomTool`: a `custom` tool named exactly `apply_patch` (name trimmed). */
export const isApplyPatchCustomTool = (tool: Json | undefined): boolean =>
  get(tool, "type") === "custom" && asString(get(tool, "name")).trim() === "apply_patch"

/** `Parameters`: a fresh JSON schema object for the function form of the tool. */
export const applyPatchParameters = (): Json => JSON.parse(PARAMETERS) as Json

/** `Description` of the function form (the freeform wrapper instruction is dropped, the grammar is appended). */
export const applyPatchDescription = (tool: Json | undefined): string => {
  const original = asString(get(tool, "description")).replaceAll(
    "This is a FREEFORM tool, so do not wrap the patch in JSON.",
    ""
  )
  let description = ""
  if (original.trim() !== "") description += `${original}\n\n`
  description += PATCH_INSTRUCTIONS
  const grammar = asString(get(tool, "format.definition"))
  if (grammar !== "") {
    if (grammar.includes("*** Environment ID:")) {
      description += "\n\nUse *** Environment ID: as specified by the patch grammar."
    }
    description += `\n\nOriginal patch grammar:\n${grammar}`
  }
  return description
}

/** `WrapInput`: `{"input":<patch>}` with Go's HTML-safe escaping. */
export const wrapApplyPatchInput = (input: string): string => goMarshal({ input })

/** `UnwrapInput`: the patch text of a strict `{"input":"..."}` envelope; `undefined` when it is anything else. */
export const unwrapApplyPatchInput = (argumentsText: string): string | undefined => {
  const parsed = tryParseJson(argumentsText)
  if (!isJsonObject(parsed)) return undefined
  const keys = Object.keys(parsed)
  if (keys.length !== 1 || keys[0] !== "input") return undefined
  const input = parsed["input"]
  return typeof input === "string" ? input : undefined
}

/** `EscapeInputFragment`: JSON string escaping without the surrounding quotes. */
export const escapeApplyPatchInputFragment = (fragment: string): string => goMarshal(fragment).slice(1, -1)
