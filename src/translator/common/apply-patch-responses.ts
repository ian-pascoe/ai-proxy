/**
 * Responses-format `apply_patch` bridge for executors that cannot take the Codex custom tool natively (xAI, Kimi
 * `/responses`, Meta).
 *
 * Go source: internal/translator/common/apply_patch_responses.go (NormalizeApplyPatchResponsesRequest,
 * ApplyPatchResponsesBridge). The request side rewrites the winning custom `apply_patch` declaration (and explicit
 * history/tool choices) into the strict `{"input": ...}` function; the response side turns the function-call events
 * back into `custom_tool_call` items and `response.custom_tool_call_input.*` events, validating identity (item id,
 * call id, output index) and arguments, and failing the stream with one `response.failed` frame when they conflict.
 *
 * Events are parsed JSON objects (the Go code works on raw bytes); inputs are never mutated, outputs are fresh values.
 */
import {
  asInt,
  asString,
  cloneJson,
  del,
  get,
  isJsonArray,
  isJsonObject,
  type Json,
  type JsonObject,
  set
} from "../../json/index.ts"
import {
  ApplyPatchCallState,
  ApplyPatchInputDecoder,
  applyPatchDescription,
  applyPatchFailure,
  applyPatchInputDelta,
  applyPatchInputDone,
  applyPatchParameters,
  isApplyPatchCustomTool,
  wrapApplyPatchInput
} from "./apply-patch.ts"
import {
  collectResponsesToolDescriptors,
  collectResponsesToolWinners,
  qualifyResponsesNamespaceToolName,
  type ResponsesToolDescriptor
} from "./responses-tools.ts"

const str = (value: Json | undefined, path: string): string => asString(get(value, path))

// ---------------------------------------------------------------------------------------------------------------------
// Request normalisation
// ---------------------------------------------------------------------------------------------------------------------

/**
 * `NormalizeApplyPatchResponsesRequest`: adapts declarations and explicit custom patch history. Winners are collected
 * before rewriting so normalisation never changes declaration precedence. Throws on a non-string history input.
 */
export const normalizeApplyPatchResponsesRequest = (original: Json): Json => {
  const root = original
  const raw = cloneJson(original)
  const winners = collectResponsesToolWinners(root)
  const affected = new Set<string>()
  for (const descriptor of collectResponsesToolDescriptors(root)) {
    if (isApplyPatchCustomTool(descriptor.tool)) affected.add(descriptor.name)
  }

  const normalizeTools = (tools: Json[], namespace: string): Json[] => {
    const items: Json[] = []
    for (const tool of tools) {
      const item = cloneJson(tool)
      if (str(tool, "type") === "namespace") {
        for (const key of ["tools", "children"]) {
          const children = get(tool, key)
          if (isJsonArray(children) && isJsonObject(item)) {
            item[key] = normalizeTools(children, str(tool, "name"))
            break
          }
        }
      } else {
        let name = str(tool, "name")
        if (name === "") name = str(tool, "function.name")
        const qualified = qualifyResponsesNamespaceToolName(namespace, name)
        const winner = winners.get(qualified)
        if (winner !== undefined && affected.has(qualified)) {
          if (winner.tool !== tool) continue
          if (isApplyPatchCustomTool(tool)) {
            set(item, "type", "function")
            set(item, "description", applyPatchDescription(tool))
            set(item, "parameters", applyPatchParameters())
            del(item, "format")
          }
        }
      }
      items.push(item)
    }
    return items
  }

  const tools = get(root, "tools")
  if (isJsonArray(tools)) set(raw, "tools", normalizeTools(tools, ""))

  const patchHistory = new Set<string>()
  const input = get(root, "input")
  const inputItems = isJsonArray(input) ? input : []
  for (const item of inputItems) {
    if (str(item, "type") === "custom_tool_call" && str(item, "name").trim() === "apply_patch") {
      patchHistory.add(str(item, "call_id"))
    }
  }
  inputItems.forEach((item, index) => {
    const path = `input.${index}`
    switch (str(item, "type")) {
      case "additional_tools": {
        const extra = get(item, "tools")
        if (isJsonArray(extra)) set(raw, `${path}.tools`, normalizeTools(extra, ""))
        break
      }
      case "custom_tool_call": {
        if (str(item, "name").trim() !== "apply_patch") break
        const patch = get(item, "input")
        if (typeof patch !== "string") throw new Error("apply_patch history input must be a string")
        set(raw, `${path}.type`, "function_call")
        set(raw, `${path}.arguments`, wrapApplyPatchInput(patch))
        del(raw, `${path}.input`)
        break
      }
      case "custom_tool_call_output":
        if (patchHistory.has(str(item, "call_id"))) set(raw, `${path}.type`, "function_call_output")
        break
    }
  })

  const normalizeChoice = (choice: Json): Json => {
    const out = cloneJson(choice)
    const name = str(choice, "name")
    const namespace = str(choice, "namespace")
    const winner = winners.get(qualifyResponsesNamespaceToolName(namespace, name))
    if (winner !== undefined && isApplyPatchCustomTool(winner.tool) && str(choice, "type") === "custom") {
      set(out, "type", "function")
    }
    const children = get(choice, "tools")
    if (isJsonArray(children)) children.forEach((child, index) => set(out, `tools.${index}`, normalizeChoice(child)))
    return out
  }
  const choice = get(root, "tool_choice")
  if (isJsonObject(choice)) set(raw, "tool_choice", normalizeChoice(choice))
  return raw
}

