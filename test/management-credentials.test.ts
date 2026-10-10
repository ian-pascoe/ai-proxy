// /v8/management/credentials* and /routing/cooldown/reset through the router with the real ControlPlane.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { authIndexOf } from "../src/management/auth-index.ts";
import {
  claudeFile,
  controlPlane,
  jsonInit,
  makeHarness,
  resetControlPlane,
} from "./support/management.ts";

// The ControlPlane runs in the test isolate and refreshes through Effect's FetchHttpClient, which resolves
// `globalThis.fetch` once: install one stable fetch that delegates to the current test's upstream.
type Upstream = (url: string) => Response;

const okUpstream: Upstream = () =>
  Response.json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 });

let upstream: Upstream = okUpstream;

const realFetch = globalThis.fetch;

const harness = makeHarness();

beforeAll(() => {
  globalThis.fetch = (async (input: RequestInfo | URL) =>
    upstream(input instanceof Request ? input.url : String(input))) as typeof fetch;
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  await harness.dispose();
});

beforeEach(async () => {
  upstream = okUpstream;
  await resetControlPlane();
});

const { call, json } = harness;

const upload = async (name: string, content: unknown) =>
  await json(`/v8/management/credentials?name=${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof content === "string" ? content : JSON.stringify(content),
  });

interface Entry {
  readonly name: string;
  readonly auth_index: string;
  readonly [key: string]: unknown;
}

const list = async (query = ""): Promise<{ files: Entry[]; [key: string]: unknown }> =>
  (await json(`/v8/management/credentials${query}`)).body as { files: Entry[] };

const form = (files: Array<[string, string]>) => {
  const body = new FormData();

  for (const [name, content] of files)
    body.append("file", new File([content], name, { type: "application/json" }));

  return { method: "POST", body };
};

describe("management credentials: list and upload", () => {
  it("starts empty and lists uploaded files without secrets, sorted case-insensitively", async () => {
    const empty = await list();
    expect(empty.files).toEqual([]);
    expect(typeof empty.observed_at).toBe("string");

    expect(
      await upload("b-claude.json", claudeFile({ priority: 5, note: "primary", weight: 3 })),
    ).toMatchObject({
      status: 200,
      body: { status: "ok" },
    });
    expect(
      (
        await upload("A-codex.json", {
          type: "codex",
          email: "c@x.com",
          access_token: "tok",
          refresh_token: "r",
        })
      ).status,
    ).toBe(200);

    const { files } = await list();
    expect(files.map((file) => file.name)).toEqual(["A-codex.json", "b-claude.json"]);
    const claude = files[1]!;
    expect(claude).toMatchObject({
      id: "b-claude.json",
      type: "claude",
      provider: "claude",
      email: "me@x.com",
      label: "me@x.com",
      status: "active",
      disabled: false,
      unavailable: false,
      runtime_only: false,
      source: "file",
      success: 0,
      failed: 0,
      priority: 5,
      note: "primary",
      weight: 3,
      cooldowns: [],
    });
    expect(claude.auth_index).toBe(authIndexOf("b-claude.json"));
    expect(claude.size).toBeGreaterThan(10);
    expect(claude.recent_requests).toHaveLength(20);
    expect(claude.recent_requests).toEqual(
      expect.arrayContaining([
        { time: expect.stringMatching(/^\d\d:\d\d-\d\d:\d\d$/), success: 0, failed: 0 },
      ]),
    );
    expect(JSON.stringify(files)).not.toMatch(/secret-|sk-ant/);
  });

  it("filters by name and auth_index and paginates", async () => {
    for (const name of ["a.json", "b.json", "c.json"]) await upload(name, claudeFile());
    expect((await list("?name=b.json")).files.map((file) => file.name)).toEqual(["b.json"]);
    expect(
      (await list(`?auth_index=${authIndexOf("c.json")}`)).files.map((file) => file.name),
    ).toEqual(["c.json"]);

    const page = await list("?page=2&page_size=2");
    expect(page).toMatchObject({ total: 3, page: 2, page_size: 2, has_more: false });
    expect(page.files.map((file) => file.name)).toEqual(["c.json"]);
    expect(await list("?page=1&page_size=2")).toMatchObject({ has_more: true });
    expect((await list("?page_size=1")).files).toHaveLength(1);
    expect(await json("/v8/management/credentials?page=0")).toMatchObject({
      status: 400,
      body: { error: "page must be a positive integer" },
    });
    expect(await json("/v8/management/credentials?page_size=x")).toMatchObject({
      status: 400,
      body: { error: "page_size must be a positive integer" },
    });
  });

  it("validates raw uploads", async () => {
    expect(await upload("../x.json", claudeFile())).toMatchObject({
      status: 400,
      body: { error: "invalid name" },
    });
    expect(await upload("x.txt", claudeFile())).toMatchObject({
      status: 400,
      body: { error: "name must end with .json" },
    });
    const notJson = await upload("x.json", "{nope");
    expect(notJson.status).toBe(400);
    expect(notJson.body).toMatchObject({ error: expect.stringContaining("invalid auth file") });
    expect((await upload("x.json", { email: "no-type@x.com" })).status).toBe(400);
    expect((await list()).files).toEqual([]);
  });

  it("accepts multipart uploads: single, several, and partial failures", async () => {
    expect(
      await json("/v8/management/credentials", form([["one.json", JSON.stringify(claudeFile())]])),
    ).toMatchObject({
      status: 200,
      body: { status: "ok" },
    });

    const several = await json(
      "/v8/management/credentials",
      form([
        ["two.json", JSON.stringify(claudeFile())],
        ["three.json", JSON.stringify(claudeFile())],
      ]),
    );

    expect(several).toMatchObject({
      status: 200,
      body: { status: "ok", uploaded: 2, files: ["two.json", "three.json"] },
    });

    const partial = await json(
      "/v8/management/credentials",
      form([
        ["four.json", JSON.stringify(claudeFile())],
        ["bad.txt", "x"],
      ]),
    );

    expect(partial).toMatchObject({
      status: 207,
      body: {
        status: "partial",
        uploaded: 1,
        files: ["four.json"],
        failed: [{ name: "bad.txt", error: "file must be .json" }],
      },
    });
    expect(await json("/v8/management/credentials", form([["bad.txt", "x"]]))).toMatchObject({
      status: 400,
      body: { error: "file must be .json" },
    });
    expect(
      await json("/v8/management/credentials", { method: "POST", body: new FormData() }),
    ).toMatchObject({
      status: 400,
      body: { error: "no files uploaded" },
    });
    expect((await list()).files.map((file) => file.name)).toEqual([
      "four.json",
      "one.json",
      "three.json",
      "two.json",
    ]);
  });
});

describe("management credentials: download, delete, models", () => {
  it("downloads the stored file verbatim, including tokens", async () => {
    await upload("x.json", claudeFile({ "proxy-url": "http://p" }));
    const response = await call("/v8/management/credentials/download?name=x.json");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="x.json"');
    expect(response.headers.get("content-type")).toBe("application/json");
    // Legacy dashed keys are normalised on import.
    expect(await response.json()).toMatchObject({
      access_token: "sk-ant-oat-secret-access",
      proxy_url: "http://p",
    });
    expect((await json("/v8/management/credentials/download?name=nope.json")).status).toBe(404);
    expect((await json("/v8/management/credentials/download?name=a/b.json")).body).toEqual({
      error: "invalid name",
    });
    expect((await json("/v8/management/credentials/download")).status).toBe(400);
  });

  it("deletes by query, body and all", async () => {
    for (const name of ["a.json", "b.json", "c.json", "d.json", "e.json"])
      await upload(name, claudeFile());
    expect(
      await json("/v8/management/credentials?name=a.json", { method: "DELETE" }),
    ).toMatchObject({
      status: 200,
      body: { status: "ok" },
    });
    expect(
      (await json("/v8/management/credentials?name=a.json", { method: "DELETE" })).status,
    ).toBe(404);
    expect(
      await json("/v8/management/credentials", jsonInit("DELETE", { names: ["b.json", "c.json"] })),
    ).toMatchObject({
      status: 200,
      body: { status: "ok", deleted: 2, files: ["b.json", "c.json"] },
    });
    expect(
      await json("/v8/management/credentials", jsonInit("DELETE", ["d.json", "ghost.json"])),
    ).toMatchObject({
      status: 207,
      body: {
        status: "partial",
        deleted: 1,
        failed: [{ name: "ghost.json", error: "auth file not found" }],
      },
    });
    expect(
      await json("/v8/management/credentials", jsonInit("DELETE", { name: "e.json" })),
    ).toMatchObject({
      status: 200,
    });
    expect(await json("/v8/management/credentials", { method: "DELETE" })).toMatchObject({
      status: 400,
      body: { error: "invalid name" },
    });
    await upload("f.json", claudeFile());
    await upload("g.json", claudeFile());
    expect(await json("/v8/management/credentials?all=true", { method: "DELETE" })).toMatchObject({
      status: 200,
      body: { status: "ok", deleted: 2 },
    });
    expect((await list()).files).toEqual([]);
  });

  it("lists the models registered for a credential", async () => {
    await upload("claude-a.json", claudeFile());
    const models = await json("/v8/management/credentials/models?name=claude-a.json");
    expect(models.status).toBe(200);
    const body = models.body as { models: Array<{ id: string; owned_by?: string }> };
    expect(body.models.length).toBeGreaterThan(0);
    expect(body.models.some((model) => model.id.startsWith("claude-"))).toBe(true);
    expect(await json("/v8/management/credentials/models?name=ghost.json")).toMatchObject({
      status: 200,
      body: { models: [] },
    });
    expect(await json("/v8/management/credentials/models")).toMatchObject({
      status: 400,
      body: { error: "name is required" },
    });
  });
});

describe("management credentials: status, fields, refresh, cooldown", () => {
  it("disables and re-enables a credential", async () => {
    await upload("x.json", claudeFile());
    expect(
      await json(
        "/v8/management/credentials/status",
        jsonInit("PATCH", { name: "x.json", disabled: true }),
      ),
    ).toMatchObject({
      status: 200,
      body: { status: "ok", disabled: true },
    });
    expect((await list()).files[0]).toMatchObject({ disabled: true, status: "disabled" });
    await json(
      "/v8/management/credentials/status",
      jsonInit("PATCH", { name: "x.json", auth_index: authIndexOf("x.json"), disabled: false }),
    );
    expect((await list()).files[0]).toMatchObject({ disabled: false, status: "active" });

    expect(
      (await json("/v8/management/credentials/status", jsonInit("PATCH", { disabled: true }))).body,
    ).toEqual({
      error: "name is required",
    });
    expect(
      (await json("/v8/management/credentials/status", jsonInit("PATCH", { name: "x.json" }))).body,
    ).toEqual({
      error: "disabled is required",
    });
    expect(
      (
        await json(
          "/v8/management/credentials/status",
          jsonInit("PATCH", { name: "ghost.json", disabled: true }),
        )
      ).status,
    ).toBe(404);
    // The index must match too.
    expect(
      (
        await json(
          "/v8/management/credentials/status",
          jsonInit("PATCH", { name: "x.json", auth_index: "0000000000000000", disabled: true }),
        )
      ).status,
    ).toBe(404);
  });

  it("refuses to toggle config API keys", async () => {
    await controlPlane().putConfig("api-keys:\n  claude:\n    - keys: [{ api-key: sk-ant-x }]\n");

    const config = (await json("/v8/management/config/api-keys/claude")).body as Array<{
      keys: Array<{ auth_index: string }>;
    }>;

    const authIndex = config[0]!.keys[0]!.auth_index;
    const entries = await controlPlane().listCredentials();
    const id = entries.find((entry) => entry.source === "config")!.id;
    expect(authIndexOf(id)).toBe(authIndex);
    expect(
      await json(
        "/v8/management/credentials/status",
        jsonInit("PATCH", { name: id, disabled: true }),
      ),
    ).toMatchObject({ status: 409 });
    // Config credentials are not auth files.
    expect((await list()).files).toEqual([]);
  });

  it("patches fields by dotted path, canonicalises keys and merges headers", async () => {
    await upload("x.json", claudeFile({ headers: { "X-A": "1", "X-B": "2" } }));

    const patch = (fields: Record<string, unknown>) =>
      json("/v8/management/credentials/fields", jsonInit("PATCH", { name: "x.json", ...fields }));

    expect(
      await patch({
        priority: 7,
        note: "hello",
        "disable-cooling": true,
        weight: 4,
        "nested.value.deep": "x",
        request_retry: 2,
        headers: { "X-A": "", "X-C": "3" },
      }),
    ).toMatchObject({ status: 200, body: { status: "ok" } });
    const file = (await json("/v8/management/credentials/download?name=x.json")).body as Record<
      string,
      unknown
    >;
    expect(file).toMatchObject({
      priority: 7,
      note: "hello",
      disable_cooling: true,
      weight: 4,
      nested: { value: { deep: "x" } },
      request_retry: 2,
      headers: { "X-B": "2", "X-C": "3" },
      // Token material is untouched.
      access_token: "sk-ant-oat-secret-access",
    });
    expect(file.headers).not.toHaveProperty("X-A");
    expect((await list()).files[0]).toMatchObject({
      priority: 7,
      note: "hello",
      weight: 4,
      request_retry: 2,
    });

    // null deletes.
    expect((await patch({ note: null, request_retry: null, "nested.value": null })).status).toBe(
      200,
    );
    const after = (await json("/v8/management/credentials/download?name=x.json")).body as Record<
      string,
      unknown
    >;
    expect(after).not.toHaveProperty("note");
    expect(after).not.toHaveProperty("request_retry");
    expect(after.nested).toEqual({});

    expect((await patch({})).body).toEqual({ error: "no fields to update" });
    expect((await patch({ weight: "3" })).body).toEqual({ error: "weight must be an integer" });
    expect((await patch({ "weight.x": 1 })).body).toEqual({
      error: "weight does not support nested fields",
    });
    expect((await patch({ "request_retry.x": 1 })).body).toEqual({
      error: "request_retry does not support nested fields",
    });
    expect((await patch({ request_retry: "x" })).body).toEqual({
      error: "request_retry must be an integer or null",
    });
    expect((await patch({ weight: 2_000_000 })).status).toBe(400);
    expect((await patch({ access_token: "evil" })).body).toEqual({
      error: "invalid field access_token",
    });
    expect((await patch({ type: "codex" })).body).toEqual({ error: "invalid field type" });
    expect((await patch({ disabled: true })).status).toBe(400);
    expect((await patch({ "a..b": 1 })).status).toBe(400);
    expect(
      await json(
        "/v8/management/credentials/fields",
        jsonInit("PATCH", { name: "ghost.json", note: "x" }),
      ),
    ).toMatchObject({ status: 404, body: { error: "auth file not found" } });
    expect(
      (await json("/v8/management/credentials/fields", jsonInit("PATCH", { note: "x" }))).body,
    ).toEqual({
      error: "name is required",
    });
  });

  it("force-refreshes one credential and all credentials", async () => {
    await upload("x.json", claudeFile());
    await upload("y.json", {
      type: "claude",
      email: "y@x.com",
      access_token: "t",
      refresh_token: "r2",
      expired: "2999-01-01T00:00:00Z",
    });
    await upload("noref.json", { type: "claude", email: "n@x.com", access_token: "t" });

    const one = await json(
      "/v8/management/credentials/refresh",
      jsonInit("POST", { name: "x.json" }),
    );
    expect(one.status).toBe(200);
    expect(one.body).toMatchObject({ ok: true, auth: { name: "x.json" } });
    expect(JSON.stringify(one.body)).not.toContain("new-access");
    expect((await controlPlane().getCredentialFile("x.json"))?.access_token).toBe("new-access");

    const viaQuery = await json("/v8/management/credentials/refresh?name=y.json", {
      method: "POST",
    });
    expect(viaQuery.status).toBe(200);

    const all = await json("/v8/management/credentials/refresh", jsonInit("POST", { all: true }));
    expect(all.status).toBe(200);
    const results = (all.body as { ok: boolean; results: Array<{ id: string; success: boolean }> })
      .results;
    expect(results.map((result) => result.id).toSorted()).toEqual(["x.json", "y.json"]);
    expect(results.every((result) => result.success)).toBe(true);
    expect(
      (await json("/v8/management/credentials/refresh?all=true", { method: "POST" })).status,
    ).toBe(200);

    // A credential without refresh token is not an error for a single refresh.
    expect(
      (await json("/v8/management/credentials/refresh", jsonInit("POST", { name: "noref.json" })))
        .status,
    ).toBe(200);
    expect(await json("/v8/management/credentials/refresh", jsonInit("POST", {}))).toMatchObject({
      status: 400,
      body: { error: "name or all=true is required" },
    });
    expect(
      (await json("/v8/management/credentials/refresh", jsonInit("POST", { name: "ghost.json" })))
        .status,
    ).toBe(404);
  });

  it("reports a failed refresh without leaking tokens", async () => {
    await upload("x.json", claudeFile());
    upstream = () => Response.json({ error: "invalid_request" }, { status: 400 });
    const result = await json(
      "/v8/management/credentials/refresh",
      jsonInit("POST", { name: "x.json" }),
    );
    expect(result.status).toBe(500);
    expect(JSON.stringify(result.body)).not.toContain("secret-refresh");
    const all = await json("/v8/management/credentials/refresh", jsonInit("POST", { all: true }));
    expect(all.body).toMatchObject({ ok: true, results: [{ id: "x.json", success: false }] });
  });

  it("resets cooldown state by auth_index", async () => {
    await upload("x.json", claudeFile());
    const stub = controlPlane();
    const picked = await stub.pick({ providers: ["claude"], model: "claude-sonnet-4-5" });

    if (!picked.ok) throw new Error("pick failed");
    await stub.report(picked.lease, {
      success: false,
      httpStatus: 429,
      error: { message: "limit", retryable: true },
    });
    expect((await list()).files[0]).toMatchObject({ failed: 1 });
    expect((await list()).files[0]?.cooldowns).toEqual([
      expect.objectContaining({ scope: "model" }),
    ]);

    expect(
      await json(
        "/v8/management/routing/cooldown/reset",
        jsonInit("POST", { auth_index: authIndexOf("x.json") }),
      ),
    ).toMatchObject({
      status: 200,
      body: { status: "ok", auth_index: authIndexOf("x.json"), models: ["claude-sonnet-4-5"] },
    });
    expect(
      await json(
        "/v8/management/routing/cooldown/reset",
        jsonInit("POST", { auth_index: "ffffffffffffffff" }),
      ),
    ).toMatchObject({
      status: 404,
      body: { error: "auth not found" },
    });
    expect(await json("/v8/management/routing/cooldown/reset", jsonInit("POST", {}))).toMatchObject(
      {
        status: 400,
        body: { error: "auth_index is required" },
      },
    );
    expect(
      await json("/v8/management/routing/cooldown/reset", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "x",
      }),
    ).toMatchObject({
      status: 400,
    });
  });
});
