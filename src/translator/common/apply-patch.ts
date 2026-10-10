/**
 * Codex `apply_patch` custom-tool bridge used by the Responses translators.
 *
 * Go sources: internal/client/codex/apply-patch/tool.go, internal/translator/common/apply_patch_input.go and
 * apply_patch_events.go. Shared by every translator that bridges the Codex `apply_patch` custom tool.
 *
 * Differences from Go: the streaming decoder scans UTF-16 strings instead of UTF-8 bytes (invalid UTF-8 cannot occur
 * in decoded text); everything else, including the error messages, follows the Go state machine.
 */
import { asString, get, type Json, type JsonObject } from "../../json/index.ts"
import { goMarshal } from "../../http/json-text.ts"

const getStr = (root: Json | undefined, path: string): string => asString(get(root, path))

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

/** `applypatch.IsCustomTool`. */
export const isApplyPatchCustomTool = (tool: Json | undefined): boolean =>
  getStr(tool, "type") === "custom" && getStr(tool, "name").trim() === "apply_patch"

/** `applypatch.Parameters`: an independent copy of the patch input schema. */
export const applyPatchParameters = (): Json => JSON.parse(PARAMETERS) as Json

/** `applypatch.Description`. */
export const applyPatchDescription = (tool: Json | undefined): string => {
  const original = getStr(tool, "description").replaceAll(
    "This is a FREEFORM tool, so do not wrap the patch in JSON.",
    ""
  )

  let description = ""

  if (original.trim() !== "") description += `${original}\n\n`
  description += PATCH_INSTRUCTIONS
  const grammar = getStr(tool, "format.definition")

  if (grammar !== "") {
    if (grammar.includes("*** Environment ID:")) {
      description += "\n\nUse *** Environment ID: as specified by the patch grammar."
    }

    description += `\n\nOriginal patch grammar:\n${grammar}`
  }

  return description
}

/** `applypatch.WrapInput`. */
export const wrapApplyPatchInput = (input: string): string => goMarshal({ input })

/** `applypatch.UnwrapInput`: the patch text of a strict `{"input":"..."}` object, or an error message. */
export const unwrapApplyPatchInput = (
  argumentsText: string
): { readonly input: string } | { readonly error: string } => {
  let parsed: Json

  try {
    parsed = JSON.parse(argumentsText) as Json
  } catch (error) {
    return { error: `decode apply_patch arguments object: ${error instanceof Error ? error.message : String(error)}` }
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { error: "apply_patch arguments must be a JSON object" }
  }

  const keys = Object.keys(parsed)

  if (keys.length === 0 || keys[0] !== "input") return { error: "apply_patch arguments must contain the input field" }
  const input = parsed.input

  if (typeof input !== "string") return { error: "apply_patch input must be a string" }

  if (keys.length > 1) return { error: "apply_patch arguments must contain only one input field" }

  return { input }
}

/** `applypatch.EscapeInputFragment`: JSON string escaping without the surrounding quotes. */
export const escapeApplyPatchInputFragment = (fragment: string): string => goMarshal(fragment).slice(1, -1)

type Phase =
  | "beforeObject"
  | "beforeKey"
  | "inKey"
  | "beforeColon"
  | "beforeValue"
  | "inValue"
  | "afterValue"
  | "complete"

const isJsonSpace = (c: string): boolean => c === " " || c === "\t" || c === "\r" || c === "\n"

const hexValue = (c: string): number | undefined => {
  if (c >= "0" && c <= "9") return c.charCodeAt(0) - 48

  if (c >= "a" && c <= "f") return c.charCodeAt(0) - 97 + 10

  if (c >= "A" && c <= "F") return c.charCodeAt(0) - 65 + 10

  return undefined
}

/** Decodes the `input` string from streamed function arguments (`ApplyPatchInputDecoder`). One per call. */
export class ApplyPatchInputDecoder {
  #phase: Phase = "beforeObject"
  #keyRaw = ""
  #escapeRaw = ""
  #highSurrogate = 0
  #input = ""
  #finished = false
  #error: string | undefined

