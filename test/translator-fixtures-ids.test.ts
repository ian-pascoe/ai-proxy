// Golden fixtures that the shared harness (translator-fixtures.test.ts) skips: cases whose Go output contains
// process-wide counters or timestamps in generated tool-call ids (`needs: ["id-normalization"]`, ids are masked on
// both sides before comparing) and cases that depend on the thinking summary hooks (`needs: ["thinking-summary"]`,
// the real hooks are applied here). Everything else must match the Go output exactly.
import { describe, expect, it } from "vitest"
import type { Json } from "../src/json/index.ts"
import { builtinTranslators } from "../src/translator/builtin.ts"
import { makeTranslationState, type SummaryHooks } from "../src/translator/registry.ts"
import {
  applySummaryConfigForModel,
  extractTranslatedSummaryConfig,
  type SummaryConfig
} from "../src/thinking/summary.ts"

interface FixtureCase {
  readonly name: string
  readonly from: string
  readonly to: string
  readonly model: string
  readonly stream: boolean
  readonly needs?: ReadonlyArray<string>
  readonly request: Json
  readonly responseLines?: ReadonlyArray<string>
  readonly responseBodyText?: string
  readonly translatedRequest: string
  readonly requestError?: string
  readonly streamOutputs?: ReadonlyArray<ReadonlyArray<string>>
  readonly nonStreamOutput?: string
}

const SUPPORTED = new Set(["id-normalization", "thinking-summary"])

const hooks: SummaryHooks = {
  extract: (body, client, provider) => extractTranslatedSummaryConfig(body, client, provider),
  apply: (body, provider, model, summary) =>
    applySummaryConfigForModel(body, provider, model, summary as SummaryConfig) ?? body
}

const files = import.meta.glob<{ default: ReadonlyArray<FixtureCase> }>("./fixtures/translator/*.json", {
  eager: true
})

const canonicalJson = (text: string): string | undefined => {
  try {
    return JSON.stringify(JSON.parse(text))
  } catch {
    return undefined
  }
}

/**
 * Masks generated ids and timestamps: `"id":"name-<counter>"`, `"id":"name-<unix nano>-<counter>"`, `interaction_<nanos>`,
 * `step_<nanos>`, `response_<nanos>`, Responses ids (`resp_<hex nanos>_<counter>`, `call_...` and the ids derived from
 * them) and RFC 3339 `created`/`updated` values.
 */
const maskIds = (text: string): string =>
  text
    .replace(/("(?:id|call_id|item_id|tool_call_id)"\s*:\s*"[^"]*?)-\d+(?:-\d+)?(")/g, "$1-N$2")
    .replace(/\b(interaction|step|response)_\d{10,}\b/g, "$1_N")
    .replace(/(call|resp)_[0-9a-f]{10,}_\d+/g, "$1_N")
    .replace(/(msg|rs|ws)_[0-9a-f]{12,}_\d+/g, "$1_N")
    .replace(/("created_at"\s*:\s*)\d+/g, "$1N")
    .replace(/("(?:created|updated)"\s*:\s*")\d{4}-\d\d-\d\dT[^"]*(")/g, "$1T$2")

const normalize = (text: string): string => {
  const canonical = canonicalJson(text)
  if (canonical !== undefined) return maskIds(canonical)
  return maskIds(
    text
      .split("\n")
      .map((line) => {
        if (!line.startsWith("data:")) return line
        const json = canonicalJson(line.slice(5).trim())
        return json === undefined ? line : `data: ${json}`
      })
      .join("\n")
  )
}

describe("translator golden fixtures with generated ids", () => {
  for (const [file, module] of Object.entries(files)) {
    const cases = module.default.filter(
      (c) => (c.needs ?? []).length > 0 && (c.needs ?? []).every((need) => SUPPORTED.has(need))
    )
    if (cases.length === 0) continue
    describe(file.replace("./fixtures/translator/", ""), () => {
      for (const c of cases) {
        it(c.name, () => {
          const envelope = builtinTranslators.translateRequest(
            c.from,
            c.to,
            { format: c.from, model: c.model, stream: c.stream, body: structuredClone(c.request) },
            hooks
          )
          expect(envelope.error?.message).toBe(c.requestError)
          expect(JSON.stringify(envelope.body)).toBe(canonicalJson(c.translatedRequest))
          const context = () => ({
            model: c.model,
            originalRequest: c.request,
            translatedRequest: envelope.body,
            // The Go corpus runs the raw translators; the Claude input token estimate has its own fixtures.
            state: { ...makeTranslationState(), claudeInputTokensHandled: true }
          })
          if (c.responseLines !== undefined) {
            const state = context()
            const outputs = c.responseLines.map((line) =>
              builtinTranslators.translateStream(c.from, c.to, state, line).map(normalize)
            )
            expect(outputs).toEqual((c.streamOutputs ?? []).map((chunks) => chunks.map(normalize)))
          }
          if (c.responseBodyText !== undefined) {
            const out = builtinTranslators.translateNonStream(c.from, c.to, context(), c.responseBodyText)
            expect(out === undefined ? undefined : normalize(out)).toEqual(
              c.nonStreamOutput === undefined ? undefined : normalize(c.nonStreamOutput)
            )
          }
        })
      }
    })
  }
})
