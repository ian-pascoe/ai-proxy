import { describe, expect, it } from "vitest"
import {
  asBool,
  asFloat,
  asInt,
  asString,
  del,
  escapePathKey,
  exists,
  get,
  type Json,
  JsonPathError,
  set,
  setRaw,
  wildcardMatch
} from "../src/json/index.ts"
import fixtures from "./fixtures/json-path.json"

// Golden cases generated from the real tidwall/gjson + sjson by `go run ./workers/tools/fixturegen/jsonpath`.

const parse = (text: string): Json => JSON.parse(text) as Json

describe("gjson parity (golden fixtures)", () => {
  for (const [index, c] of fixtures.get.entries()) {
    it(`get #${index} ${JSON.stringify(c.path)}`, () => {
      const root = parse(c.json)
      const result = get(root, c.path)
      expect(result !== undefined, "exists").toBe(c.exists)
      if (c.exists) {
        expect(result).toEqual(parse(c.raw ?? ""))
        expect(asString(result)).toBe(c.string)
        expect(asInt(result)).toBe(c.int)
        expect(asFloat(result)).toBe(c.float)
        expect(asBool(result)).toBe(c.bool)
      }
    })
  }
})

describe("sjson parity (golden fixtures)", () => {
  for (const [index, c] of fixtures.set.entries()) {
    it(`${c.kind} #${index} ${JSON.stringify(c.json)} ${JSON.stringify(c.path)}`, () => {
      const root = c.json === "" ? undefined : parse(c.json)
      const run = (): Json | undefined => {
        if (c.kind === "delete") return del(root, c.path)
        if (c.kind === "raw") return setRaw(root, c.path, JSON.stringify(c.value))
        return set(root, c.path, c.value as Json)
      }
      if (c.error) {
        expect(run).toThrow(JsonPathError)
        return
      }
      const out = run()
      expect(JSON.stringify(out)).toBe(JSON.stringify(parse(c.out ?? "")))
    })
  }
})

describe("path engine behaviours", () => {
  it("keeps key order and does not reorder siblings", () => {
    const root = set({ z: 1, a: 2 }, "m", 3)
    expect(Object.keys(root as object)).toEqual(["z", "a", "m"])
  })

  it("handles the __proto__ key as plain data", () => {
    const root = set({}, "__proto__.x", 1) as Record<string, Json>
    expect(Object.getPrototypeOf(root)).toBe(Object.prototype)
    expect(Object.keys(root)).toEqual(["__proto__"])
    expect(get(root, "__proto__.x")).toBe(1)
    expect(({} as Record<string, unknown>).x).toBeUndefined()
  })

  it("mutates containers in place and returns the root", () => {
    const root = { a: [1] }
    expect(set(root, "a.-1", 2)).toBe(root)
    expect(root).toEqual({ a: [1, 2] })
    expect(del(root, "a.0")).toBe(root)
    expect(root).toEqual({ a: [2] })
  })

  it("rejects complex set paths and invalid raw JSON", () => {
    expect(() => set({}, "a.#", 1)).toThrow(JsonPathError)
    expect(() => set({}, "", 1)).toThrow(JsonPathError)
    expect(() => setRaw({}, "a", "{not json")).toThrow(JsonPathError)
    expect(() => set([], "99999999999", 1)).toThrow(JsonPathError)
  })

  it("escapePathKey makes keys round-trip through get and set", () => {
    for (const key of ["a.b", "x*y", "q?", "#hash", "p|q", "at@", "back\\slash", "plain"]) {
      const escaped = escapePathKey(key)
      const root = set({}, `outer.${escaped}`, 7)
      expect(root).toEqual({ outer: { [key]: 7 } })
      expect(get(root, `outer.${escaped}`)).toBe(7)
    }
  })

  it("exists treats null as existing", () => {
    expect(exists({ a: null }, "a")).toBe(true)
    expect(exists({ a: null }, "a.b")).toBe(false)
    expect(exists(undefined, "a")).toBe(false)
    expect(exists("scalar", "a")).toBe(false)
  })

  it("wildcardMatch follows tidwall/match", () => {
    expect(wildcardMatch("gpt-5", "gpt-*")).toBe(true)
    expect(wildcardMatch("gemini-2.5-pro", "gemini-*-pro")).toBe(true)
    expect(wildcardMatch("abc", "a?c")).toBe(true)
    expect(wildcardMatch("a*c", "a\\*c")).toBe(true)
    expect(wildcardMatch("abc", "a\\*c")).toBe(false)
    expect(wildcardMatch("héllo", "h?llo")).toBe(true)
    expect(wildcardMatch("abcabc", "*abc")).toBe(true)
    expect(wildcardMatch("abcabd", "*abc")).toBe(false)
    expect(wildcardMatch("", "*")).toBe(true)
    expect(wildcardMatch("", "?")).toBe(false)
  })
})