  /** Scans a fragment once and returns the newly decoded characters; errors are returned as `error`. */
  push(fragment: string): { readonly text: string } | { readonly error: string } {
    if (this.#error !== undefined) return { error: this.#error }

    if (this.#finished) {
      if (fragment === "") return { text: "" }

      return this.#fail("apply_patch arguments received after completion")
    }

    const start = this.#input.length

    for (let i = 0; i < fragment.length; i++) {
      const c = fragment[i] as string

      switch (this.#phase) {
        case "beforeObject":
          if (isJsonSpace(c)) continue

          if (c !== "{") return this.#fail("apply_patch arguments must be a JSON object")
          this.#phase = "beforeKey"
          break
        case "beforeKey":
          if (isJsonSpace(c)) continue

          if (c !== '"') return this.#fail("apply_patch arguments must contain the input field")
          this.#keyRaw += c
          this.#phase = "inKey"
          break
        case "inKey": {
          this.#keyRaw += c

          if (this.#escapeRaw !== "") {
            this.#escapeRaw = ""
            continue
          }

          if (c === "\\") {
            this.#escapeRaw = c
            continue
          }

          if (c.charCodeAt(0) < 0x20) return this.#fail("invalid control character in apply_patch input key")

          if (c === '"') {
            let key: string

            try {
              key = JSON.parse(this.#keyRaw) as string
            } catch (error) {
              return this.#fail(
                `decode apply_patch input key: ${error instanceof Error ? error.message : String(error)}`
              )
            }

            if (key !== "input") return this.#fail("apply_patch arguments must contain the input field")
            this.#keyRaw = ""
            this.#phase = "beforeColon"
          }

          break
        }

        case "beforeColon":
          if (isJsonSpace(c)) continue

          if (c !== ":") return this.#fail("apply_patch input key must be followed by a colon")
          this.#phase = "beforeValue"
          break
        case "beforeValue":
          if (isJsonSpace(c)) continue

          if (c !== '"') return this.#fail("apply_patch input must be a string")
          this.#phase = "inValue"
          break
        case "inValue": {
          const failure = this.#consumeValue(c)

          if (failure !== undefined) return this.#fail(failure)
          break
        }

        case "afterValue":
          if (isJsonSpace(c)) continue

          if (c !== "}") return this.#fail("apply_patch arguments must contain only one input field")
          this.#phase = "complete"
          break
        case "complete":
          if (!isJsonSpace(c)) return this.#fail("apply_patch arguments must not contain trailing JSON")
          break
      }
    }

    return { text: this.#input.slice(start) }
  }

  #consumeValue(c: string): string | undefined {
    if (c.charCodeAt(0) >= 0x80) {
      // Pending escapes and surrogate pairs cannot consume raw non-ASCII characters.
      if (this.#escapeRaw !== "" || this.#highSurrogate !== 0) return "invalid Unicode escape in apply_patch input"
      this.#input += c

      return undefined
    }

    if (this.#escapeRaw !== "") {
      this.#escapeRaw += c

      if (this.#escapeRaw.length === 2) {
        if (this.#highSurrogate !== 0 && c !== "u") return "apply_patch input high surrogate requires a low surrogate"
        let decoded: string

        switch (c) {
          case "u":
            return undefined
          case '"':
          case "\\":
          case "/":
            decoded = c
            break
          case "b":
            decoded = "\b"
            break
          case "f":
            decoded = "\f"
            break
          case "n":
            decoded = "\n"
            break
          case "r":
            decoded = "\r"
            break
          case "t":
            decoded = "\t"
            break
          default:
            return "invalid escape in apply_patch input"
        }

        this.#input += decoded
        this.#escapeRaw = ""

        return undefined
      }

      if (hexValue(c) === undefined) return "invalid Unicode escape in apply_patch input"

      if (this.#escapeRaw.length < 6) return undefined
      let code = 0

      for (const digit of this.#escapeRaw.slice(2)) code = (code << 4) | (hexValue(digit) as number)
      this.#escapeRaw = ""

      if (this.#highSurrogate !== 0) {
        if (code < 0xdc00 || code > 0xdfff) return "apply_patch input high surrogate requires a low surrogate"
        this.#input += String.fromCharCode(this.#highSurrogate, code)
        this.#highSurrogate = 0
      } else if (code >= 0xd800 && code <= 0xdbff) {
        this.#highSurrogate = code
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        return "unpaired low surrogate in apply_patch input"
      } else {
        this.#input += String.fromCharCode(code)
      }

      return undefined
    }

    if (this.#highSurrogate !== 0 && c !== "\\") return "apply_patch input high surrogate requires a low surrogate"

    if (c === "\\") this.#escapeRaw = c
    else if (c === '"') this.#phase = "afterValue"
    else if (c.charCodeAt(0) < 0x20) return "invalid control character in apply_patch input"
    else this.#input += c

    return undefined
  }

  /** Validates the final wrapper and returns only the previously unsent suffix. */
  finish(argumentsText: string): { readonly tail: string } | { readonly error: string } {
    if (this.#error !== undefined) return { error: this.#error }
    const unwrapped = unwrapApplyPatchInput(argumentsText)

    if ("error" in unwrapped) return this.#fail(unwrapped.error)
    const final = new ApplyPatchInputDecoder()
    const pushed = final.push(argumentsText)

    if ("error" in pushed) return this.#fail(pushed.error)

    if (this.#finished) {
      if (unwrapped.input !== this.#input) return this.#fail("conflicting apply_patch arguments completion")

      return { tail: "" }
    }

    if (!unwrapped.input.startsWith(this.#input))
      return this.#fail("final apply_patch input conflicts with streamed input")
    const tail = unwrapped.input.slice(this.#input.length)
    this.#input += tail
    this.#finished = true
    this.#phase = "complete"
    this.#keyRaw = ""
    this.#escapeRaw = ""
    this.#highSurrogate = 0

    return { tail }
  }

  /** The decoded input, preserving its original whitespace. */
  input(): string {
    return this.#input
  }

  #fail(message: string): { readonly error: string } {
    this.#error = message

    return { error: message }
  }
}

/** `ApplyPatchCallState`: the decoder and identity of one tool call. */
export class ApplyPatchCallState {
  readonly decoder = new ApplyPatchInputDecoder()
  constructor(
    public itemId: string,
    public callId: string,
    public name: string,
    public namespace: string,
    public outputIndex: number
  ) {}

  pushArguments(fragment: string): { readonly text: string } | { readonly error: string } {
    return this.decoder.push(fragment)
  }

  /** The unsent suffix and the complete decoded input. */
  finishArguments(
    argumentsText: string
  ): { readonly tail: string; readonly input: string } | { readonly error: string } {
    const finished = this.decoder.finish(argumentsText)

    if ("error" in finished) return finished

    return { tail: finished.tail, input: this.decoder.input() }
  }
}

/** The identity fields of an `apply_patch` call that its Responses events carry. */
export interface ApplyPatchCallIdentity {
  readonly itemId: string
  readonly callId: string
  readonly outputIndex: number
}

/** `ApplyPatchInputDelta`: a Responses custom-tool input delta without SSE framing. */
export const applyPatchInputDelta = (s: ApplyPatchCallIdentity, delta: string, sequence: number): JsonObject => ({
  type: "response.custom_tool_call_input.delta",
  item_id: s.itemId,
  call_id: s.callId,
  output_index: s.outputIndex,
  sequence_number: sequence,
  delta
})

/** `ApplyPatchInputDone`: a Responses custom-tool input completion without SSE framing. */
export const applyPatchInputDone = (s: ApplyPatchCallIdentity, input: string, sequence: number): JsonObject => ({
  type: "response.custom_tool_call_input.done",
  item_id: s.itemId,
  call_id: s.callId,
  output_index: s.outputIndex,
  sequence_number: sequence,
  input
})

/** `ApplyPatchFailure`: a terminal Responses failure that does not expose upstream arguments. */
export const applyPatchFailure = (responseId: string, sequence: number): JsonObject => ({
  type: "response.failed",
  sequence_number: sequence,
  response: {
    id: responseId,
    object: "response",
    status: "failed",
    error: {
      type: "server_error",
      code: "invalid_tool_arguments",
      message: "Invalid apply_patch tool arguments received from upstream.",
      param: null
    }
  }
})
