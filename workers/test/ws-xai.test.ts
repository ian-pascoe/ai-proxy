// End-to-end tests (workerd) of the xAI Responses WebSocket transport against a mocked upstream WebSocket.
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { Config } from "../src/config/schema.ts"
import type { CredentialSnapshot } from "../src/executor/picker.ts"
import { loadConfig, makePipeline, sseResponse } from "./support/pipeline.ts"
import { connectClient, mockUpstream, type MockUpstreamOptions } from "./support/websocket.ts"
import { xaiModels, xaiOauth, xaiPicker, type XaiPickerLog } from "./support/xai.ts"

const created = (id: string) => ({
  type: "response.created",
  sequence_number: 0,
  response: { id, model: "grok-4.3", status: "in_progress", output: [] }
})
const completed = (id: string, output: unknown[] = []) => ({
  type: "response.completed",
  response: {
    id,
    status: "completed",
    model: "grok-4.3",
    output,
    usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 }
  }
})
const ITEM = { id: "msg_1", type: "message", role: "assistant", content: [{ type: "output_text", text: "Hi" }] }

const wsCredential = (overrides: Partial<CredentialSnapshot> = {}) =>
  xaiOauth({ attributes: { auth_kind: "oauth", websockets: "true" }, ...overrides })

let config: Config
beforeAll(async () => {
  config = await loadConfig(`
requests:
  payload:
    filter:
      - models: [{ name: "grok-4.3", protocol: codex }]
        params: ["store"]
`)
})

const setup = (upstream: MockUpstreamOptions, credentials = [wsCredential()], cfg?: Config) => {
  const log: XaiPickerLog = { picks: [], reports: [] }
  const mock = mockUpstream(upstream)
  const p = makePipeline({
    config: cfg ?? config,
    respond: () => sseResponse([]),
    credentialPicker: xaiPicker(credentials, log),
    modelProviders: xaiModels,
    websocketConnector: mock.layer
  })
  afterAll(p.dispose)
  const connect = async () => connectClient(await p.call("/v1/responses", { headers: { upgrade: "websocket" } }))
  return { ...p, log, mock, connect }
}

const frames = (mock: ReturnType<typeof mockUpstream>) =>
  (mock.connections[0]?.received ?? []).map((text) => JSON.parse(text) as Record<string, unknown>)

