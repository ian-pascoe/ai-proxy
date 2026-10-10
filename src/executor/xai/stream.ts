/**
 * Line-by-line xAI Responses SSE stream processing.
 *
 * Go source: internal/runtime/executor/xai_executor_stream.go (ExecuteStream reader loop, with the apply_patch
 * bridge; without the Claude input-token estimate). `event:` lines are buffered and paired with the following `data:`
 * line (the event name is re-derived from the normalised `type`); each `data:` event goes through reasoning-summary
 * normalisation, namespace restore, client function alias restore and the hidden X Search filter before it is handed
 * to the translator. Terminal events get their `response.output` rebuilt from `output_item.done` items.
 */
import { asString, get, isJsonObject, type Json, tryParseJson } from "../../json/index.ts"
import type { ResponseContext, TranslatorRegistry } from "../../translator/registry.ts"
import { responseModelOf } from "../../usage/record.ts"
import { isResponsesTokenEvent } from "../../usage/ttft.ts"
import type { UsageReporter } from "../../usage/reporter.ts"
import { OutputItemCollector, parseCodexUsage } from "../codex/output.ts"
import { APPLY_PATCH_UPSTREAM_ERROR_MESSAGE, type ApplyPatchResponsesState } from "../helps/apply-patch-responses.ts"
import { ExecutionError } from "../errors.ts"
import {
  type EventPipeline,
  normalizeReasoningEventName,
  normalizeReasoningSummaryEvent,
  normalizeReasoningSummaryEvents,
  patchCompletedOutput
} from "./response.ts"

export interface XaiStreamOptions {
  readonly registry: TranslatorRegistry
  /** Client protocol of the response. */
  readonly responseFormat: string
  /** Provider format of the upstream (`codex`). */
  readonly providerFormat: string
  readonly context: ResponseContext
  readonly usage: UsageReporter
  readonly pipeline: EventPipeline
  /** Request-local apply_patch bridge (`prepared.applyPatch`). */
  readonly applyPatch: ApplyPatchResponsesState
  readonly nowMs: () => number
}

export interface XaiStreamStep {
  readonly chunks: ReadonlyArray<string>
  /** A `response.completed` event whose output should refresh the reasoning replay cache. */
  readonly cacheCompleted?: Json
  /** The apply_patch bridge or its translation failed: the stream ends with this error after `chunks`. */
  readonly error?: ExecutionError
}

/** `xaiNormalizeReasoningSummaryEventLine`. */
const normalizeEventLine = (line: string, eventName: string): string => {
  let name = eventName
  if (name === "" && line.startsWith("event:")) name = line.slice("event:".length).trim()
  name = normalizeReasoningEventName(name)
  return name === "" ? line : `event: ${name}`
}

export class XaiStreamReader {
  readonly #collector = new OutputItemCollector()
  #pendingEvent: string | undefined
  #cacheCompleted: Json | undefined
  #error: ExecutionError | undefined

  constructor(readonly options: XaiStreamOptions) {}

  /** `emitTranslatedLine`: the line goes through the apply_patch bridge, then each resulting line is translated. */
  #emit(line: string, chunks: string[]): void {
    if (this.#error !== undefined) return
    const bridged = this.options.applyPatch.stream(line)
    for (const bridgedLine of bridged.lines) this.#translate(bridgedLine, chunks)
    // Go `RecordApplyPatchStreamFailure` / `StopApplyPatchStream`: a retained translator failure ends the stream after
    // its one translated frame; a bridge failure does too.
    if (bridged.error !== undefined || this.options.context.state.toolInputError !== undefined) {
      this.#error = new ExecutionError({ status: 502, message: APPLY_PATCH_UPSTREAM_ERROR_MESSAGE })
    }
  }

