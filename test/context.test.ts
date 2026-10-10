import { env } from "cloudflare:workers";
import { it } from "@effect/vitest";
import { Context, Effect, Layer } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { expect } from "vitest";
import { CorsLayer } from "../src/http/cors.ts";
import { requestContext, WorkerEnv, WorkerExecutionContext } from "../src/platform/env.ts";
import { redactHeaders } from "../src/platform/logging.ts";

// Only `waitUntil`/`passThroughOnException` are exercised; the rest of the interface is runtime-internal.
const executionContext = {
  waitUntil: () => {},
  passThroughOnException: () => {},
  props: {},
} as unknown as ExecutionContext;

it.effect("requestContext provides WorkerEnv and WorkerExecutionContext", () =>
  Effect.sync(() => {
    const context = requestContext(env, executionContext);
    expect(Context.get(context, WorkerEnv)).toBe(env);
    expect(Context.get(context, WorkerExecutionContext)).toBe(executionContext);
  }),
);

it.effect("web handler routes see per-request env/ctx services", () =>
  Effect.gen(function* () {
    const Route = HttpRouter.add(
      "GET",
      "/binding",
      Effect.gen(function* () {
        const bindings = yield* WorkerEnv;
        const ctx = yield* WorkerExecutionContext;

        return HttpServerResponse.text(`${typeof bindings.CACHE.get}:${ctx === executionContext}`);
      }),
    );

    const { handler, dispose } = HttpRouter.toWebHandler(Layer.mergeAll(Route, CorsLayer), {
      disableLogger: true,
    });

    const response = yield* Effect.promise(() =>
      handler(new Request("https://proxy.test/binding"), requestContext(env, executionContext)),
    );

    expect(yield* Effect.promise(() => response.text())).toBe("function:true");
    yield* Effect.promise(dispose);
  }),
);

it("redactHeaders hides credentials", () => {
  const redacted = redactHeaders(
    new Headers({
      authorization: "Bearer secret",
      "cf-access-jwt-assertion": "jwt",
      accept: "*/*",
    }),
  );

  expect(redacted).toEqual({
    authorization: "[redacted]",
    "cf-access-jwt-assertion": "[redacted]",
    accept: "*/*",
  });
});
