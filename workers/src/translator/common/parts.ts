/**
 * Unsupported-part policy and small shared predicates.
 *
 * Go source: internal/translator/common/parts.go (UnsupportedPartError, UserTurnDrops, UserRun,
 * IsInteractionsInstructionStep, InteractionsAttachmentType, IsHTTPURL).
 */
import { asString, get, isJsonObject, type Json } from "../../json/index.ts"
import { TranslationError } from "../registry.ts"

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
  err(body?: Json): UnsupportedPartError | undefined {
    return this.#first === "" ? undefined : new UnsupportedPartError(this.#first, body)
  }
}

/** Follows consecutive user content that a target merges into one user turn. */
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

  err(body?: Json): UnsupportedPartError | undefined {
    return this.#drops.err(body)
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

/** `InteractionsAttachmentType`. */
export const interactionsAttachmentType = (part: Json | undefined): string => {
  if (!isJsonObject(part)) return ""
  const partType = asString(get(part, "type")).trim().toLowerCase()
  if (partType !== "") return partType === "text" ? "" : partType
  if (get(part, "inlineData") !== undefined || get(part, "inline_data") !== undefined) return "inlineData"
  if (get(part, "fileData") !== undefined || get(part, "file_data") !== undefined) return "fileData"
  return ""
}

/** `IsHTTPURL`: absolute http(s) URL with a host. */
export const isHttpUrl = (value: string): boolean => {
  try {
    const url = new URL(value.trim())
    return url.host !== "" && (url.protocol === "http:" || url.protocol === "https:")
  } catch {
    return false
  }
}