// ---------------------------------------------------------------------------------------------------------------------
// Response bridge
// ---------------------------------------------------------------------------------------------------------------------

class PatchRecord {
  readonly state = new ApplyPatchCallState("", "", "", "", -1)
  kind = ""
  qualified = ""
  source = ""
  patch = false
  named = false
  added = false
  inputDone = false
  itemDone = false
  snapshot = ""
  completedItem: Json | undefined
  hasSnapshot = false
  pending: Json[] = []
  evidence: Error | undefined

  identityReady(): boolean {
    return this.state.itemId !== "" && this.state.callId !== "" && this.state.outputIndex >= 0
  }
}

export interface BridgeResult {
  readonly events: Json[]
  readonly error?: Error | undefined
}

const asError = (error: string | Error): Error => (typeof error === "string" ? new Error(error) : error)

/** `ApplyPatchResponsesBridge`: handles JSON event payloads without SSE framing; local to one response. */
export class ApplyPatchResponsesBridge {
  /** `ApplyPatchErrorState`: the retained conversion error. */
  #toolInputError: Error | undefined
  readonly #tools: Map<string, ResponsesToolDescriptor>
  readonly #records: PatchRecord[] = []
  readonly #byItemId = new Map<string, PatchRecord>()
  readonly #byCallId = new Map<string, PatchRecord>()
  readonly #byOutputIndex = new Map<number, PatchRecord>()
  #sequence = 0
  #lastSequence = 0
  #responseId = ""
  #failed = false
  #terminal = false
  #converted = false
  readonly active: boolean

  /** Resolves the original declarations before any normalisation. */
  constructor(originalRequest: Json | undefined) {
    this.#tools = collectResponsesToolWinners(originalRequest)
    let active = false
    for (const descriptor of this.#tools.values()) if (isApplyPatchCustomTool(descriptor.tool)) active = true
    this.active = active
  }

  toolInputError(): Error | undefined {
    return this.#toolInputError
  }

  setToolInputError(error: Error | undefined): void {
    this.#toolInputError = error
  }

  #next(): number {
    this.#sequence += 1
    return this.#sequence
  }

