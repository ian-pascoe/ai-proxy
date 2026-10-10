// Local countTokens answers of the Codex, OpenAI-compatibility, xAI, Meta and Claude (gateway) executors compared with
// the real Go executors (go run ./tools/fixturegen/tokens).
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { makeClaudeExecutor } from "../src/executor/claude/executor.ts"
import { makeCodexExecutor } from "../src/executor/codex/executor.ts"
import { makeMetaExecutor } from "../src/executor/meta/executor.ts"
import { makeOpenAICompatExecutor } from "../src/executor/openai-compat/executor.ts"
import type { ProviderExecutor } from "../src/executor/types.ts"
import { makeXaiExecutor } from "../src/executor/xai/executor.ts"
import { credential, harness, options, runFail } from "./support/executor-run.ts"
import fixtures from "./fixtures/tokens.json"

const executors: Record<string, { executor: ProviderExecutor; credential: ReturnType<typeof credential> }> = {
  codex: { executor: makeCodexExecutor(), credential: credential("codex", { metadata: { access_token: "t" } }) },
  "openai-compat": {
    executor: makeOpenAICompatExecutor("openai-compatibility"),
    credential: credential("openai-compatibility", {
      kind: "apikey",
      attributes: { api_key: "k", base_url: "https://compat.test/v1" }
    })
  },
  xai: { executor: makeXaiExecutor(), credential: credential("xai", { metadata: { access_token: "t" } }) },
  meta: {
    executor: makeMetaExecutor(),
    credential: credential("meta", { kind: "apikey", attributes: { api_key: "k" } })
  },
  claude: {
    executor: makeClaudeExecutor(),
    credential: credential("claude", {
      kind: "apikey",
      attributes: { api_key: "k", base_url: "https://gateway.example.com" }
    })
  }
}

const noUpstream = () => new Response("unexpected upstream call", { status: 500 })

describe("countTokens parity with the Go executors", () => {
  for (const provider of Object.keys(executors)) {
    const cases = fixtures.executors.filter((c) => c.provider === provider)
    it(`${provider}: ${cases.length} scenarios`, async () => {
      const { executor, credential: cred } = executors[provider] as (typeof executors)[string]
      const h = await harness(cred, noUpstream)
      const mismatches: unknown[] = []
      for (const c of cases) {
        const opts = options({
          sourceFormat: c.source,
          headers: new Headers({ "user-agent": "codex_cli_rs/0.1" }),
          metadata: { ...options().metadata, requestPath: "/v1/messages/count_tokens" }
        })
        const request = { model: c.model, payload: JSON.parse(c.payload) }
        const result = await Effect.runPromise(
          Effect.result(executor.countTokens(h.context, request, opts).pipe(Effect.provide(h.layers)))
        )
        const label = `${c.source} ${c.model} ${c.payload.slice(0, 70)}`
        if (c.error !== undefined && c.error !== "") {
          if (result._tag === "Success" || !result.failure.message.includes(c.error)) {
            mismatches.push({
              label,
              want: `error: ${c.error}`,
              got: result._tag === "Success" ? result.success.payload : result.failure.message
            })
          }
        } else if (result._tag === "Failure") {
          mismatches.push({ label, want: c.out, got: `error: ${result.failure.message}` })
        } else if (JSON.stringify(JSON.parse(result.success.payload)) !== JSON.stringify(JSON.parse(c.out as string))) {
          mismatches.push({ label, want: c.out, got: result.success.payload })
        }
      }
      expect(mismatches).toEqual([])
      expect(h.calls).toHaveLength(0)
    })
  }

  it("Meta rejects a missing token like Go ensureAuth (401)", async () => {
    const h = await harness(credential("meta", { kind: "apikey" }), noUpstream)
    const error = await runFail(
      makeMetaExecutor().countTokens(
        h.context,
        { model: "m", payload: { input: "hi" } },
        options({ sourceFormat: "openai-response" })
      ),
      h.layers
    )
    expect(error.status).toBe(401)
  })
})
