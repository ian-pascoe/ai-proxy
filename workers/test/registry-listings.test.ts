import { describe, expect, it } from "vitest"
import { resolveClaudeModelIdPrefix, ensureClaudeModelIdPrefix, goJson } from "../src/registry/listings.ts"
import { respondGeminiDetail, respondGeminiList, respondModels } from "../src/registry/models-api.ts"
import { sectionModels, SECTIONS } from "../src/registry/catalog.ts"
import {
  canon,
  catalogs,
  fixture,
  fixtureNow,
  fromGo,
  type FixtureRequest,
  scenarioIndex,
  sortedBody
} from "./support/registry.ts"

describe("embedded catalogs match the Go registry", () => {
  it.each(SECTIONS)("section %s (incl. built-ins)", (section) => {
    const expected = (fixture.sections[section] ?? []).map((model) => canon(fromGo(model)))
    const actual = sectionModels(catalogs, section).map((model) => canon(model))
    expect(actual).toEqual(expected)
  })
})

const replyFor = (scenario: (typeof fixture.scenarios)[number], request: FixtureRequest) => {
  const index = scenarioIndex(scenario)
  const models = index.availableModels(fixtureNow())
  const headers = request.headers ?? {}
  const info = {
    userAgent: headers["User-Agent"] ?? "",
    anthropicVersion: headers["Anthropic-Version"] ?? "",
    clientVersion: undefined
  }
  const options = { disableCloaking: scenario.disableCloaking === true }
  if (request.path.startsWith("/v1beta/models/")) {
    return respondGeminiDetail(models, request.path.slice("/v1beta/models/".length))
  }
  if (request.path === "/v1beta/models") return respondGeminiList(models)
  const rest = request.path.startsWith("/v1/models/") ? request.path.slice("/v1/models/".length) : undefined
  return respondModels(models, info, options, rest)
}

/** Lists whose order is Go map-iteration order are compared after sorting. */
const UNORDERED: Record<string, Record<string, string>> = {
  "openai list": { data: "id" },
  "gemini list": { models: "name" }
}

describe("listing parity with the Go handlers", () => {
  for (const scenario of fixture.scenarios) {
    describe(scenario.name, () => {
      it.each(scenario.requests.map((request) => [request.name, request] as const))("%s", (_name, request) => {
        const reply = replyFor(scenario, request)
        expect(reply.status).toBe(request.status)
        const sort = UNORDERED[request.name]
        if (sort === undefined) {
          expect(reply.body).toBe(request.body)
        } else {
          expect(goJson(sortedBody(reply.body, sort))).toBe(goJson(sortedBody(request.body, sort)))
        }
      })
    })
  }
})

describe("Claude ID cloaking", () => {
  it("cloaks ids without the claude- prefix and reverses by code points", () => {
    expect(ensureClaudeModelIdPrefix("gpt-5")).toBe("claude-fable-5-dd-5-tpg")
    expect(ensureClaudeModelIdPrefix("claude-opus")).toBe("claude-opus")
    expect(ensureClaudeModelIdPrefix("")).toBe("")
    expect(ensureClaudeModelIdPrefix("模型-1")).toBe("claude-fable-5-dd-1-型模")
  })

  it("resolves cloaked ids and keeps a thinking suffix", () => {
    expect(resolveClaudeModelIdPrefix("claude-fable-5-dd-5-tpg")).toBe("gpt-5")
    expect(resolveClaudeModelIdPrefix("claude-fable-5-dd-5-tpg(high)")).toBe("gpt-5(high)")
    expect(resolveClaudeModelIdPrefix("claude-fable-5-dd-")).toBe("claude-fable-5-dd-")
    expect(resolveClaudeModelIdPrefix("gpt-5")).toBe("gpt-5")
  })
})