  #failure(error: Error): BridgeResult {
    if (this.#failed || this.#terminal) return { events: [] }
    this.#failed = true
    this.setToolInputError(error)
    return { events: [applyPatchFailure(this.#responseId, this.#next())], error }
  }

  /** `Fail`: terminates an executor-owned bridge with the same one-shot failure contract. */
  fail(error: Error): BridgeResult {
    return this.#failure(error)
  }

  #descriptor(item: Json | undefined): ResponsesToolDescriptor | undefined {
    return this.#tools.get(qualifyResponsesNamespaceToolName(str(item, "namespace"), str(item, "name")))
  }

  /**
   * `resolve`: checks every supplied identity, not just the first usable key. Conflicting unmatched keys and multiple
   * matched records retain evidence until patch provenance is known.
   */
  #resolve(event: Json, item: Json | undefined): PatchRecord {
    const ids = [str(event, "item_id"), str(item, "id")]
    const calls = [str(event, "call_id"), str(item, "call_id")]
    const indexValue = get(event, "output_index")
    const hasIndex = indexValue !== undefined
    const matched = new Set<PatchRecord>()
    for (const id of ids) {
      const record = this.#byItemId.get(id)
      if (id !== "" && record !== undefined) matched.add(record)
    }
    for (const id of calls) {
      const record = this.#byCallId.get(id)
      if (id !== "" && record !== undefined) matched.add(record)
    }
    if (hasIndex) {
      const record = this.#byOutputIndex.get(asInt(indexValue))
      if (record !== undefined) matched.add(record)
    }
    let r = this.#records.find((candidate) => matched.has(candidate))
    if (r === undefined) {
      r = new PatchRecord()
      this.#records.push(r)
    }
    let bad = matched.size > 1
    for (const id of ids) if (id !== "" && r.state.itemId !== "" && r.state.itemId !== id) bad = true
    for (const id of calls) if (id !== "" && r.state.callId !== "" && r.state.callId !== id) bad = true
    if (ids[0] !== "" && ids[1] !== "" && ids[0] !== ids[1]) bad = true
    if (calls[0] !== "" && calls[1] !== "" && calls[0] !== calls[1]) bad = true
    if (hasIndex && r.state.outputIndex >= 0 && r.state.outputIndex !== asInt(indexValue)) bad = true
    const descriptor = this.#descriptor(item)
    const known = descriptor !== undefined
    let incomingPatch = known && isApplyPatchCustomTool(descriptor.tool) && str(item, "type") !== "custom_tool_call"
    if (bad) {
      const identityError = new Error("conflicting apply_patch call identity")
      r.evidence = identityError
      for (const candidate of matched) {
        candidate.evidence = identityError
        if (candidate.patch) incomingPatch = true
      }
      // Keep aliases for unmatched conflicting keys, too. Their later patch provenance must not create a fresh record
      // and erase the earlier contradiction.
      for (const id of ids) if (id !== "" && !this.#byItemId.has(id)) this.#byItemId.set(id, r)
      for (const id of calls) if (id !== "" && !this.#byCallId.has(id)) this.#byCallId.set(id, r)
      if (hasIndex && !this.#byOutputIndex.has(asInt(indexValue))) this.#byOutputIndex.set(asInt(indexValue), r)
      if (r.patch || incomingPatch) throw identityError
    } else {
      for (const id of ids) {
        if (id === "") continue
        r.state.itemId = id
        this.#byItemId.set(id, r)
      }
      for (const id of calls) {
        if (id === "") continue
        r.state.callId = id
        this.#byCallId.set(id, r)
      }
      if (hasIndex) {
        r.state.outputIndex = asInt(indexValue)
        this.#byOutputIndex.set(r.state.outputIndex, r)
      }
    }
    const kind = str(item, "type")
    if (kind !== "") {
      if (r.kind !== "" && r.kind !== kind) r.evidence = new Error("conflicting apply_patch call type")
      if (r.kind === "") r.kind = kind
    }
    const name = str(item, "name")
    if (name !== "") {
      let qualified = qualifyResponsesNamespaceToolName(str(item, "namespace"), name)
      if (known) qualified = descriptor.name
      if (r.named && r.qualified !== qualified) r.evidence = new Error("conflicting apply_patch call name")
      r.named = true
      r.qualified = qualified
      r.state.name = name
      r.state.namespace = str(item, "namespace")
      if (known) {
        r.state.name = descriptor.localName
        r.state.namespace = descriptor.namespace
      }
    }
    if (incomingPatch) r.patch = true
    if (r.patch && r.evidence !== undefined) throw r.evidence
    return r
  }

  /**
   * `CheckIdentity`: retains every supplied key before a folded dispatcher reveals its child. Names are deliberately
   * withheld: a dispatcher name is not the selected child name. Returns the identity error, if any.
   */
  checkIdentity(event: Json): Error | undefined {
    let item = get(event, "item")
    if (item !== undefined) {
      item = cloneJson(item)
      del(item, "name")
      del(item, "namespace")
    }
    try {
      this.#resolve(event, item)
    } catch (error) {
      return asError(error as Error)
    }
    return undefined
  }

  #restoreItem(original: Json, r: PatchRecord, input: string, added: boolean): Json {
    const item = cloneJson(original)
    if (r.patch) {
      set(item, "type", "custom_tool_call")
      del(item, "arguments")
      set(item, "input", input)
    }
    const descriptor = this.#tools.get(r.qualified)
    if (descriptor !== undefined && descriptor.namespace !== "") {
      set(item, "name", descriptor.localName)
      set(item, "namespace", descriptor.namespace)
    }
    if (r.patch && !added) {
      if (r.state.itemId !== "") set(item, "id", r.state.itemId)
      if (r.state.callId !== "") set(item, "call_id", r.state.callId)
      set(item, "name", r.state.name)
    }
    return item
  }

  #itemEvent(kind: string, item: Json, r: PatchRecord): JsonObject {
    return {
      type: kind,
      output_index: r.state.outputIndex,
      sequence_number: this.#next(),
      item: cloneJson(item)
    }
  }

  /** `snapshot`: validates a full arguments snapshot against the streamed input and earlier snapshots. */
  #snapshot(r: PatchRecord, args: Json | undefined, final: boolean): void {
    if (args === undefined) return
    if (typeof args !== "string") throw new Error("apply_patch arguments snapshot must be a string")
    if (args === "" && !final) return
    const decoder = new ApplyPatchInputDecoder()
    const finished = decoder.finish(args)
    if ("error" in finished) throw new Error(finished.error)
    if (r.hasSnapshot) {
      const previous = new ApplyPatchInputDecoder()
      previous.finish(r.snapshot)
      if (previous.input() !== decoder.input()) throw new Error("conflicting apply_patch arguments snapshot")
    }
    if (!decoder.input().startsWith(r.state.decoder.input())) {
      throw new Error("apply_patch snapshot conflicts with streamed input")
    }
    r.snapshot = args
    r.hasSnapshot = true
  }

  #patchEvent(raw: Json, r: PatchRecord): Json[] {
    if (!r.identityReady()) throw new Error("unresolved apply_patch call identity")
    const kind = str(raw, "type")
    const item = get(raw, "item")
    this.#converted = true
    const out: Json[] = []
    if (item !== undefined) {
      if (str(item, "type") !== "function_call") throw new Error("conflicting apply_patch call type")
      this.#snapshot(r, get(item, "arguments"), kind === "response.output_item.done")
    }
    if (!r.added) {
      const added: Json = item !== undefined ? cloneJson(item) : { type: "function_call", name: "", arguments: "" }
      set(added, "name", r.state.name)
      if (r.state.itemId !== "") set(added, "id", r.state.itemId)
      if (r.state.callId !== "") set(added, "call_id", r.state.callId)
      if (r.state.namespace !== "") set(added, "namespace", r.state.namespace)
      out.push(this.#itemEvent("response.output_item.added", this.#restoreItem(added, r, "", true), r))
      r.added = true
    }
    switch (kind) {
      case "response.function_call_arguments.delta": {
        const fragment = str(raw, "delta")
        if (r.inputDone) {
          if (fragment !== "") throw new Error("apply_patch arguments received after completion")
          return out
        }
        r.source += fragment
        const pushed = r.state.pushArguments(fragment)
        if ("error" in pushed) throw new Error(pushed.error)
        if (r.hasSnapshot) {
          const snapshot = new ApplyPatchInputDecoder()
          snapshot.finish(r.snapshot)
          if (!snapshot.input().startsWith(r.state.decoder.input())) {
            throw new Error("apply_patch stream conflicts with snapshot")
          }
        }
        if (pushed.text !== "") out.push(applyPatchInputDelta(r.state, pushed.text, this.#next()))
        break
      }
      case "response.function_call_arguments.done":
      case "response.output_item.done": {
        let args = get(raw, "arguments")
        if (item !== undefined) args = get(item, "arguments")
        if (args !== undefined) this.#snapshot(r, args, true)
        const final = r.hasSnapshot ? r.snapshot : r.source
        const finished = r.state.finishArguments(final)
        if ("error" in finished) throw new Error(finished.error)
        if (!r.inputDone) {
          if (finished.tail !== "" && r.source !== "") {
            out.push(applyPatchInputDelta(r.state, finished.tail, this.#next()))
          }
          out.push(applyPatchInputDone(r.state, finished.input, this.#next()))
          r.inputDone = true
        }
        if (kind === "response.output_item.done" && !r.itemDone) {
          r.completedItem = this.#restoreItem(item === undefined ? {} : item, r, finished.input, false)
          out.push(this.#itemEvent(kind, r.completedItem, r))
          r.itemDone = true
        }
        break
      }
    }
    return out
  }

  #transformItemEvent(raw: Json): Json[] {
    let item = get(raw, "item")
    if (item === undefined && get(raw, "name") !== undefined) {
      // Arguments events can supply late names and identities at the root.
      const identity: JsonObject = { type: "function_call" }
      for (const key of ["name", "namespace", "call_id"]) {
        const value = get(raw, key)
        if (value !== undefined) identity[key] = cloneJson(value)
      }
      item = identity
    }
    const r = this.#resolve(raw, item)
    // A known name is provenance, not readiness. Retain the real source events until both upstream ids and the output
    // index can identify every emitted event.
    if ((!r.named && (r.kind === "" || r.kind === "function_call")) || (r.patch && !r.identityReady())) {
      if (r.patch) {
        let args = get(raw, "arguments")
        if (get(raw, "item") !== undefined) args = get(item, "arguments")
        const kind = str(raw, "type")
        this.#snapshot(
          r,
          args,
          kind === "response.output_item.done" || kind === "response.function_call_arguments.done"
        )
      }
      r.pending.push(cloneJson(raw))
      return []
    }
    let out: Json[] = []
    const pending = r.pending
    r.pending = []
    if (r.patch) {
      for (const event of [...pending, raw]) out = out.concat(this.#patchEvent(event, r))
      return out
    }
    out = out.concat(pending)
    let event = raw
    if (
      get(raw, "item") !== undefined &&
      r.kind === "function_call" &&
      (this.#tools.get(r.qualified)?.namespace ?? "") !== ""
    ) {
      event = cloneJson(raw)
      set(event, "item", this.#restoreItem(item as Json, r, "", false))
    }
    if (str(raw, "type") === "response.output_item.done" && item !== undefined) {
      r.itemDone = true
      const done = get(event, "item")
      r.completedItem = done === undefined ? undefined : cloneJson(done)
    }
    out.push(event)
    return out
  }

  /** `envelope`: a terminal event or bare response; items are restored and unfinished calls closed. */
  #envelope(original: Json, stream: boolean): { readonly raw: Json; readonly preceding: Json[] } {
    const raw = cloneJson(original)
    let path = "output"
    let response: Json = original
    if (get(original, "response") !== undefined) {
      path = "response.output"
      response = get(original, "response") as Json
    }
    const preceding: Json[] = []
    const seen = new Set<PatchRecord>()
    const items: Json[] = []
    const outputItems = get(response, "output")
    const responseItems = isJsonArray(outputItems) ? outputItems : []
    responseItems.forEach((item, i) => {
      let index = i
      // A terminal snapshot may omit earlier completed items: array position is not identity.
      let known = this.#byItemId.get(str(item, "id"))
      if (known === undefined) known = this.#byCallId.get(str(item, "call_id"))
      if (known !== undefined && known.state.outputIndex >= 0) {
        index = known.state.outputIndex
      } else if (known === undefined && (str(item, "id") !== "" || str(item, "call_id") !== "")) {
        const previous = this.#byOutputIndex.get(index)
        if (previous !== undefined && (previous.state.itemId !== "" || previous.state.callId !== "")) {
          for (const record of this.#records)
            if (record.state.outputIndex >= index) index = record.state.outputIndex + 1
        }
      }
      const event: Json = { type: "response.output_item.done", output_index: index, item: cloneJson(item) }
      const r = this.#resolve(event, item)
      seen.add(r)
      if (r.patch) {
        const pending = r.pending
        r.pending = []
        for (const source of pending) preceding.push(...this.#patchEvent(source, r))
        preceding.push(...this.#patchEvent(event, r))
        set(raw, `${path}.${i}`, this.#restoreItem(item, r, r.state.decoder.input(), false))
      } else if (str(item, "type") === "function_call" && (this.#tools.get(r.qualified)?.namespace ?? "") !== "") {
        set(raw, `${path}.${i}`, this.#restoreItem(item, r, "", false))
      }
      items.push(cloneJson(get(raw, `${path}.${i}`) as Json))
    })
    for (const r of this.#records) {
      if (seen.has(r) || (!r.patch && !this.#converted)) continue
      if (r.inputDone && !r.itemDone) {
        r.completedItem = this.#restoreItem(
          { type: "function_call", status: "completed" },
          r,
          r.state.decoder.input(),
          false
        )
        preceding.push(this.#itemEvent("response.output_item.done", r.completedItem, r))
        r.itemDone = true
      }
      if (r.itemDone) {
        let index = r.state.outputIndex
        if (index < 0 || index > items.length) index = items.length
        if (r.completedItem !== undefined) items.splice(index, 0, cloneJson(r.completedItem))
      }
    }
    if (items.length !== responseItems.length) set(raw, path, items)
    if (stream) {
      const finished = this.finish()
      if (finished !== undefined) throw finished
      for (const r of this.#records) {
        preceding.push(...r.pending)
        r.pending = []
      }
      if (this.#converted) set(raw, "sequence_number", this.#next())
    }
    return { raw, preceding }
  }

  /** `Transform`: converts one payload. A failure is terminal and is emitted only once. */
  transform(event: Json): BridgeResult {
    if (this.#failed || this.#terminal) return { events: [] }
    if (!this.active) return { events: [event] }
    const responseId = str(event, "response.id")
    if (responseId !== "") this.#responseId = responseId
    const seq = asInt(get(event, "sequence_number"))
    if (seq > this.#sequence) this.#sequence = seq
    const kind = str(event, "type")
    let out: Json[] = []
    try {
      switch (kind) {
        case "response.output_item.added":
        case "response.output_item.done":
        case "response.function_call_arguments.delta":
        case "response.function_call_arguments.done":
          out = this.#transformItemEvent(event)
          break
        case "response.completed":
        case "response.incomplete":
        case "response.done": {
          const { raw, preceding } = this.#envelope(event, true)
          out = [...preceding, raw]
          this.#terminal = true
          break
        }
        case "response.failed":
          this.#terminal = true
          out = [event]
          break
        default:
          out = [event]
      }
    } catch (error) {
      return this.#failure(asError(error as Error))
    }
    const nativeCustom =
      kind.startsWith("response.custom_tool_call_input.") || str(event, "item.type") === "custom_tool_call"
    out = out.map((candidate) => {
      let sequence = asInt(get(candidate, "sequence_number"))
      let result = candidate
      // Native custom payloads are opaque. Only a stream that acquired a function patch call needs resequencing of its
      // other compatibility events.
      if (this.#converted && !nativeCustom && sequence <= this.#lastSequence) {
        sequence = this.#next()
        result = cloneJson(candidate)
        set(result, "sequence_number", sequence)
      }
      if (sequence > this.#lastSequence) this.#lastSequence = sequence
      return result
    })
    return { events: out }
  }

  /** `TransformNonStream`: accepts either a bare response or a terminal event envelope. */
  transformNonStream(response: Json): { readonly body: Json } | { readonly error: Error } {
    if (!this.active) return { body: response }
    try {
      return { body: this.#envelope(response, false).raw }
    } catch (error) {
      this.#failed = true
      this.setToolInputError(asError(error as Error))
      return { error: this.#toolInputError as Error }
    }
  }

  /** `Finish`: rejects acquired calls whose final arguments have not been validated. */
  finish(): Error | undefined {
    if (this.#toolInputError !== undefined) return this.#toolInputError
    if (this.#terminal) return undefined
    for (const r of this.#records) {
      if (r.patch && !r.inputDone) return new Error("incomplete apply_patch tool arguments received from upstream")
    }
    return undefined
  }
}
