/**
 * Go source: internal/translator/common/parts.go (UnsupportedPartError, UserTurnDrops, UserRun, interactions part
 * helpers, IsHTTPURL).
 */
import { get, type Json } from "../../../json/index.ts"
import { TranslationError } from "../../registry.ts"
import { getStr } from "./read.ts"

/** `UnsupportedPartError`: a request-scoped 400 refusal. */
export const unsupportedPartError = (type: string, body?: Json): TranslationError =>
  new TranslationError(type === "" ? "unsupported content part" : `unsupported content part: ${type}`, 400, body)

/** Shared policy for parts a translation cannot send: a user turn left with nothing to send is refused. */
export class UserTurnDrops {
  #turn = ""
  #first = ""

  /** Records a part of the current user turn that cannot be sent (the first type of a turn is reported). */
  drop(partType: string): void {
    if (this.#turn === "") this.#turn = partType
  }

  /** Closes the current user turn; `sendable` is the number of parts the turn contributed. */
  endTurn(sendable: number): void {
    if (this.#turn !== "" && sendable <= 0 && this.#first === "") this.#first = this.#turn
    this.#turn = ""
  }

  /** The refusal for the first emptied user turn, if any. */
  err(body?: Json): TranslationError | undefined {
    return this.#first === "" ? undefined : unsupportedPartError(this.#first, body)
  }
}

/** Follows consecutive user content that a target merges into one user turn (`UserRun`). */
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

  err(body?: Json): TranslationError | undefined {
    return this.#drops.err(body)
  }
}

/** `IsInteractionsInstructionStep`. */
export const isInteractionsInstructionStep = (step: Json | undefined, inherited: boolean): boolean => {
  let name = getStr(step, "role").trim().toLowerCase()
  if (name === "") name = getStr(step, "type").trim().toLowerCase()
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

/** `InteractionsAttachmentType`: the type of an attachment part, or "" for text and unnamed parts. */
export const interactionsAttachmentType = (part: Json | undefined): string => {
  if (typeof part !== "object" || part === null || Array.isArray(part)) return ""
  const partType = getStr(part, "type").trim().toLowerCase()
  if (partType !== "") return partType === "text" ? "" : partType
  if (get(part, "inlineData") !== undefined || get(part, "inline_data") !== undefined) return "inlineData"
  if (get(part, "fileData") !== undefined || get(part, "file_data") !== undefined) return "fileData"
  return ""
}

/** `IsHTTPURL`: an absolute http(s) URL with a host. */
export const isHttpUrl = (value: string): boolean => {
  try {
    const parsed = new URL(value.trim())
    return parsed.host !== "" && (parsed.protocol === "http:" || parsed.protocol === "https:")
  } catch {
    return false
  }
}
