// The management routes mounted in the real application layer (`makeWebHandler`), reached through the local Access
// dev bypass: what `alchemy dev` does for the panel.
import { env } from "cloudflare:workers"
import { afterAll, describe, expect, it } from "vitest"
import { makeWebHandler } from "../src/http/app.ts"
import { requestContext } from "../src/platform/env.ts"
import { claudeFile, resetControlPlane } from "./support/management.ts"

const app = makeWebHandler()
afterAll(app.dispose)

const PANEL_HTML = "<!doctype html><title>cliproxy panel</title>"
const bindings = {
  ...env,
  ACCESS_DEV_BYPASS: "admin@example.com",
  ASSETS: {
    fetch: async () => new Response(PANEL_HTML, { headers: { "content-type": "text/html" } })
  } as unknown as Fetcher
}
const ctx = {} as unknown as ExecutionContext
const get = (path: string, base = "http://localhost:8787") =>
  app.handler(new Request(`${base}${path}`), requestContext(bindings, ctx))

describe("control panel in the application", () => {
  it("loads the panel and lists credentials like the panel does", async () => {
    await resetControlPlane()
    await env.CONTROL_PLANE.getByName("global").importAuthFile("claude-a.json", JSON.stringify(claudeFile()))

    const page = await get("/management.html")
    expect(page.status).toBe(200)
    expect(await page.text()).toBe(PANEL_HTML)

    const list = await get("/v8/management/credentials")
    expect(list.status).toBe(200)
    const body = (await list.json()) as { files: Array<{ name: string; type: string }> }
    expect(body.files).toMatchObject([{ name: "claude-a.json", type: "claude" }])
    expect((await get("/v8/management/config")).status).toBe(200)
  })

  it("does not apply the dev bypass to non-loopback hosts", async () => {
    expect((await get("/management.html", "https://proxy.example.com")).status).not.toBe(200)
    expect((await get("/v8/management/credentials", "https://proxy.example.com")).status).toBeGreaterThanOrEqual(401)
  })
})
