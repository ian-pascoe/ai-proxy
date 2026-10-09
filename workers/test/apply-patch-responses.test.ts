// Responses-format apply_patch bridge against the real Go implementation (`go run ./workers/tools/fixturegen/applypatch`):
// request normalisation, the common bridge and the executor-owned state with the xAI folded dispatcher.
import { describe, expect, it } from "vitest"
import { normalizeApplyPatchResponses, ApplyPatchResponsesState } from "../src/executor/helps/apply-patch-responses.ts"
import { type Json, tryParseJson } from "../src/json/index.ts"
import type { Format } from "../src/translator/formats.ts"
import fixtures from "./fixtures/applypatch.json"

/** Key-order-sensitive form of an output: JSON values are re-serialised, SSE data lines keep their prefix. */
const canonical = (text: string): string => {
  const data = /^data:\s*(\{.*\}|\[.*\])\s*$/s.exec(text.replace(/\n\n$/, ""))
  if (data?.[1] !== undefined) {
    const parsed = tryParseJson(data[1])
    return parsed === undefined ? text : `data: ${JSON.stringify(parsed)}${text.endsWith("\n\n") ? "\n\n" : ""}`
  }
  const parsed = text.startsWith("{") ? tryParseJson(text) : undefined
  return parsed === undefined ? text : JSON.stringify(parsed)
}

const parse = (text: string): Json => JSON.parse(text) as Json

describe("normalizeApplyPatchResponses (Go parity)", () => {
  for (const entry of fixtures.normalize) {
    it(entry.name, () => {
      const run = () =>
        normalizeApplyPatchResponses(
          parse(entry.body),
          entry.original === undefined ? undefined : parse(entry.original)
        )
      if (entry.err !== undefined && entry.err !== "") {
        expect(run).toThrow(entry.err)
        return
      }
      expect(JSON.stringify(run())).toBe(JSON.stringify(parse(entry.output ?? "")))
    })
  }
})

describe("ApplyPatchResponsesState scenarios (Go parity)", () => {
  for (const scenario of fixtures.scenarios) {
    it(scenario.name, () => {
      const declarations = scenario.declarations ?? scenario.original
      const state = new ApplyPatchResponsesState(
        scenario.source as Format,
        parse(scenario.original),
        parse(declarations)
      )
      for (const [name, namespace] of scenario.dispatchers ?? [])
        state.addDispatcher(name as string, namespace as string)
      expect(state.active).toBe(scenario.active)
      scenario.ops.forEach((op, index) => {
        const expected = scenario.steps[index] as { out?: string[] | null; err?: string }
        const label = `${scenario.name} #${index} ${op.op}`
        let events: string[] = []
        let error: Error | undefined
        const asText = (event: Json): string => (typeof event === "string" ? event : JSON.stringify(event))
        switch (op.op) {
          case "remember":
            state.rememberDispatcherEvent(parse(op.input ?? ""))
            return
          case "rememberArgs":
            state.rememberDispatcherArguments(parse(op.input ?? ""))
            return
          case "transform":
          case "rememberTransform": {
            const event = parse(op.input ?? "")
            if (op.op === "rememberTransform") state.rememberDispatcherEvent(event)
            const result = state.transform(event)
            events = result.events.map(asText)
            error = result.error
            break
          }
          case "stream": {
            const result = state.stream(op.input ?? "")
            events = result.lines
            error = result.error
            break
          }
          case "finish":
            error = state.finish()
            break
          case "bridgeFinish":
            error = state.bridge.finish()
            break
          case "finishStream": {
            const result = state.finishStream()
            events = result.lines
            error = result.error
            break
          }
          case "nonStream": {
            const result = state.bridge.transformNonStream(parse(op.input ?? ""))
            if ("error" in result) error = result.error
            else events = [JSON.stringify(result.body)]
            break
          }
        }
        expect(events.map(canonical), label).toEqual((expected.out ?? []).map(canonical))
        expect(error?.message ?? "", label).toBe(expected.err ?? "")
      })
    })
  }
})
