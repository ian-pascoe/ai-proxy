// Config normalisation gaps against the Go Sanitize* functions (config_normalization.go, vertex_compat.go).
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { parseConfigYaml } from "../src/config/codec.ts"

const parse = (yaml: string) => parseConfigYaml(yaml)

describe("duplicate API keys are removed across the whole flattened list", () => {
  it.effect("gemini: same key/base-url/proxy/prefix/headers in different groups", () =>
    Effect.gen(function* () {
      const config = yield* parse(`
api-keys:
  gemini:
    - name: one
      headers: { A: "1", B: "2" }
      keys: [{ api-key: g1 }, { api-key: g1 }, { api-key: g2 }]
    - name: two
      headers: { B: "2", A: "1" }
      keys: [{ api-key: g1 }, { api-key: g3 }]
    - name: three
      keys: [{ api-key: g1 }]
`)

      const groups = config["api-keys"].gemini
      // Header order does not matter; a different header set is a different credential.
      assert.deepStrictEqual(
        groups.map((group) => [group.name, group.keys.map((key) => key["api-key"])]),
        [
          ["one", ["g1", "g2"]],
          ["two", ["g3"]],
          ["three", ["g1"]]
        ]
      )
    })
  )

  it.effect("gemini: entry-level overrides take part in the identity and empty groups disappear", () =>
    Effect.gen(function* () {
      const config = yield* parse(`
api-keys:
  gemini:
    - name: one
      prefix: team
      keys: [{ api-key: g1 }]
    - name: two
      keys: [{ api-key: g1, prefix: team }]
    - name: three
      keys: [{ api-key: g1, proxy-url: "http://p" }]
`)

      assert.deepStrictEqual(
        config["api-keys"].gemini.map((group) => group.name),
        ["one", "three"]
      )
    })
  )

  it.effect("interactions keys are deduplicated like gemini keys", () =>
    Effect.gen(function* () {
      const config = yield* parse(`
api-keys:
  interactions:
    - name: a
      keys: [{ api-key: k }]
    - name: b
      keys: [{ api-key: k }]
`)

      assert.strictEqual(config["api-keys"].interactions.length, 1)
    })
  )

  it.effect(
    "vertex: api-key + base-url identify a credential; keys without api-key and incomplete models are dropped",
    () =>
      Effect.gen(function* () {
        const config = yield* parse(`
api-keys:
  vertex:
    - name: a
      base-url: https://v.example
      models: [{ name: m1, alias: a1 }, { name: m2 }, { name: "", alias: a3 }]
      keys: [{ api-key: v1 }, { api-key: "" }, { api-key: v1 }]
    - name: b
      base-url: https://v.example
      keys: [{ api-key: v1 }, { api-key: v2 }]
    - name: c
      base-url: https://other.example
      keys: [{ api-key: v1 }]
`)

        const groups = config["api-keys"].vertex
        assert.deepStrictEqual(
          groups.map((group) => [group.name, group.keys.map((key) => key["api-key"])]),
          [
            ["a", ["v1"]],
            ["b", ["v2"]],
            ["c", ["v1"]]
          ]
        )
        assert.deepStrictEqual(groups[0]?.models, [{ name: "m1", alias: "a1" }])
      })
  )
})

describe("credential-less entries", () => {
  it.effect("legacy gemini entries with only a base URL are accepted (Go keeps base-url-only entries)", () =>
    Effect.gen(function* () {
      const config = yield* parse(`
gemini-api-key:
  - base-url: https://gateway.example
  - api-key: ""
  - api-key: g1
`)

      const groups = config["api-keys"].gemini
      assert.strictEqual(groups.length, 2)
      assert.strictEqual(groups[0]?.["base-url"], "https://gateway.example")
      assert.strictEqual(groups[0]?.keys[0]?.["api-key"], "")
      assert.strictEqual(groups[1]?.keys[0]?.["api-key"], "g1")
    })
  )

  it.effect("v8 gemini keys without api-key are accepted next to a base URL and dropped without one", () =>
    Effect.gen(function* () {
      const config = yield* parse(`
api-keys:
  gemini:
    - name: gw
      base-url: https://gateway.example
      keys: [{}]
    - name: nothing
      keys: [{}]
`)

      assert.deepStrictEqual(
        config["api-keys"].gemini.map((group) => group.name),
        ["gw"]
      )
    })
  )
})
