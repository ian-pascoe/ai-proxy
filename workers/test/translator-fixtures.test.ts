// Golden translator fixtures generated from the Go registry by `go run ./workers/tools/fixturegen/translator`.
// Every file under test/fixtures/translator is picked up automatically; provider slices only add corpus files.
import { describe, expect, it } from "vitest"
import { summaryHooks as thinkingSummaryHooks } from "../src/executor/thinking.ts"
import type { Json } from "../src/json/index.ts"
import { builtinTranslators } from "../src/translator/builtin.ts"
import { setModelInfoLookup } from "../src/translator/model-info.ts"
import { makeTranslationState } from "../src/translator/registry.ts"
import { catalogLookup } from "./support/thinking.ts"

// Translators that consult the model registry (e.g. Claude adaptive thinking) use the Go static catalog.
setModelInfoLookup(catalogLookup)

interface FixtureCase {
  readonly name: string
  readonly from: string
  readonly to: string
  readonly model: string
  readonly stream: boolean
  readonly needs?: ReadonlyArray<string>
  readonly alt?: string
  readonly request: Json
  readonly responseLines?: ReadonlyArray<string>
  readonly responseBodyText?: string
  readonly tokenCount?: number
  readonly tokenCountUsage?: Json
  readonly translatedRequest: string
  readonly requestError?: string
  readonly streamOutputs?: ReadonlyArray<ReadonlyArray<string>>
  readonly nonStreamOutput?: string
  readonly tokenCountOutput?: string
}

/**
 * Capabilities implemented on the TypeScript side. Cases that need anything else are skipped (e.g. the thinking
 * slice adds "thinking-summary" once the summary hooks are wired into the registry).
 */
const SUPPORTED_NEEDS = new Set<string>(["thinking-summary"])
const summaryHooks = thinkingSummaryHooks

const files = import.meta.glob<{ default: ReadonlyArray<FixtureCase> }>("./fixtures/translator/*.json", {
  eager: true
})

/** Wall-clock fields the Go translators stamp with `time.Now()`; their values cannot match across runs. */
const normalizeClock = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(normalizeClock)
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        (key === "created" || key === "created_at" || key === "completed_at") && typeof item === "number" && item > 1e9
          ? 0
          : (key === "createTime" || key === "created" || key === "updated") &&
              typeof item === "string" &&
              /^\d{4}-\d\d-\d\dT/.test(item)
            ? "<time>"
            : typeof item === "string" && /^(interaction|msg)_\d{15,}$/.test(item)
              ? item.replace(/\d+$/, "<n>")
              : normalizeClock(item)
      ])
    )
  }
  return value
}

const canonicalJson = (text: string): string | undefined => {
  try {
    return JSON.stringify(normalizeClock(JSON.parse(text)))
  } catch {
    return undefined
  }
}

/** Normalises JSON formatting (Go keeps raw bytes) while keeping key order, SSE framing and non-JSON text exact. */
const normalizeChunk = (text: string): string =>
  canonicalJson(text) ??
  text
    .split("\n")
    .map((line) => {
      if (!line.startsWith("data:")) return line
      const json = canonicalJson(line.slice(5).trim())
      return json === undefined ? line : `data: ${json}`
    })
    .join("\n")

describe("translator golden fixtures", () => {
  for (const [file, module] of Object.entries(files)) {
    describe(file.replace("./fixtures/translator/", ""), () => {
      for (const c of module.default) {
        const missing = (c.needs ?? []).filter((need) => !SUPPORTED_NEEDS.has(need))
        const test = missing.length > 0 ? it.skip : it
        test(missing.length > 0 ? `${c.name} (needs ${missing.join(", ")})` : c.name, () => {
          const envelope = builtinTranslators.translateRequest(
            c.from,
            c.to,
            {
              format: c.from,
              model: c.model,
              stream: c.stream,
              body: structuredClone(c.request)
            },
            summaryHooks
          )
          expect(envelope.error?.message).toBe(c.requestError)
          expect(JSON.stringify(envelope.body)).toBe(canonicalJson(c.translatedRequest))

          if (c.responseLines !== undefined) {
            const context = {
              model: c.model,
              originalRequest: c.request,
              translatedRequest: envelope.body,
              // The Go corpus runs the raw translators; the Claude input token estimate has its own fixtures.
              state: { ...makeTranslationState(), claudeInputTokensHandled: true },
              ...(c.alt !== undefined ? { alt: c.alt } : {})
            }
            const outputs = c.responseLines.map((line) =>
              builtinTranslators.translateStream(c.from, c.to, context, line).map(normalizeChunk)
            )
            expect(outputs).toEqual((c.streamOutputs ?? []).map((chunks) => chunks.map(normalizeChunk)))
          }
          if (c.responseBodyText !== undefined) {
            const context = {
              model: c.model,
              originalRequest: c.request,
              translatedRequest: envelope.body,
              state: makeTranslationState(),
              ...(c.alt !== undefined ? { alt: c.alt } : {})
            }
            const out = builtinTranslators.translateNonStream(c.from, c.to, context, c.responseBodyText)
            expect(out === undefined ? undefined : normalizeChunk(out)).toEqual(
              c.nonStreamOutput === undefined ? undefined : normalizeChunk(c.nonStreamOutput)
            )
          }
          if (c.tokenCount !== undefined) {
            const out = builtinTranslators.translateTokenCount(
              c.from,
              c.to,
              c.tokenCount,
              JSON.stringify(c.tokenCountUsage ?? null)
            )
            expect(normalizeChunk(out)).toBe(normalizeChunk(c.tokenCountOutput ?? ""))
          }
        })
      }
    })
  }

  it("found fixture files", () => {
    expect(Object.keys(files).length).toBeGreaterThan(0)
  })
})
