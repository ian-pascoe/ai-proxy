/**
 * Per-attempt usage collector used by executors.
 *
 * Go source: internal/runtime/executor/helps/usage_helpers.go (UsageReporter: Publish, PublishFailure, TrackFailure,
 * EnsurePublished, ObserveResponseModel, StreamUsageBuffer keeping the latest stream usage). Executors feed it; the
 * pipeline calls `finish` exactly once when the attempt is over (stream end included) and publishes the record.
 */
import type { UsageDetail, UsageRecord } from "./record.ts"
import { emptyUsageDetail } from "./record.ts"

export interface UsageReporterInit {
  readonly requestId: string
  readonly provider: string
  readonly executorType: string
  readonly model: string
  readonly alias: string
  readonly endpoint: string
  readonly principalId: string
  readonly authId: string
  readonly authType: string
  readonly source: string
  readonly stream: boolean
  readonly serviceTier: string
  readonly reasoningEffort?: string
  readonly requestedAt: number
}

export class UsageReporter {
  #detail: UsageDetail | undefined
  #failure: { statusCode: number; body: string } | undefined
  #responseModel: string | undefined
  #firstByteAt: number | undefined
  #reasoningEffort: string | undefined
  #finished = false

  constructor(readonly init: UsageReporterInit) {
    this.#reasoningEffort = init.reasoningEffort
  }

  /** Records the time of the first upstream response byte / event (TTFT). */
  markFirstByte(now: number): void {
    this.#firstByteAt ??= now
  }

  /** Latest usage wins (stream usage arrives in the last chunks). */
  publish(detail: UsageDetail): void {
    this.#detail = detail
  }

  /** Marks the attempt failed; the first failure is kept. */
  fail(statusCode: number, body: string): void {
    this.#failure ??= { statusCode: statusCode > 0 ? statusCode : 500, body }
  }

  observeResponseModel(model: string | undefined): void {
    if (model !== undefined) this.#responseModel = model
  }

  /** The reasoning effort actually sent upstream (after translation/thinking). */
  setReasoningEffort(effort: string | undefined): void {
    if (effort !== undefined && effort !== "") this.#reasoningEffort = effort
  }

  get failed(): boolean {
    return this.#failure !== undefined
  }

  /** Builds the record once; later calls return `undefined` (exactly one record per attempt). */
  finish(now: number): UsageRecord | undefined {
    if (this.#finished) return undefined
    this.#finished = true
    const { init } = this
    return {
      requestId: init.requestId,
      provider: init.provider,
      executorType: init.executorType,
      model: init.model,
      alias: init.alias,
      endpoint: init.endpoint,
      principalId: init.principalId,
      authId: init.authId,
      authType: init.authType,
      source: init.source,
      stream: init.stream,
      requestedAt: init.requestedAt,
      latencyMs: Math.max(0, now - init.requestedAt),
      ...(this.#firstByteAt !== undefined ? { ttftMs: Math.max(0, this.#firstByteAt - init.requestedAt) } : {}),
      failed: this.#failure !== undefined,
      ...(this.#failure !== undefined ? { fail: this.#failure } : {}),
      detail: this.#detail ?? emptyUsageDetail,
      ...(this.#responseModel !== undefined ? { responseModel: this.#responseModel } : {}),
      ...(this.#reasoningEffort !== undefined ? { reasoningEffort: this.#reasoningEffort } : {}),
      serviceTier: init.serviceTier
    }
  }
}
