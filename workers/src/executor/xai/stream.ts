/**
 * Line-by-line xAI Responses SSE stream processing.
 *
 * Go source: internal/runtime/executor/xai_executor_stream.go (ExecuteStream reader loop, without the apply_patch
 * bridge and the Claude input-token estimate). `event:` lines are buffered and paired with the following `data:`
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
  readonly nowMs: () => number
}

export interface XaiStreamStep {
  readonly chunks: ReadonlyArray<string>
  /** A `response.completed` event whose output should refresh the reasoning replay cache. */
  readonly cacheCompleted?: Json
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

  constructor(readonly options: XaiStreamOptions) {}

  /** `emitTranslatedLine` (without the apply_patch bridge). */
  #emit(line: string, chunks: string[]): void {
    let current = line
    if (line.startsWith("data:")) {
      const event = tryParseJson(line.slice("data:".length).trim())
      const type = asString(get(event, "type"))
      if (type === "response.output_item.done") {
        this.#collector.collect(event)
      } else if ((type === "response.completed" || type === "response.incomplete") && isJsonObject(event)) {
        const patched = normalizeReasoningSummaryEvent(patchCompletedOutput(event, this.#collector))
        if (asString(get(patched, "type")) === "response.completed") this.#cacheCompleted = patched
        current = `data: ${JSON.stringify(patched)}`
      }
    }
    const { registry, responseFormat, providerFormat, context } = this.options
    chunks.push(...registry.translateStream(responseFormat, providerFormat, context, current))
  }

  #step(chunks: string[]): XaiStreamStep {
    const cacheCompleted = this.#cacheCompleted
    this.#cacheCompleted = undefined
    return { chunks, ...(cacheCompleted !== undefined ? { cacheCompleted } : {}) }
  }

  /** Feeds one upstream line (without terminator). */
  push(line: string): XaiStreamStep {
    const chunks: string[] = []
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
    if (this.#pendingEvent !== undefined) {
      this.#emit(normalizeEventLine(this.#pendingEvent, ""), chunks)
      this.#pendingEvent = undefined
    }
    return this.#step(chunks)
  }
}
