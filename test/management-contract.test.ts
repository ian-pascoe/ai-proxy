// The shared management contract (src/management/contract) against the real handlers: the panel's generated client
// calls the management routes through the Access gate and must decode what they answer.
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { afterAll, afterEach, beforeAll, beforeEach } from "vitest";
import { ManagementApi } from "../src/management/contract/api.ts";
import { ManagementError } from "../src/management/contract/errors.ts";
import { UsageGroupBy } from "../src/management/contract/usage.ts";
import { GROUP_BY, insertUsageRecord } from "../src/usage/d1.ts";
import {
  claudeFile,
  controlPlane,
  type Harness,
  makeHarness,
  resetControlPlane,
} from "./support/management.ts";
import { resetUsageDb, sampleRecord } from "./support/usage.ts";

const harness = makeHarness();

// The ControlPlane Durable Object reaches providers through `globalThis.fetch` (resolved once by FetchHttpClient): one
// stable stub delegates to the current test's upstream table. The generated client's own `fetch` is separate (`through`).
type Upstream = (request: { method: string; url: string }) => Response | undefined;

let upstream: Upstream = () => undefined;

const realFetch = globalThis.fetch;

beforeAll(() => {
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);

    return (
      upstream({ method: request.method, url: request.url }) ??
      new Response("no upstream route", { status: 599 })
    );
  };
});

afterEach(() => {
  upstream = () => undefined;
});

const withoutUsage = makeHarness(undefined, { USAGE: undefined as unknown as D1Database });

afterAll(async () => {
  globalThis.fetch = realFetch;
  await harness.dispose();
  await withoutUsage.dispose();
});

/** `fetch` that answers through the harness (an admin's Access token is added). */
const fetchVia =
  (target: Harness): typeof fetch =>
  async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);

    return await target.call(`${url.pathname}${url.search}`, {
      method: request.method,
      headers: request.headers,
      ...(request.body === null ? {} : { body: await request.text() }),
    });
  };

/** The generated client; `Fetch` is read per request, so it is provided around the whole test (`through`). */
const client = HttpApiClient.make(ManagementApi, { baseUrl: "https://proxy.test" });

const through = (target: Harness) =>
  Effect.provide(
    Layer.mergeAll(FetchHttpClient.layer, Layer.succeed(FetchHttpClient.Fetch, fetchVia(target))),
  );

beforeEach(async () => {
  await resetControlPlane();
  await resetUsageDb();
});

/** Imports a Claude auth file into the ControlPlane. */
const seed = (name: string, extra: Record<string, unknown> = {}) =>
  Effect.promise(async () => {
    await controlPlane().importAuthFile(name, JSON.stringify(claudeFile(extra)));
  });

