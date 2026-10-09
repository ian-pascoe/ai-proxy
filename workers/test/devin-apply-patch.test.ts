// Devin executor-level apply_patch guards (helps/apply_patch.go as used by devin_executor.go) and the refreshed catalog
// feeding the model UID resolution.
import { describe, expect, it } from "vitest"
import { makeDevinExecutor } from "../src/executor/devin/executor.ts"
import { ProtoWriter } from "../src/executor/devin/protobuf.ts"
import type { ExecutorRequest } from "../src/executor/types.ts"
import { collectStream, credential, execute, harness, json, options, runFail } from "./support/executor-run.ts"

const envelope = (flag: number, payload: Uint8Array): Uint8Array => {
  const out = new Uint8Array(5 + payload.length)
  out[0] = flag
  new DataView(out.buffer).setUint32(1, payload.length, false)
  out.set(payload, 5)
  return out
}

const body = (...frames: Uint8Array[]): Response =>
  new Response(new Uint8Array(frames.flatMap((frame) => [...frame])), {
    status: 200,
    headers: { "content-type": "application/connect+proto" }
  })

const toolFrame = (args: string, invalid = false): Uint8Array => {
  const call = new ProtoWriter().string(1, "call_1").string(2, "apply_patch")
  if (invalid) call.string(4, args)
  else call.string(3, args)
  return envelope(0, new ProtoWriter().bytes(6, call.toBytes()).toBytes())
}

const textFrame = (text: string): Uint8Array => envelope(0, new ProtoWriter().string(3, text).toBytes())
const trailer = (js: string): Uint8Array => envelope(2, new TextEncoder().encode(js))

const patchTool = { type: "custom", name: "apply_patch", format: { type: "grammar", syntax: "lark", definition: "x" } }

const request = (declared: boolean): ExecutorRequest => ({
  model: "swe-2",
  payload: json({
    model: "swe-2",
    stream: true,
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "patch it" }] }],
    ...(declared ? { tools: [patchTool] } : {})
  })
})

const responsesOptions = (stream: boolean) =>
  options({
    stream,
    sourceFormat: "openai-response",
    metadata: { ...options().metadata, requestPath: "/v1/responses" }
  })

const devinCredential = () =>
  credential("devin", { attributes: { api_key: "devin-session-token$t", base_url: "https://devin.test" } })

const executor = makeDevinExecutor()

describe("Devin apply_patch guards", () => {
  it("answers a failed non-stream request of a patch-declaring client with the sanitised gateway error", async () => {
    const message = "Invalid apply_patch tool arguments received from upstream."
    for (const response of [
      body(trailer('{"error":{"code":"resource_exhausted","message":"quota secret"}}')),
      body(textFrame("partial")) // no EOS trailer
    ]) {
      const h = await harness(devinCredential(), () => response.clone())
      const error = await runFail(executor.execute(h.context, request(true), responsesOptions(false)), h.layers)
      expect(error.status).toBe(502)
      expect(error.message).toBe(message)
    }
    // Without the declaration the upstream error is kept.
    const h = await harness(devinCredential(), () =>
      body(trailer('{"error":{"code":"resource_exhausted","message":"quota secret"}}'))
    )
    const plain = await runFail(executor.execute(h.context, request(false), responsesOptions(false)), h.layers)
    expect(plain.status).toBe(429)
    expect(plain.message).toContain("quota secret")
  })

  it("rejects a non-stream apply_patch call whose arguments never became valid JSON", async () => {
    const h = await harness(devinCredential(), () => body(toolFrame("{not json", true), trailer("{}")))
    const error = await runFail(executor.execute(h.context, request(true), responsesOptions(false)), h.layers)
    expect(error.status).toBe(502)
    expect(error.message).toBe("Invalid apply_patch tool arguments received from upstream.")
    // A non-patch tool with the same shape is delivered.
    const ok = await harness(devinCredential(), () => body(toolFrame("{not json", true), trailer("{}")))
    const response = await execute(executor, ok, request(false), responsesOptions(false))
    expect(response.payload).toContain("function_call")
  })

  it("fails a patch-enabled stream that ends before its terminator with one failure frame and the gateway error", async () => {
    const h = await harness(
      devinCredential(),
      () => body(toolFrame('{"input":"*** Begin Patch\\n')), // EOF without EOS trailer
      undefined,
      true
    )
    const collected = await collectStream(executor, h, request(true), responsesOptions(true))
    const failed = collected.chunks.filter((chunk) => chunk.includes("response.failed"))
    expect(failed).toHaveLength(1)
    expect(failed[0]).toContain("Invalid apply_patch tool arguments received from upstream.")
    expect(collected.chunks.join("")).not.toContain("stream_truncated")
    expect(collected.error?.status).toBe(502)
    expect(collected.error?.message).toBe("Invalid apply_patch tool arguments received from upstream.")
  })

  it("keeps the ordinary truncation handling for requests without the patch tool", async () => {
    const h = await harness(devinCredential(), () => body(textFrame("partial")), undefined, true)
    const collected = await collectStream(executor, h, request(false), responsesOptions(true))
    expect(collected.error?.message).toContain("terminated prematurely")
    expect(collected.chunks.join("")).toContain("response.failed")
  })
})

describe("Devin catalog from the registry snapshot", () => {
  it("resolves the chat model UID through the refreshed catalog levels before the embedded one", async () => {
    const lookups: string[] = []
    const modelLookup = (id: string, provider: string) => {
      lookups.push(`${provider}:${id}`)
      return id === "devin/swe-2" ? { id, thinking: { levels: ["low", "high"] } } : undefined
    }
    const h = await harness(devinCredential(), () => body(textFrame("ok"), trailer("{}")), undefined, true)
    await collectStream(
      executor,
      h,
      {
        model: "swe-2",
        payload: json({
          session_id: "11111111-1111-4111-8111-111111111111",
          input: [{ type: "user_input", content: "hi" }],
          generation_config: { thinking_level: "high" }
        }),
        modelLookup
      },
      options({ stream: true, sourceFormat: "interactions" })
    )
    expect(lookups).toContain("devin:devin/swe-2")
    expect(new TextDecoder().decode(h.calls[0]?.bytes)).toContain("swe-2-high")
  })
})
