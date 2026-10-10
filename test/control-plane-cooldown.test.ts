// Cooldown/quota state, retry planning and the Worker-side picker through the real ControlPlane Durable Object.
import { env } from "cloudflare:workers";
import { evictDurableObject } from "cloudflare:test";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { makeControlPlanePicker } from "../src/executor/control-plane-picker.ts";
import { WorkerEnv } from "../src/platform/env.ts";
import type { PickResult } from "../src/credentials/selection/types.ts";

const plane = (name: string = crypto.randomUUID()) => env.CONTROL_PLANE.getByName(name);

const claudeFile = (extra: Record<string, unknown> = {}) => ({
  type: "claude",
  email: "me@x.com",
  access_token: "sk-ant-oat-secret-access",
  refresh_token: "secret-refresh",
  expired: "2999-01-01T00:00:00Z",
  ...extra,
});

const picked = (result: PickResult) => {
  if (!result.ok) throw new Error(`pick failed: ${result.failure.code}`);

  return result;
};

const fail = (httpStatus: number, extra: Record<string, unknown> = {}) => ({
  success: false as const,
  httpStatus,
  error: { message: `status ${httpStatus}`, retryable: false, httpStatus },
  ...extra,
});

describe("ControlPlane report -> cooldown (Workers pool)", () => {
  it("cools a rate-limited credential per model and answers model_cooldown with Retry-After", async () => {
    const stub = plane();
    await stub.importAuthFile("claude-a.json", claudeFile());
    const request = { providers: ["claude"], model: "claude-sonnet-4-5" };
    const first = picked(await stub.pick(request));
    await stub.report(first.lease, fail(429, { retryAfterMs: 90_000 }));

    const blocked = await stub.pick(request);
    expect(blocked).toMatchObject({
      ok: false,
      failure: { code: "model_cooldown", httpStatus: 429 },
    });

    if (blocked.ok) return;
    expect(blocked.failure.retryAfterSeconds).toBeGreaterThan(80);
    expect(JSON.parse(blocked.failure.body ?? "{}")).toMatchObject({
      error: { code: "model_cooldown" },
    });
    // Another model of the same credential is unaffected.
    expect((await stub.pick({ providers: ["claude"], model: "claude-opus-4-1" })).ok).toBe(true);

    const [summary] = await stub.listCredentials();
    expect(summary).toMatchObject({ failed: 1, lastError: { httpStatus: 429 } });
  });

  it("credential-scoped failures block every model and success of a request-scoped failure changes nothing", async () => {
    const stub = plane();
    await stub.importAuthFile("claude-a.json", claudeFile());
    const first = picked(await stub.pick({ providers: ["claude"], model: "claude-sonnet-4-5" }));
    await stub.report(first.lease, fail(400, { requestScoped: true }));
    expect((await stub.pick({ providers: ["claude"], model: "claude-sonnet-4-5" })).ok).toBe(true);
    await stub.report(first.lease, fail(429, { retryAfterMs: 60_000, credentialScoped: true }));
    expect(await stub.pick({ providers: ["claude"], model: "claude-opus-4-1" })).toMatchObject({
      ok: false,
      failure: { code: "model_cooldown" },
    });
  });

  it("planRetry answers over RPC", async () => {
    const stub = plane();
    await stub.importAuthFile("claude-a.json", claudeFile());
    const first = picked(await stub.pick({ providers: ["claude"], model: "claude-sonnet-4-5" }));
    await stub.report(first.lease, fail(429, { retryAfterMs: 20_000 }));

    const query = {
      providers: ["claude"],
      model: "claude-sonnet-4-5",
      round: 0,
      requestRetry: 1,
      status: 429,
      attempted: ["claude-a.json"],
      maxWaitMs: 60_000,
    };

    const plan = await stub.planRetry(query);
    expect(plan.retry).toBe(true);
    expect(plan.retry && plan.waitMs).toBeGreaterThan(10_000);
    expect(await stub.planRetry({ ...query, maxWaitMs: 0 })).toMatchObject({ retry: false });
    expect(await stub.planRetry({ ...query, round: 1 })).toEqual({ retry: false });
  });

  it("keeps cooldowns across Durable Object evictions only with save-cooldown-status", async () => {
    const withSave = crypto.randomUUID();
    const without = crypto.randomUUID();

    for (const [name, yaml] of [
      [withSave, "routing: { cooldown: { save-cooldown-status: true } }"],
      [without, "routing: {}"],
    ] as const) {
      const stub = plane(name);
      await stub.putConfig(yaml);
      await stub.importAuthFile("claude-a.json", claudeFile());
      const first = picked(await stub.pick({ providers: ["claude"], model: "claude-sonnet-4-5" }));
      await stub.report(first.lease, fail(500));
      await evictDurableObject(stub);
    }

    expect(
      await plane(withSave).pick({ providers: ["claude"], model: "claude-sonnet-4-5" }),
    ).toMatchObject({
      ok: false,
      failure: { code: "auth_unavailable", httpStatus: 503 },
    });
    expect(
      (await plane(without).pick({ providers: ["claude"], model: "claude-sonnet-4-5" })).ok,
    ).toBe(true);
  });
});