describe("management contract", () => {
  it.effect("decodes the credential list", () =>
    Effect.gen(function* () {
      yield* Effect.promise(async () => {
        await controlPlane().importAuthFile("claude-a.json", JSON.stringify(claudeFile()));
        await controlPlane().importAuthFile(
          "claude-b.json",
          JSON.stringify(
            claudeFile({ email: "b@x.com", priority: 2, note: "backup", disabled: true }),
          ),
        );
      });

      const api = yield* client;
      const { files } = yield* api.credentials.list();

      assert.deepStrictEqual(
        files.map((file) => [file.name, file.provider, file.email, file.disabled]),
        [
          ["claude-a.json", "claude", "me@x.com", false],
          ["claude-b.json", "claude", "b@x.com", true],
        ],
      );
      assert.strictEqual(files[1]?.priority, 2);
      assert.strictEqual(files[1]?.note, "backup");
      assert.strictEqual(files[0]?.recent_requests.length, 20);
    }).pipe(through(harness)),
  );

  it.effect("decodes usage summaries for every group key", () =>
    Effect.gen(function* () {
      yield* Effect.promise(async () => {
        const db = await resetUsageDb();
        await insertUsageRecord(db, sampleRecord());
        await insertUsageRecord(db, sampleRecord({ model: "gpt-5-mini", failed: true }));
      });

      const api = yield* client;

      for (const groupBy of UsageGroupBy.literals) {
        const summary = yield* api.usage.summary({
          query: { group_by: groupBy, since: 1_600_000_000_000 },
        });

        assert.strictEqual(summary.group_by, groupBy);
        assert.strictEqual(summary.totals.requests, 2);
        assert.strictEqual(summary.totals.failed, 1);
      }

      const byModel = yield* api.usage.summary({ query: { group_by: "model", model: "gpt-5" } });
      assert.deepStrictEqual(
        byModel.groups.map((group) => [group.key, group.requests]),
        [["gpt-5", 1]],
      );
    }).pipe(through(harness)),
  );

  describe("usage records", () => {
    const seedRecords = Effect.promise(async () => {
      const db = await resetUsageDb();
      const base = 1_700_000_000_000;
      await insertUsageRecord(db, sampleRecord({ requestId: "r1", requestedAt: base }));
      await insertUsageRecord(
        db,
        sampleRecord({
          requestId: "r2",
          requestedAt: base + 1000,
          authId: "codex-b.json",
          failed: true,
          fail: { statusCode: 429, body: "rate limited" },
        }),
      );
      await insertUsageRecord(db, sampleRecord({ requestId: "r3", requestedAt: base + 2000 }));
    });

    it.effect("decodes records newest first", () =>
      Effect.gen(function* () {
        yield* seedRecords;
        const api = yield* client;
        const page = yield* api.usage.records({ query: {} });

        assert.deepStrictEqual(
          page.records.map((record) => record.request_id),
          ["r3", "r2", "r1"],
        );
        assert.strictEqual(page.next_before, undefined);

        const first = page.records[2];
        assert.strictEqual(first?.api_key, "user:dev@example.com");
        assert.strictEqual(first?.failed, false);
        assert.deepStrictEqual(first?.fail, { status_code: 200, body: "" });
        assert.strictEqual(first?.token_breakdown.output.reasoning_tokens, 12);
        assert.strictEqual(first?.trace_id, "trace-1");
      }).pipe(through(harness)),
    );

    it.effect("filters failed records with their status and body", () =>
      Effect.gen(function* () {
        yield* seedRecords;
        const api = yield* client;
        const page = yield* api.usage.records({ query: { failed: "true" } });

        assert.strictEqual(page.records.length, 1);
        assert.strictEqual(page.records[0]?.request_id, "r2");
        assert.strictEqual(page.records[0]?.failed, true);
        assert.deepStrictEqual(page.records[0]?.fail, { status_code: 429, body: "rate limited" });

        const ok = yield* api.usage.records({ query: { failed: "false" } });
        assert.deepStrictEqual(
          ok.records.map((record) => record.request_id),
          ["r3", "r1"],
        );
      }).pipe(through(harness)),
    );

    it.effect("pages with limit and next_before", () =>
      Effect.gen(function* () {
        yield* seedRecords;
        const api = yield* client;
        const first = yield* api.usage.records({ query: { limit: 2 } });

        assert.deepStrictEqual(
          first.records.map((record) => record.request_id),
          ["r3", "r2"],
        );
        assert.isDefined(first.next_before);

        const second = yield* api.usage.records({
          query: { limit: 2, before: first.next_before ?? "" },
        });

        assert.deepStrictEqual(
          second.records.map((record) => record.request_id),
          ["r1"],
        );
        assert.strictEqual(second.next_before, undefined);
      }).pipe(through(harness)),
    );

    it.effect("filters by auth_id", () =>
      Effect.gen(function* () {
        yield* seedRecords;
        const api = yield* client;
        const page = yield* api.usage.records({ query: { auth_id: "codex-a.json" } });

        assert.deepStrictEqual(
          page.records.map((record) => record.request_id),
          ["r3", "r1"],
        );
      }).pipe(through(harness)),
    );
  });

  it("lists the same group keys as the D1 summary", () => {
    assert.deepStrictEqual([...UsageGroupBy.literals], [...GROUP_BY]);
  });

  it.effect("decodes error bodies into ManagementError", () =>
    Effect.gen(function* () {
      const api = yield* client;
      const error = yield* Effect.flip(api.usage.summary({ query: {} }));

      assert.instanceOf(error, ManagementError);
      assert.strictEqual(error.error, "usage store unavailable");
    }).pipe(through(withoutUsage)),
  );

  describe("credential mutations", () => {
    it.effect("setDisabled toggles the flag and a missing file is a 404", () =>
      Effect.gen(function* () {
        yield* seed("a.json");
        const api = yield* client;

        const off = yield* api.credentials.setDisabled({
          payload: { name: "a.json", disabled: true },
        });

        assert.deepStrictEqual(off, { status: "ok", disabled: true });
        assert.strictEqual((yield* api.credentials.list()).files[0]?.disabled, true);

        const on = yield* api.credentials.setDisabled({
          payload: { name: "a.json", disabled: false },
        });

        assert.deepStrictEqual(on, { status: "ok", disabled: false });
        assert.strictEqual((yield* api.credentials.list()).files[0]?.disabled, false);

        const error = yield* Effect.flip(
          api.credentials.setDisabled({ payload: { name: "ghost.json", disabled: true } }),
        );

        assert.instanceOf(error, ManagementError);
        assert.strictEqual(error.error, "auth file not found");
      }).pipe(through(harness)),
    );

    it.effect("patchFields sets, clears and rejects fields", () =>
      Effect.gen(function* () {
        yield* seed("a.json");
        const api = yield* client;

        assert.deepStrictEqual(
          yield* api.credentials.patchFields({
            payload: { name: "a.json", priority: 5, note: "primary", weight: 3, request_retry: 2 },
          }),
          { status: "ok" },
        );

        const set = (yield* api.credentials.list()).files[0];
        assert.strictEqual(set?.priority, 5);
        assert.strictEqual(set?.note, "primary");
        assert.strictEqual(set?.weight, 3);
        assert.strictEqual(set?.request_retry, 2);

        yield* api.credentials.patchFields({
          payload: { name: "a.json", priority: null, note: null, request_retry: null },
        });

        const cleared = (yield* api.credentials.list()).files[0];
        assert.strictEqual(cleared?.priority, undefined);
        assert.strictEqual(cleared?.note, undefined);
        assert.strictEqual(cleared?.request_retry, undefined);

        const invalid = yield* Effect.flip(
          api.credentials.patchFields({ payload: { name: "a.json", weight: 2_000_000 } }),
        );

        assert.instanceOf(invalid, ManagementError);

        const missing = yield* Effect.flip(
          api.credentials.patchFields({ payload: { name: "ghost.json", note: "x" } }),
        );

        assert.instanceOf(missing, ManagementError);
        assert.strictEqual(missing.error, "auth file not found");
      }).pipe(through(harness)),
    );

    it.effect("refresh answers the fresh entry without a refresh token", () =>
      Effect.gen(function* () {
        yield* Effect.promise(async () => {
          await controlPlane().importAuthFile(
            "noref.json",
            JSON.stringify({ type: "claude", email: "n@x.com", access_token: "t" }),
          );
        });
        const api = yield* client;
        const refreshed = yield* api.credentials.refresh({ payload: { name: "noref.json" } });

        assert.strictEqual(refreshed.ok, true);
        assert.strictEqual(refreshed.auth.name, "noref.json");
        assert.strictEqual(refreshed.auth.email, "n@x.com");

        const error = yield* Effect.flip(
          api.credentials.refresh({ payload: { name: "ghost.json" } }),
        );

        assert.instanceOf(error, ManagementError);
        assert.strictEqual(error.error, "auth file not found");
      }).pipe(through(harness)),
    );

    it.effect("refresh with a mocked token endpoint decodes the entry", () =>
      Effect.gen(function* () {
        upstream = ({ method, url }) =>
          `${method} ${url}` === "POST https://platform.claude.com/v1/oauth/token"
            ? Response.json({
                access_token: "new-access",
                refresh_token: "new-refresh",
                expires_in: 3600,
              })
            : undefined;
        yield* seed("a.json");
        const api = yield* client;
        const refreshed = yield* api.credentials.refresh({ payload: { name: "a.json" } });

        assert.strictEqual(refreshed.auth.name, "a.json");
        assert.strictEqual(refreshed.auth.recent_requests.length, 20);
      }).pipe(through(harness)),
    );

    it.effect("resetCooldown answers the cleared models and a missing index is a 404", () =>
      Effect.gen(function* () {
        yield* seed("a.json");
        const api = yield* client;
        const entry = (yield* api.credentials.list()).files[0];
        assert.isDefined(entry);

        const reset = yield* api.credentials.resetCooldown({
          payload: { auth_index: entry?.auth_index ?? "" },
        });

        assert.strictEqual(reset.status, "ok");
        assert.strictEqual(reset.auth_index, entry?.auth_index);
        assert.isArray(reset.models);

        const error = yield* Effect.flip(
          api.credentials.resetCooldown({ payload: { auth_index: "0000000000000000" } }),
        );

        assert.instanceOf(error, ManagementError);
        assert.strictEqual(error.error, "auth not found");
      }).pipe(through(harness)),
    );

    it.effect("remove deletes one credential and a missing one is a 404", () =>
      Effect.gen(function* () {
        yield* seed("a.json");
        yield* seed("b.json", { email: "b@x.com" });
        const api = yield* client;

        assert.deepStrictEqual(yield* api.credentials.remove({ query: { name: "a.json" } }), {
          status: "ok",
        });
        assert.deepStrictEqual(
          (yield* api.credentials.list()).files.map((file) => file.name),
          ["b.json"],
        );

        const error = yield* Effect.flip(api.credentials.remove({ query: { name: "a.json" } }));
        assert.instanceOf(error, ManagementError);
        assert.strictEqual(error.error, "auth file not found");
      }).pipe(through(harness)),
    );

    it.effect("upload sends the JSON text and rejects an invalid file", () =>
      Effect.gen(function* () {
        const api = yield* client;

        assert.deepStrictEqual(
          yield* api.credentials.upload({
            query: { name: "up.json" },
            payload: JSON.stringify(claudeFile({ email: "up@x.com" })),
          }),
          { status: "ok" },
        );

        const files = (yield* api.credentials.list()).files;
        assert.deepStrictEqual(
          files.map((file) => [file.name, file.email]),
          [["up.json", "up@x.com"]],
        );

        const notJson = yield* Effect.flip(
          api.credentials.upload({ query: { name: "bad.json" }, payload: "not json" }),
        );

        assert.instanceOf(notJson, ManagementError);
        assert.include(notJson.error, "invalid auth file");

        const noType = yield* Effect.flip(
          api.credentials.upload({ query: { name: "bad.json" }, payload: "{}" }),
        );

        assert.instanceOf(noType, ManagementError);

        const badName = yield* Effect.flip(
          api.credentials.upload({
            query: { name: "bad.txt" },
            payload: JSON.stringify(claudeFile()),
          }),
        );

        assert.instanceOf(badName, ManagementError);
      }).pipe(through(harness)),
    );

    it.effect("models decodes the registry's list and rejects an empty name", () =>
      Effect.gen(function* () {
        yield* seed("a.json");
        const api = yield* client;
        const { models } = yield* api.credentials.models({ query: { name: "a.json" } });

        assert.isArray(models);

        const error = yield* Effect.flip(api.credentials.models({ query: { name: "" } }));
        assert.instanceOf(error, ManagementError);
        assert.strictEqual(error.error, "name is required");
      }).pipe(through(harness)),
    );
  });

  describe("oauth", () => {
    it.effect("start answers a callback flow's authorize URL, pending status and cancel", () =>
      Effect.gen(function* () {
        const api = yield* client;
        const started = yield* api.oauth.start({ query: { provider: "claude" } });

        assert.strictEqual(started.status, "ok");
        assert.strictEqual(new URL(started.url).hostname, "claude.ai");
        assert.isAbove(started.state.length, 0);
        assert.strictEqual(started.flow, undefined);

        assert.deepStrictEqual(yield* api.oauth.status({ query: { state: started.state } }), {
          status: "wait",
        });
        assert.deepStrictEqual(yield* api.oauth.cancel({ query: { state: started.state } }), {
          status: "ok",
          cancelled: true,
        });
        assert.deepStrictEqual(yield* api.oauth.status({ query: { state: started.state } }), {
          status: "error",
          error: "unknown or expired state",
        });
      }).pipe(through(harness)),
    );

    it.effect("start answers a device flow with a user code", () =>
      Effect.gen(function* () {
        upstream = ({ method, url }) => {
          const key = `${method} ${url}`;

          if (key === "GET https://auth.x.ai/.well-known/openid-configuration") {
            return Response.json({
              device_authorization_endpoint: "https://auth.x.ai/oauth2/device/code",
              token_endpoint: "https://auth.x.ai/oauth2/token",
            });
          }

          return key === "POST https://auth.x.ai/oauth2/device/code"
            ? Response.json({
                device_code: "dc",
                user_code: "UC-1",
                verification_uri: "https://x.ai/device",
                expires_in: 900,
              })
            : undefined;
        };

        const api = yield* client;
        const started = yield* api.oauth.start({ query: { provider: "xai" } });

        assert.strictEqual(started.flow, "device");
        assert.strictEqual(started.url, "https://x.ai/device");
        assert.strictEqual(started.user_code, "UC-1");
        assert.strictEqual(started.expires_in, 900);
        assert.deepStrictEqual(yield* api.oauth.status({ query: { state: started.state } }), {
          status: "wait",
        });
      }).pipe(through(harness)),
    );

    it.effect("status of an unknown state is an error progress, not a failure", () =>
      Effect.gen(function* () {
        const api = yield* client;

        assert.deepStrictEqual(yield* api.oauth.status({ query: { state: "nope-123" } }), {
          status: "error",
          error: "unknown or expired state",
        });
      }).pipe(through(harness)),
    );

    it.effect("cancel of an unknown state answers cancelled: false", () =>
      Effect.gen(function* () {
        const api = yield* client;
        const cancelled = yield* api.oauth.cancel({ query: { state: "nope-123" } });

        assert.strictEqual(cancelled.status, "ok");
        assert.strictEqual(cancelled.cancelled, false);
      }).pipe(through(harness)),
    );

    it.effect("callback with a malformed redirect_url is a ManagementError", () =>
      Effect.gen(function* () {
        const api = yield* client;

        const unparsable = yield* Effect.flip(
          api.oauth.callback({ payload: { provider: "claude", redirect_url: "http://" } }),
        );

        assert.instanceOf(unparsable, ManagementError);
        assert.strictEqual(unparsable.error, "invalid redirect_url");

        // A pasted string that parses (relative to localhost) but carries no state is rejected too.
        const stateless = yield* Effect.flip(
          api.oauth.callback({ payload: { provider: "claude", redirect_url: "not a url" } }),
        );

        assert.instanceOf(stateless, ManagementError);
        assert.strictEqual(stateless.error, "state is required");
      }).pipe(through(harness)),
    );
  });
});
