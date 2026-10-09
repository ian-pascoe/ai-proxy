// Error bodies per protocol (Go: handlers.go BuildErrorResponseBodyWithError, claude/code_handlers.go,
// openai_responses_stream_error.go) and related HTTP helpers.
import { describe, expect, it } from "vitest"
import { ExecutionError } from "../src/executor/errors.ts"
import { enrichSelectionError } from "../src/handlers/execute.ts"
import { decodeRequestBody, RequestBodyDecodeError } from "../src/http/body.ts"
import {
  claudeErrorBody,
  openAIErrorBody,
  responsesStreamErrorChunk,
  responsesStreamFailedChunk
} from "../src/http/errors.ts"
import { filterUpstreamHeaders, mergeUpstreamHeaders } from "../src/http/headers.ts"
import { compactJson, goMarshalSorted } from "../src/http/json-text.ts"

describe("openAIErrorBody", () => {
  it.each([
    [401, '{"error":{"message":"m","type":"authentication_error","code":"invalid_api_key"}}'],
    [403, '{"error":{"message":"m","type":"permission_error","code":"insufficient_quota"}}'],
    [429, '{"error":{"message":"m","type":"rate_limit_error","code":"rate_limit_exceeded"}}'],
    [404, '{"error":{"message":"m","type":"invalid_request_error","code":"model_not_found"}}'],
    [408, '{"error":{"message":"m","type":"server_error","code":"request_timeout"}}'],
    [503, '{"error":{"message":"m","type":"server_error","code":"internal_server_error"}}'],
    [400, '{"error":{"message":"m","type":"invalid_request_error"}}']
  ])("maps status %i", (status, body) => {
    expect(openAIErrorBody(status, "m")).toBe(body)
  })

  it("uses the status text for empty messages and 500 for invalid statuses", () => {
    expect(openAIErrorBody(502, "  ")).toBe(
      '{"error":{"message":"Bad Gateway","type":"server_error","code":"internal_server_error"}}'
    )
    expect(openAIErrorBody(0, "")).toBe(
      '{"error":{"message":"Internal Server Error","type":"server_error","code":"internal_server_error"}}'
    )
  })

  it("compacts JSON text verbatim (number text and escapes preserved)", () => {
    expect(openAIErrorBody(400, ' {\n "error" : { "n": 1.50, "s": "a b\\u00e9" } }\n')).toBe(
      '{"error":{"n":1.50,"s":"a b\\u00e9"}}'
    )
  })

  it("HTML-escapes like Go json.Marshal", () => {
    expect(openAIErrorBody(400, "<a & b>")).toBe(
      '{"error":{"message":"\\u003ca \\u0026 b\\u003e","type":"invalid_request_error"}}'
    )
  })

  it("builds terminal auth errors from nested messages", () => {
    expect(openAIErrorBody(401, '{"error":{"message":"token revoked"}}', { terminalAuth: true })).toBe(
      '{"error":{"message":"token revoked","type":"authentication_error","code":"upstream_authentication_required","retryable":false}}'
    )
  })
})

describe("claudeErrorBody", () => {
  it.each([
    [401, "authentication_error"],
    [402, "billing_error"],
    [403, "permission_error"],
    [404, "not_found_error"],
    [413, "request_too_large"],
    [429, "rate_limit_error"],
    [408, "timeout_error"],
    [504, "timeout_error"],
    [529, "overloaded_error"],
    [500, "api_error"],
    [422, "invalid_request_error"]
  ])("maps status %i to %s", (status, type) => {
    expect(JSON.parse(claudeErrorBody(status, "x"))).toEqual({ type: "error", error: { type, message: "x" } })
  })

  it("takes type and message from JSON error text", () => {
    expect(claudeErrorBody(400, '{"error":{"type":"overloaded_error","message":" busy "}}')).toBe(
      '{"type":"error","error":{"type":"overloaded_error","message":"busy"}}'
    )
    expect(claudeErrorBody(400, '{"error":{"code":"some_code"}}')).toBe(
      '{"type":"error","error":{"type":"invalid_request_error","message":"some_code"}}'
    )
    expect(claudeErrorBody(500, '{"type":"error","message":"top"}')).toBe(
      '{"type":"error","error":{"type":"api_error","message":"top"}}'
    )
  })

  it("marks thread_not_found", () => {
    const body = claudeErrorBody(
      404,
      '{"error":{"type":"not_found_error","message":"Thread state for previous_message_id was not found"}}'
    )
    expect(JSON.parse(body)).toEqual({
      type: "error",
      error: {
        type: "not_found_error",
        message: "Thread state for previous_message_id was not found",
        details: { error_code: "thread_not_found" }
      }
    })
  })
})

