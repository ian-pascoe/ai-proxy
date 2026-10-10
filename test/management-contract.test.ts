// The shared management contract (src/management/contract) against the real handlers: the panel's generated client
// calls the management routes through the Access gate and must decode what they answer.
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { afterAll, beforeEach } from "vitest";
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

const withoutUsage = makeHarness(undefined, { USAGE: undefined as unknown as D1Database });

afterAll(async () => {
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
});
