/**
 * Unsupported-part policy and small shared predicates for the Gemini/Interactions translators.
 *
 * Go source: internal/translator/common/parts.go (UnsupportedPartError, UserTurnDrops, UserRun,
 * IsInteractionsInstructionStep, InteractionsAttachmentType, GeminiPartIsSendable, CountSendableGeminiParts,
 * IsHTTPURL).
 */
import { asString, exists, get, isJsonObject, type Json } from "../../../json/index.ts"
import { TranslationError } from "../../registry.ts"

/** A request-scoped rejection: the part type was present but the target has no equivalent. */
export class UnsupportedPartError extends TranslationError {
  constructor(
    readonly partType: string,
    body?: Json
  ) {
    super(partType === "" ? "unsupported content part" : `unsupported content part: ${partType}`, 400, body)
  }
}

/** Policy for parts a translation cannot send: a user turn left with nothing to send is refused. */
export class UserTurnDrops {
  #turn = ""
  #first = ""

  drop(partType: string): void {
    if (this.#turn === "") this.#turn = partType
  }

  endTurn(sendable: number): void {
    if (this.#turn !== "" && sendable <= 0 && this.#first === "") this.#first = this.#turn
    this.#turn = ""
  }

  /** The refusal for the first emptied user turn, if any. */
  error(body?: Json): UnsupportedPartError | undefined {
    return this.#first === "" ? undefined : new UnsupportedPartError(this.#first, body)
  }
}

/** Follows consecutive user content that a target merges into one user turn (Go methods are nil-safe). */
export class UserRun {
  readonly #drops = new UserTurnDrops()
  #sendable = 0

  add(): void {
    this.#sendable++
  }

  drop(partType: string): void {
    this.#drops.drop(partType)
  }

  end(): void {
    this.#drops.endTurn(this.#sendable)
    this.#sendable = 0
  }

  error(body?: Json): UnsupportedPartError | undefined {
    return this.#drops.error(body)
  }
}

/** `IsInteractionsInstructionStep`. */
export const isInteractionsInstructionStep = (step: Json | undefined, inherited: boolean): boolean => {
  let name = asString(get(step, "role")).trim().toLowerCase()
  if (name === "") name = asString(get(step, "type")).trim().toLowerCase()
  switch (name) {
    case "developer":
    case "system":
      return true
    case "user":
    case "assistant":
    case "model":
    case "model_output":
    case "thought":
      return false
    default:
      return inherited
  }
}

/** `InteractionsAttachmentType`: type of an attachment part, `""` for text and unnamed parts. */
export const interactionsAttachmentType = (part: Json | undefined): string => {
  if (!isJsonObject(part)) return ""
  const partType = asString(get(part, "type")).trim().toLowerCase()
  if (partType !== "") return partType === "text" ? "" : partType
  if (exists(part, "inlineData") || exists(part, "inline_data")) return "inlineData"
  if (exists(part, "fileData") || exists(part, "file_data")) return "fileData"
  return ""
}

/** `GeminiPartIsSendable`: a text part that is empty/whitespace is not, other payload keys are. */
export const geminiPartIsSendable = (part: Json | undefined): boolean => {
  const text = get(part, "text")
  if (text === undefined || asString(text).trim() !== "") return true
  return ["functionCall", "functionResponse", "inlineData", "inline_data", "fileData", "file_data"].some((key) =>
    exists(part, key)
  )
}

/** `CountSendableGeminiParts`. */
export const countSendableGeminiParts = (parts: ReadonlyArray<Json>): number =>
  parts.filter(geminiPartIsSendable).length

/** `IsHTTPURL`: absolute http(s) URL with a host. */
export const isHttpUrl = (value: string): boolean => {
  try {
    const url = new URL(value.trim())
    return (url.protocol === "http:" || url.protocol === "https:") && url.host !== ""
  } catch {
    return false
  }
}