describe("Responses WebSocket over an upstream WebSocket (xAI)", () => {
  it("dials the official API (not the CLI chat proxy) and frames the request like Go", async () => {
    const plain = await loadConfig("requests: {}")
    const s = setup(
      {
        onConnection: (connection) => {
          void (async () => {
            await connection.next()
            connection.server.send(JSON.stringify(created("resp_1")))
            connection.server.send(JSON.stringify({ type: "response.output_item.done", output_index: 0, item: ITEM }))
            connection.server.send(JSON.stringify(completed("resp_1")))
          })()
        }
      },
      [wsCredential()],
      plain
    )
    const client = await s.connect()
    client.send({
      type: "response.create",
      model: "grok-4.3",
      instructions: "Be brief",
      input: [{ type: "message", role: "user", content: "hi" }],
      stream_options: { include_usage: true }
    })
    const types: string[] = []
    let last: Record<string, unknown> = {}
    for (let i = 0; i < 3; i++) {
      last = await client.nextJson()
      types.push(String(last["type"]))
    }
    expect(types).toEqual(["response.created", "response.output_item.done", "response.completed"])
    // The rebuilt output reaches the client even though the upstream's completed event had none.
    expect((last["response"] as { output: unknown[] }).output).toEqual([ITEM])

    const dial = s.mock.dials[0]
    expect(dial?.url).toBe("wss://api.x.ai/v1/responses")
    expect(dial?.headers["authorization"]).toBe("Bearer xai-access-1")
    expect(dial?.headers["content-type"]).toBe("application/json")
    expect(dial?.headers["x-xai-token-auth"]).toBeUndefined()
    const frame = frames(s.mock)[0] as Record<string, unknown>
    expect(frame).toMatchObject({ type: "response.create", model: "grok-4.3", store: true, instructions: "Be brief" })
    expect("stream" in frame).toBe(false)
    expect("stream_options" in frame).toBe(false)
    expect(s.records[0]?.detail.inputTokens).toBe(3)
    client.close()
  })

  it("completes generate:false warm-ups on the upstream socket with a synthesised response.completed", async () => {
    const s = setup({
      onConnection: (connection) => {
        void (async () => {
          await connection.next()
          connection.server.send(JSON.stringify(created("resp_1")))
          connection.server.send(JSON.stringify(completed("resp_1")))
          // The warm-up only produces response.created upstream.
          await connection.next()
          connection.server.send(JSON.stringify({ ...created("resp_warm"), sequence_number: 4 }))
        })()
      }
    })
    const client = await s.connect()
    client.send({ type: "response.create", model: "grok-4.3", input: [] })
    await client.until("response.completed")
    client.send({ type: "response.create", previous_response_id: "resp_1", generate: false, input: [] })
    expect((await client.nextJson())["type"]).toBe("response.created")
    const synthesised = await client.nextJson()
    expect(synthesised).toMatchObject({ type: "response.completed", sequence_number: 5 })
    expect(synthesised["response"]).toMatchObject({
      id: "resp_warm",
      status: "completed",
      output: [],
      usage: { total_tokens: 0, input_tokens_details: { cached_tokens: 0 } }
    })
    expect(frames(s.mock)[1]).toMatchObject({ generate: false, previous_response_id: "resp_1" })
    client.close()
  })

  it("rewrites repeated upstream response ids and drops the filtered store field after the payload rules", async () => {
    const s = setup({
      onConnection: (connection) => {
        void (async () => {
          for (let i = 0; i < 2; i++) {
            await connection.next()
            // The upstream answers both turns with the same id.
            connection.server.send(JSON.stringify(created("resp_same")))
            connection.server.send(JSON.stringify(completed("resp_same")))
          }
        })()
      }
    })
    const client = await s.connect()
    client.send({
      type: "response.create",
      model: "grok-4.3",
      instructions: "sys",
      input: [{ type: "message", role: "user", content: "one" }]
    })
    expect(((await client.until("response.completed"))["response"] as { id: string }).id).toBe("resp_same")
    client.send({
      type: "response.create",
      previous_response_id: "resp_same",
      instructions: "sys",
      input: [{ type: "message", role: "user", content: "two" }]
    })
    const second = await client.until("response.completed")
    expect((second["response"] as { id: string }).id).toBe("resp_same-xai-1")

    expect(s.mock.dials).toHaveLength(1)
    const sent = frames(s.mock)
    expect(sent[1]).toMatchObject({ type: "response.create", previous_response_id: "resp_same" })
    // `instructions` are dropped on continuations, and the user's filter rule removed `store` from every frame.
    expect("instructions" in (sent[1] as Record<string, unknown>)).toBe(false)
    expect("store" in (sent[0] as Record<string, unknown>)).toBe(false)
    client.close()
  })

  it("maps bare upstream error objects through the xAI classification", async () => {
    const s = setup({
      onConnection: (connection) => {
        void (async () => {
          await connection.next()
          connection.server.send(JSON.stringify({ error: { message: "Request validation error: bad tools" } }))
        })()
      }
    })
    const client = await s.connect()
    client.send({ type: "response.create", model: "grok-4.3", input: [] })
    const error = await client.nextJson()
    expect(error).toMatchObject({ type: "error", status: 400 })
    await client.closed
    expect(s.log.reports[0]?.result.success).toBe(false)
  })

  it("falls back to HTTP for a credential without websockets", async () => {
    const plain = await loadConfig("requests: {}")
    const mock = mockUpstream()
    const bodies: string[] = []
    const log: XaiPickerLog = { picks: [], reports: [] }
    const p = makePipeline({
      config: plain,
      respond: (call) => {
        bodies.push(call.body)
        return sseResponse([
          `event: response.created\ndata: ${JSON.stringify(created("resp_http"))}\n\n`,
          `event: response.completed\ndata: ${JSON.stringify(completed("resp_http", [ITEM]))}\n\n`
        ])
      },
      credentialPicker: xaiPicker([xaiOauth()], log),
      modelProviders: xaiModels,
      websocketConnector: mock.layer
    })
    afterAll(p.dispose)
    const client = connectClient(await p.call("/v1/responses", { headers: { upgrade: "websocket" } }))
    client.send({
      type: "response.create",
      model: "grok-4.3",
      input: [{ type: "message", role: "user", content: "hi" }]
    })
    expect(((await client.until("response.completed"))["response"] as { id: string }).id).toBe("resp_http")
    expect(mock.dials).toHaveLength(0)
    expect(p.calls[0]?.url).toBe("https://cli-chat-proxy.grok.com/v1/responses")
    client.close()
  })
})
