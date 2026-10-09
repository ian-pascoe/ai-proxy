/**
 * Per-attempt usage collector used by executors.
 *
 * Go source: internal/runtime/executor/helps/usage_helpers.go (UsageReporter: Publish, PublishFailure, TrackFailure,
 * EnsurePublished, ObserveResponseModel, ObserveTokenEvent/MarkFirstResponseByte (TTFT), StreamUsageBuffer keeping
 * the latest stream usage). Executors feed it; the pipeline calls `finish` exactly once when the attempt is over
 * (stream end included) and publishes the record with its v2 token breakdown.
 */
import { ensureTokenBreakdown } from "./accounting.ts"
import { mergeStreamUsageDetail } from "./parsers.ts"
import type { UsageDetail, UsageRecord } from "./record.ts"
import { emptyUsageDetail, hasNonZeroTokenUsage } from "./record.ts"

export interface UsageReporterInit {
  readonly requestId: string
  /** Inbound HTTP request id shared by all attempts (usage `trace_id`). */
  readonly traceId?: string
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
  readonly generate?: boolean
  readonly serviceTier: string
  readonly reasoningEffort?: string
  readonly requestedAt: number
}

export class UsageReporter {
  #detail: UsageDetail | undefined
  #failure: { statusCode: number; body: string } | undefined
  #responseModel: string | undefined
  #ttftAt: number | undefined
  #firstPacketAt: number | undefined
  #reasoningEffort: string | undefined
  #finished = false

  constructor(readonly init: UsageReporterInit) {
    this.#reasoningEffort = init.reasoningEffort
  }

  /**
   * `MarkFirstResponseByte`: the first upstream response byte is the effective TTFT (non-stream attempts and
   * executors that do not inspect token events).
   */
  markFirstByte(now: number): void {
    this.#firstPacketAt ??= now
    this.#ttftAt ??= now
  }

  /** `RecordFirstPacket`: arrival of the first frame, the TTFT fallback while no token event was seen. */
  recordFirstPacket(now: number): void {
    this.#firstPacketAt ??= now
  }

  /** `ObserveTokenEvent`: the first substantive token event is the effective TTFT, any first frame the fallback. */
  observeTokenEvent(now: number, isToken: boolean): void {
    if (this.#ttftAt !== undefined) return
    this.#firstPacketAt ??= now
    if (isToken) this.#ttftAt = now
  }

  /** Whether the effective TTFT is already known (callers can skip token-event detection). */
  get ttftObserved(): boolean {
    return this.#ttftAt !== undefined
  }

  /**
   * `StreamUsageBuffer.Observe`: the latest usage wins; a tier-only update only refreshes the response service tier
   * and an earlier tier survives later updates without one.
   */
  publish(detail: UsageDetail): void {
    const previous = this.#detail
    const tier = detail.responseServiceTier?.trim() ?? ""
    if (tier === "" || hasNonZeroTokenUsage(detail)) {
      const preserved = previous?.responseServiceTier
      this.#detail =
        detail.responseServiceTier === undefined && preserved !== undefined
          ? { ...detail, responseServiceTier: preserved }
          : detail
    } else {
      this.#detail = { ...(previous ?? emptyUsageDetail), responseServiceTier: tier }
    }
  }

  /** `ObserveMergedStreamUsage`: for protocols that report usage across several events (Claude, Interactions). */
  publishMerged(detail: UsageDetail): void {
    this.publish(this.#detail === undefined ? detail : mergeStreamUsageDetail(this.#detail, detail))
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
    // Go `normalizeUsageDetailTotal`: every record leaves with a valid v2 breakdown for its provider's semantics.
    const detail = ensureTokenBreakdown(this.#detail ?? emptyUsageDetail, init.provider, init.executorType)
    const ttftAt = this.#ttftAt ?? this.#firstPacketAt
    return {
      requestId: init.requestId,
      ...(init.traceId !== undefined ? { traceId: init.traceId } : {}),
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
      ...(init.generate === false ? { generate: false } : {}),
      requestedAt: init.requestedAt,
      latencyMs: Math.max(0, now - init.requestedAt),
      ...(ttftAt !== undefined ? { ttftMs: Math.max(0, ttftAt - init.requestedAt) } : {}),
      failed: this.#failure !== undefined,
      ...(this.#failure !== undefined ? { fail: this.#failure } : {}),
      detail,
      ...(this.#responseModel !== undefined ? { responseModel: this.#responseModel } : {}),
      ...(this.#reasoningEffort !== undefined ? { reasoningEffort: this.#reasoningEffort } : {}),
      serviceTier: init.serviceTier
    }
  }
}
