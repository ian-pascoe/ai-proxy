// POST /v8/management/oauth/import?provider=vertex through the router with the real ControlPlane, and the private-key
// normalisation against the Go `NormalizeServiceAccountMap` (test/fixtures/session.json, tools/fixturegen/session).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { normalizePrivateKey } from "../src/credentials/refresh/vertex.ts"
import fixtures from "./fixtures/session.json"
import { controlPlane, makeHarness, resetControlPlane } from "./support/management.ts"
import { makeServiceAccount, type TestServiceAccount } from "./support/vertex.ts"

const harness = makeHarness()

const { json } = harness

let sa: TestServiceAccount

beforeAll(async () => {
  sa = await makeServiceAccount()
})

afterAll(async () => {
  await harness.dispose()
})

beforeEach(async () => {
  await resetControlPlane()
})

const IMPORT = "/v8/management/oauth/import"

const upload = (account: unknown, fields: Record<string, string> = {}, name = "sa.json") => {
  const body = new FormData()
  body.append("file", new File([typeof account === "string" ? account : JSON.stringify(account)], name))

  for (const [key, value] of Object.entries(fields)) body.append(key, value)

  return { method: "POST", body }
}

describe("Vertex private key normalisation (Go parity)", () => {
  for (const entry of fixtures.vertex) {
    it(entry.name, async () => {
      const result = await normalizePrivateKey(entry.privateKey)

      if (entry.error !== undefined) {
        // The failure reasons are worded by the Go crypto packages; only the rejection is compared.
        expect(result.ok).toBe(false)
      } else {
        expect(result).toEqual({ ok: true, pem: entry.normalized })
      }
    })
  }
})

describe("POST /v8/management/oauth/import", () => {
  it("requires a known provider", async () => {
    expect(await json(IMPORT, { method: "POST" })).toMatchObject({
      status: 400,
      body: { error: "provider is required" }
    })
    expect(await json(`${IMPORT}?provider=nope`, { method: "POST" })).toMatchObject({
      status: 404,
      body: { error: "provider_not_found" }
    })
  })

  it("rejects missing files, invalid JSON and unusable service accounts", async () => {
    const url = `${IMPORT}?provider=vertex`
    expect(await json(url, { method: "POST" })).toMatchObject({ status: 400, body: { error: "file required" } })
    expect(await json(url, upload("{nope"))).toMatchObject({ status: 400, body: { error: "invalid json" } })
    expect(await json(url, upload({ project_id: "p" }))).toMatchObject({
      status: 400,
      body: { error: "invalid service account", message: "service account missing private_key" }
    })
    expect(await json(url, upload({ project_id: "p", private_key: "not a key" }))).toMatchObject({
      status: 400,
      body: { error: "invalid service account" }
    })
    expect(await json(url, upload(sa.account(sa.pem.pkcs8, { project_id: "  " })))).toMatchObject({
      status: 400,
      body: { error: "project_id missing" }
    })
  })

  it("stores the normalised service account as vertex-<project>.json", async () => {
    const result = await json(
      `${IMPORT}?provider=VERTEX`,
      upload(sa.account(sa.pem.pkcs8, { project_id: "my proj/1" }))
    )

    expect(result).toMatchObject({
      status: 200,
      body: {
        status: "ok",
        "auth-file": "vertex-my-proj_1.json",
        project_id: "my proj/1",
        email: "sa@proj-1.iam.gserviceaccount.com",
        location: "us-central1"
      }
    })
    const stored = await controlPlane().getCredentialFile("vertex-my-proj_1.json")
    expect(stored).toMatchObject({
      type: "vertex",
      project_id: "my proj/1",
      email: "sa@proj-1.iam.gserviceaccount.com",
      location: "us-central1",
      label: "my proj/1 (sa@proj-1.iam.gserviceaccount.com)"
    })
    const serviceAccount = (stored as Record<string, unknown>).service_account as Record<string, unknown>
    // The key is re-encoded as PKCS#1 like Go, the rest of the file is kept.
    expect(serviceAccount.private_key).toBe(((await normalizePrivateKey(sa.pem.pkcs8)) as { pem: string }).pem)
    expect(String(serviceAccount.private_key).startsWith("-----BEGIN RSA PRIVATE KEY-----\n")).toBe(true)
    expect(serviceAccount.client_email).toBe("sa@proj-1.iam.gserviceaccount.com")
  })

  it("takes the location from the form or the query and keeps user settings on re-import", async () => {
    const fromQuery = await json(`${IMPORT}?provider=vertex&location=europe-west4`, upload(sa.account(sa.pem.pkcs1)))
    expect(fromQuery.body).toMatchObject({ location: "europe-west4" })
    const name = (fromQuery.body as { "auth-file": string })["auth-file"]
    await controlPlane().patchCredentialFields({ name }, { priority: 7 })

    const fromForm = await json(
      `${IMPORT}?provider=vertex&location=ignored`,
      upload(sa.account(sa.pem.pkcs1), { location: "asia-east1" })
    )

    expect(fromForm.body).toMatchObject({ location: "asia-east1" })
    expect(await controlPlane().getCredentialFile(name)).toMatchObject({
      location: "asia-east1",
      type: "vertex",
      priority: 7
    })
  })
})