  #translate(line: string, chunks: string[]): void {
    let current = line
    if (line.startsWith("data:")) {
      const event = tryParseJson(line.slice("data:".length).trim())
      const type = asString(get(event, "type"))
      if (type === "response.output_item.done") {
        this.#collector.collect(event)
      } else if ((type === "response.completed" || type === "response.incomplete") && isJsonObject(event)) {
        // Reconstruct only after the bridge has restored dispatcher children.
        const patched = normalizeReasoningSummaryEvent(patchCompletedOutput(event, this.#collector))
        if (asString(get(patched, "type")) === "response.completed") this.#cacheCompleted = patched
        const ending = line.slice(line.replace(/[\r\n]+$/, "").length)
        current = `data: ${JSON.stringify(patched)}${ending}`
      }
    }
    const { registry, responseFormat, providerFormat, context } = this.options
    chunks.push(...registry.translateStream(responseFormat, providerFormat, context, current))
  }

  #step(chunks: string[]): XaiStreamStep {
    const cacheCompleted = this.#cacheCompleted
    this.#cacheCompleted = undefined
    return {
      chunks,
      ...(cacheCompleted !== undefined ? { cacheCompleted } : {}),
      ...(this.#error !== undefined ? { error: this.#error } : {})
    }
  }

  /** Feeds one upstream line (without terminator). */
  push(line: string): XaiStreamStep {
    const chunks: string[] = []
    if (this.#error !== undefined) return this.#step(chunks)
    const { usage, pipeline } = this.options
    if (line.startsWith("event:")) {
      if (this.#pendingEvent !== undefined) this.#emit(normalizeEventLine(this.#pendingEvent, ""), chunks)
      this.#pendingEvent = line
      return this.#step(chunks)
    }
    if (line.startsWith("data:")) {
      const payload = line.slice("data:".length).trim()
      const parsed = tryParseJson(payload)
      const events: ReadonlyArray<Json | undefined> =
        parsed === undefined ? [undefined] : normalizeReasoningSummaryEvents(parsed)
      const hadPending = this.#pendingEvent !== undefined
      for (const [index, raw] of events.entries()) {
        if (raw !== undefined) this.options.applyPatch.rememberDispatcherEvent(raw)
        const event = raw === undefined ? undefined : pipeline.process(raw)
        if (raw !== undefined && event === undefined) {
          if (hadPending && index === 0) this.#pendingEvent = undefined
          continue
        }
        const type = asString(get(event, "type"))
        usage.observeResponseModel(responseModelOf(event))
        if (!usage.ttftObserved) usage.observeTokenEvent(this.options.nowMs(), isResponsesTokenEvent(payload))
        if (type === "response.completed" || type === "response.incomplete") {
          const detail = parseCodexUsage(event)
          if (detail !== undefined) usage.publish(detail)
        }
        if (hadPending) {
          if (index === 0 && this.#pendingEvent !== undefined) {
            this.#emit(normalizeEventLine(this.#pendingEvent, type), chunks)
            this.#pendingEvent = undefined
          } else {
            this.#emit(`event: ${type}`, chunks)
          }
        }
        this.#emit(event === undefined ? `data: ${payload}` : `data: ${JSON.stringify(event)}`, chunks)
        if (this.#error !== undefined) break
      }
      return this.#step(chunks)
    }
    if (this.#pendingEvent !== undefined) {
      this.#emit(normalizeEventLine(this.#pendingEvent, ""), chunks)
      this.#pendingEvent = undefined
    }
    this.#emit(line, chunks)
    return this.#step(chunks)
  }

  /** End of the upstream body: a dangling `event:` line is flushed. */
  end(): XaiStreamStep {
    const chunks: string[] = []
    if (this.#error !== undefined) return this.#step(chunks)
    if (this.#pendingEvent !== undefined) {
      this.#emit(normalizeEventLine(this.#pendingEvent, ""), chunks)
      this.#pendingEvent = undefined
    }
    if (this.#error === undefined) {
      // `FinishStream`: the local failure is emitted once on EOF without a validated completion.
      const finished = this.options.applyPatch.finishStream()
      for (const line of finished.lines) this.#translate(line, chunks)
      if (finished.error !== undefined) {
        this.#error = new ExecutionError({ status: 502, message: APPLY_PATCH_UPSTREAM_ERROR_MESSAGE })
      }
    }
    return this.#step(chunks)
  }
}