describe("ControlPlane picker adapter (Workers pool)", () => {
  it("maps picks, model_cooldown failures and reports through the Durable Object", async () => {
    const name = crypto.randomUUID();
    const stub = plane(name);
    await stub.putConfig(`
api-keys:
  openai-compatibility:
    - name: oc
      base-url: https://oc.example/v1
      headers: { X-Org: acme }
      models: [{ name: up-1, alias: shared }, { name: up-2, alias: shared }]
      keys: [{ api-key: key-oc }]
`);
    const picker = makeControlPlanePicker((workerEnv) => workerEnv.CONTROL_PLANE.getByName(name));

    const run = <A, E>(effect: Effect.Effect<A, E, WorkerEnv>) =>
      Effect.runPromise(effect.pipe(Effect.provideService(WorkerEnv, env)));

    const result = await run(
      picker.pick({ providers: ["openai-compatible-oc"], model: "shared", callerScope: "s" }),
    );

    expect(result.credential).toMatchObject({
      provider: "openai-compatible-oc",
      kind: "apikey",
      attributes: { api_key: "key-oc", base_url: "https://oc.example/v1", "header:X-Org": "acme" },
    });
    expect(result.route.pooled).toBe(true);
    expect(result.route.upstreamModels.toSorted()).toEqual(["up-1", "up-2"]);

    await run(
      picker.report(result.lease, {
        success: false,
        httpStatus: 429,
        error: { message: "q", retryable: true, httpStatus: 429 },
        retryAfterMs: 60_000,
        model: "up-1",
      }),
    );

    const next = await run(
      picker.pick({ providers: ["openai-compatible-oc"], model: "shared", callerScope: "s" }),
    );

    expect(next.route.upstreamModels).toEqual(["up-2"]);
    await run(
      picker.report(next.lease, {
        success: false,
        httpStatus: 429,
        error: { message: "q", retryable: true, httpStatus: 429 },
        retryAfterMs: 60_000,
        model: "up-2",
      }),
    );

    const error = await run(
      Effect.flip(
        picker.pick({ providers: ["openai-compatible-oc"], model: "shared", callerScope: "s" }),
      ),
    );

    expect(error).toMatchObject({ status: 429, code: "model_cooldown" });
    expect(error.safeHeaders?.["retry-after"]).toBeDefined();

    const plan = await run(
      picker.planRetry({
        providers: ["openai-compatible-oc"],
        model: "shared",
        round: 0,
        requestRetry: 1,
        status: 429,
        maxWaitMs: 0,
      }),
    );

    expect(plan.retry).toBe(false);
  });
});
