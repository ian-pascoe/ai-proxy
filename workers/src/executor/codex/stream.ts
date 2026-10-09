/**
 * Line-by-line Codex SSE stream processing.
 *
 * Go source: internal/runtime/executor/codex_executor_stream.go (ExecuteStream reader loop, without bootstrap
 * buffering which belongs to the retry slice). Each upstream line is observed (usage, response model, output items,
 * terminal failures), then translated to the client format. `data:` payloads are forwarded as received; only the
 * terminal event is re-serialised (`response.done` renamed, `response.output` patched).
 */
import { restoreCodexMultiAgentV2Response } from "../helps/codex-multi-agent-v2.ts"
import { asString, get, isJsonObject, type Json, type JsonObject, tryParseJson } from "../../json/index.ts"
import { Formats } from "../../translator/formats.ts"
import type { ResponseContext, TranslatorRegistry } from "../../translator/registry.ts"
import { responseModelOf } from "../../usage/record.ts"
import type { UsageReporter } from "../../usage/reporter.ts"
import { isResponsesTokenEvent } from "../../usage/ttft.ts"
import type { ExecutionError } from "../errors.ts"
import {
  codexClosedBeforeFirstPayloadError,
  codexEmptyIncompleteStreamError,
  codexIncompleteStreamError,
  codexTerminalFailure
} from "./errors.ts"
import {
  ensureResponsesUsageDetails,
  hasMeaningfulOutputDelta,
  isTerminalEmptyIncomplete,
  normalizeCodexCompletion,
  OutputItemCollector,
  parseCodexUsage,
  patchCodexCompletedOutput
} from "./output.ts"
import type { CodexReplayScope } from "./replay.ts"

export interface CodexStreamStep {
  readonly chunks: ReadonlyArray<string>
  readonly error?: ExecutionError
  /** Stop reading (terminal event or failure). */
  readonly stop: boolean
  /** A completed event whose reasoning/tool calls should be cached for replay. */
  readonly cacheCompleted?: Json
  /** Failure body/status that may require clearing the replay cache. */
  readonly failureBody?: { readonly status: number; readonly body: string }
}

export interface CodexStreamOptions {
  readonly registry: TranslatorRegistry
  /** Client protocol of the response. */
  readonly responseFormat: string
  /** Provider format of the upstream (`codex`). */
  readonly providerFormat: string
  readonly context: ResponseContext
  readonly usage: UsageReporter
  /** Native Codex clients receive the upstream output untouched. */
  readonly preserveNativeOutput: boolean
  readonly modelLevelCooling: boolean
  readonly nowMs: () => number
  readonly replayScope: CodexReplayScope
  /** The request was optimised for multi-agent v2: restore the collaboration namespace in every event. */
  readonly multiAgentV2?: boolean
}

export class CodexStreamReader {
  readonly #collector = new OutputItemCollector()
  #sawOutputDelta = false
  #emitted = 0
  #stopped = false

  constructor(readonly options: CodexStreamOptions) {}

  #translate(line: string): string[] {
    const { registry, responseFormat, providerFormat, context } = this.options
    const chunks = [...registry.translateStream(responseFormat, providerFormat, context, line)]
    const out =
      responseFormat === Formats.OpenAIResponse ? chunks.map((chunk) => ensureResponsesUsageDetails(chunk)) : chunks
    for (const chunk of out) if (chunk.length > 0) this.#emitted++
    return out
  }

  /** Feeds one upstream line (without terminator). */
  push(line: string): CodexStreamStep {
    if (this.#stopped) return { chunks: [], stop: true }
    if (!line.startsWith("data:")) return { chunks: this.#translate(line), stop: false }
    const { usage, modelLevelCooling, nowMs } = this.options
    const payload = restoreCodexMultiAgentV2Response(line.slice(5).trim(), this.options.multiAgentV2 === true)
    const parsed = tryParseJson(payload)
    usage.observeResponseModel(responseModelOf(parsed))
    if (!usage.ttftObserved) usage.observeTokenEvent(nowMs(), isResponsesTokenEvent(payload))
    const eventType = asString(get(parsed, "type"))

    const failure = codexTerminalFailure(parsed, { modelLevelCooling, nowMs: nowMs() })
    if (failure !== undefined) {
      this.#stopped = true
      return {
        chunks: [],
        error: failure.error,
        stop: true,
        failureBody: { status: failure.error.status, body: failure.body }
      }
    }
    if (hasMeaningfulOutputDelta(parsed)) this.#sawOutputDelta = true
    if (isTerminalEmptyIncomplete(parsed, this.#collector.count, this.#sawOutputDelta)) {
      this.#stopped = true
      return { chunks: [], error: codexEmptyIncompleteStreamError(), stop: true }
    }
    switch (eventType) {
      case "response.output_item.done":
        this.#collector.collect(parsed)
        break
      case "response.completed":
      case "response.incomplete":
      case "response.done": {
        this.#stopped = true
        if (!isJsonObject(parsed)) break
        const event: JsonObject = normalizeCodexCompletion(parsed)
        const detail = parseCodexUsage(event)
        if (detail !== undefined) usage.publish(detail)
        if (!this.options.preserveNativeOutput) patchCodexCompletedOutput(event, this.#collector)
        const completed = eventType === "response.completed" || eventType === "response.done"
        return {
          chunks: this.#translate(`data: ${JSON.stringify(event)}`),
          stop: true,
          ...(completed ? { cacheCompleted: event } : {})
        }
      }
    }
    return { chunks: this.#translate(`data: ${payload}`), stop: false }
  }

  /** Clean EOF without a terminal event. */
  end(): CodexStreamStep {
    if (this.#stopped) return { chunks: [], stop: true }
    this.#stopped = true
    const error = this.#emitted === 0 ? codexClosedBeforeFirstPayloadError() : codexIncompleteStreamError()
    return { chunks: [], error, stop: true }
  }
}
