// Parity backlog (#29 part 2) for Codex: `resolveCodexModelIsCompat` config fallback and models.json override headers.
import { describe, expect, it } from "vitest"
import { resolveCodexModelIsCompat } from "../src/executor/codex/compat.ts"
import { makeCodexExecutor } from "../src/executor/codex/executor.ts"
import { modelOverrideHeaders } from "../src/executor/helps/model-headers.ts"
import type { ThinkingModelInfo } from "../src/thinking/index.ts"
import { apiKeyCredential } from "./support/codex.ts"
import { execute, harness, json, loadConfig, options } from "./support/executor-run.ts"

const compatYaml = `
api-keys:
  codex:
    - base-url: https://codex.example.test/v1
      keys:
        - api-key: sk-codex-1
          models:
            - name: gpt-5.4
              alias: team-gpt
              is-compat: true
            - name: plain
`

describe("resolveCodexModelIsCompat", () => {
  it("prefers the resolved model info", async () => {
    const config = await loadConfig(compatYaml)
    const credential = apiKeyCredential()
    const info: ThinkingModelInfo = { id: "gpt-5.4", isCompat: false }
    expect(resolveCodexModelIsCompat(config, credential, { model: "gpt-5.4", modelInfo: info }, "gpt-5.4")).toBe(false)
    expect(
      resolveCodexModelIsCompat(
        config,
        credential,
        { model: "plain", modelInfo: { id: "plain", isCompat: true } },
        "plain"
      )
    ).toBe(true)
  })

  it("falls back to the credential's config entry by name or alias when no model info is bound", async () => {
    const config = await loadConfig(compatYaml)
    const credential = apiKeyCredential()
    expect(resolveCodexModelIsCompat(config, credential, { model: "team-gpt" }, "team-gpt")).toBe(true)
    expect(resolveCodexModelIsCompat(config, credential, { model: "GPT-5.4(high)" }, "gpt-5.4")).toBe(true)
    // A configured models list is authoritative: unknown models are not compat.
    expect(resolveCodexModelIsCompat(config, credential, { model: "plain" }, "plain")).toBe(false)
    expect(resolveCodexModelIsCompat(config, credential, { model: "other" }, "other")).toBe(false)
  })

  it("is false without a config entry and honours config_index", async () => {
    const config = await loadConfig(compatYaml)
    expect(
      resolveCodexModelIsCompat(
        config,
        apiKeyCredential({ attributes: { api_key: "sk-unknown" } }),
        { model: "team-gpt" },
        "team-gpt"
      )
    ).toBe(false)
    expect(
      resolveCodexModelIsCompat(
        config,
        apiKeyCredential({ attributes: { config_index: "0", base_url: "https://codex.example.test/v1" } }),
        { model: "team-gpt" },
        "team-gpt"
      )
    ).toBe(true)
  })
})

describe("models.json override_header", () => {
  it("copies the entry's headers with trimmed names and drops empty ones", () => {
    const lookup = (id: string): ThinkingModelInfo | undefined =>
      id === "m" ? { id, config: { overrideHeader: { " X-A ": "1", " ": "2" } } } : { id }
    expect(modelOverrideHeaders(lookup, "m")).toEqual({ "X-A": "1" })
    expect(modelOverrideHeaders(lookup, "other")).toBeUndefined()
    expect(modelOverrideHeaders(undefined, "m")).toBeUndefined()
  })

  it("forces the headers onto the upstream request from the attempt's registry lookup", async () => {
    const lookup = (id: string): ThinkingModelInfo | undefined =>
      id === "gpt-5.4"
        ? { id, config: { overrideHeader: { "X-Forced": "yes", "User-Agent": "custom-agent" } } }
        : undefined
    const h = await harness(
      apiKeyCredential(),
      () =>
        new Response(
          `data: ${JSON.stringify({ type: "response.completed", response: { id: "r", status: "completed", output: [], usage: {} } })}\n\n`,
          { status: 200, headers: { "content-type": "text/event-stream" } }
        )
    )
    await execute(
      makeCodexExecutor(),
      h,
      { model: "gpt-5.4", payload: json({ model: "gpt-5.4", input: "hi" }), modelLookup: lookup },
      options({ sourceFormat: "openai-response", metadata: { ...options().metadata, requestPath: "/v1/responses" } })
    )
    expect(h.calls[0]?.headers["x-forced"]).toBe("yes")
    expect(h.calls[0]?.headers["user-agent"]).toBe("custom-agent")
  })
})

describe("image tool usage (PublishAdditionalModel)", () => {
  const completed = (toolUsage: unknown) =>
    `data: ${JSON.stringify({
      type: "response.completed",
      response: {
        id: "r",
        status: "completed",
        output: [],
        usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
        ...(toolUsage === undefined ? {} : { tool_usage: { image_gen: toolUsage } })
      }
    })}\n\n`
  const run = async (toolUsage: unknown, tools: unknown[]) => {
    const h = await harness(apiKeyCredential(), () => new Response(completed(toolUsage), { status: 200 }))
    await execute(
      makeCodexExecutor(),
      h,
      { model: "gpt-5.4", payload: json({ model: "gpt-5.4", input: "draw", tools }) },
      options({ sourceFormat: "openai-response", metadata: { ...options().metadata, requestPath: "/v1/responses" } })
    )
    return h.usage.additionalRecords(1)
  }

  it("publishes the tool's tokens under the image_generation tool model as an extra record", async () => {
    const [record, ...rest] = await run({ input_tokens: 7, output_tokens: 3, total_tokens: 10 }, [
      { type: "image_generation", model: "gpt-image-1.5" }
    ])
    expect(rest).toEqual([])
    expect(record).toMatchObject({ model: "gpt-image-1.5", failed: false, provider: "codex" })
    expect(record?.detail).toMatchObject({ inputTokens: 7, outputTokens: 3, totalTokens: 10 })
    expect(record?.requestId).not.toBe("")
  })

  it("defaults the model and ignores a missing or empty tool usage", async () => {
    expect((await run({ input_tokens: 1, output_tokens: 1, total_tokens: 2 }, []))[0]?.model).toBe("gpt-image-2")
    expect(await run(undefined, [])).toEqual([])
    expect(await run({ input_tokens: 0, output_tokens: 0, total_tokens: 0 }, [])).toEqual([])
  })
})