describe("Responses stream error chunks", () => {
  it("builds error events with sorted detail keys", () => {
    expect(responsesStreamErrorChunk(429, "slow down", 3)).toBe(
      '{"type":"error","error":{"code":"rate_limit_exceeded","message":"slow down","param":null,"type":"invalid_request_error"},"sequence_number":3}'
    )
  })

  it("reuses upstream error objects and sequence numbers", () => {
    expect(responsesStreamErrorChunk(500, '{"error":{"message":"x","code":"c"},"sequence_number":9}', 1)).toBe(
      '{"type":"error","error":{"code":"c","message":"x"},"sequence_number":9}'
    )
  })

  it("builds response.failed events", () => {
    expect(responsesStreamFailedChunk(502, "gone", 0)).toBe(
      '{"type":"response.failed","sequence_number":0,"response":{"status":"failed","error":{"code":"internal_server_error","message":"gone","param":null,"type":"server_error"}}}'
    )
  })
})

describe("json-text helpers", () => {
  it("compacts without touching strings", () => {
    expect(compactJson('{ "a" : "x  y\\" z" ,\n "b":[1, 2] }')).toBe('{"a":"x  y\\" z","b":[1,2]}')
  })

  it("sorts map keys recursively", () => {
    expect(goMarshalSorted({ b: 1, a: { d: [{ z: 1, y: 2 }], c: "<" } })).toBe(
      '{"a":{"c":"\\u003c","d":[{"y":2,"z":1}]},"b":1}'
    )
  })
})

describe("enrichSelectionError", () => {
  it("adds providers and model to auth selection errors", () => {
    const error = enrichSelectionError(
      new ExecutionError({ status: 503, code: "auth_not_found", message: "no auth available" }),
      ["claude", "x"],
      "m(high)"
    )
    expect(error.message).toBe(
      "no auth available (providers=claude,x, model=m(high)); check Claude auth/key session and cooldown state via /v0/management/auth-files"
    )
    expect(error.status).toBe(503)
  })

  it("leaves other errors alone", () => {
    const original = new ExecutionError({ status: 429, message: "x" })
    expect(enrichSelectionError(original, ["a"], "m")).toBe(original)
  })
})

describe("upstream header filtering", () => {
  it("drops hop-by-hop, reserved, connection-scoped and gateway headers", () => {
    const filtered = filterUpstreamHeaders(
      new Headers({
        connection: "keep-alive, X-Drop",
        "x-drop": "1",
        "transfer-encoding": "chunked",
        "content-length": "10",
        "set-cookie": "a=b",
        "access-control-allow-origin": "x",
        "cf-aig-cache-status": "HIT",
        "x-litellm-version": "1",
        "x-request-id": "keep"
      })
    )
    expect([...filtered.keys()]).toEqual(["x-request-id"])
  })

  it("does not overwrite proxy headers", () => {
    expect(
      mergeUpstreamHeaders({ "content-type": "application/json" }, new Headers({ "Content-Type": "x", "x-a": "1" }))
    ).toEqual({ "content-type": "application/json", "x-a": "1" })
  })
})

describe("request body decoding", () => {
  const zstd = Uint8Array.from(atob("KLUv/QRYaQAAeyJtb2RlbCI6Im0ifSeLfGQ="), (ch) => ch.charCodeAt(0))

  it("decodes zstd and identity lists right to left", () => {
    expect(decodeRequestBody(zstd, "zstd")).toBe('{"model":"m"}')
    expect(decodeRequestBody(zstd, "identity, zstd")).toBe('{"model":"m"}')
    expect(decodeRequestBody(new TextEncoder().encode("{}"), "identity")).toBe("{}")
  })

  it("falls back to raw JSON and rejects unknown encodings", () => {
    expect(decodeRequestBody(new TextEncoder().encode('{"a":1}'), "zstd")).toBe('{"a":1}')
    expect(() => decodeRequestBody(new TextEncoder().encode("x"), "br")).toThrow(RequestBodyDecodeError)
    expect(() => decodeRequestBody(new TextEncoder().encode("x"), "zstd")).toThrow(/failed to decode zstd/)
  })
})
