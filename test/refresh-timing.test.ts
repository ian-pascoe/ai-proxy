// Retry sleeps and request timeouts use the Effect clock, so they are tested with TestClock (no wall-clock waits).
import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { refreshClaude } from "../src/credentials/refresh/claude.ts";
import { refreshCodex } from "../src/credentials/refresh/codex.ts";
import { mockHttp, T0 } from "./support/refresh.ts";

const context = {
  provider: "codex",
  metadata: { refresh_token: "rt-1" },
  attributes: {},
  now: T0,
  retryDelayMs: (attempt: number) => attempt * 1000,
};

describe("refresh timing", () => {
  it.effect("Codex sleeps 1 s and 2 s between its three attempts", () =>
    Effect.gen(function* () {
      const http = mockHttp(() => ({ status: 400, body: "nope" }));

      const fiber = yield* refreshCodex(context).pipe(
        Effect.provide(http.layer),
        Effect.flip,
        Effect.forkChild,
      );

      yield* TestClock.adjust(0);
      assert.strictEqual(http.requests.length, 1);
      yield* TestClock.adjust(999);
      assert.strictEqual(http.requests.length, 1);
      yield* TestClock.adjust(1);
      assert.strictEqual(http.requests.length, 2);
      yield* TestClock.adjust(2000);
      assert.strictEqual(http.requests.length, 3);
      const error = yield* Fiber.join(fiber);
      assert.strictEqual(error.status, 400);
    }),
  );

  it.effect("a hung upstream fails the refresh after 30 seconds", () =>
    Effect.gen(function* () {
      const http = mockHttp(() => new Promise(() => {}));

      const fiber = yield* refreshClaude({ ...context, provider: "claude" }).pipe(
        Effect.provide(http.layer),
        Effect.flip,
        Effect.forkChild,
      );

      yield* TestClock.adjust(29_999);
      assert.strictEqual(fiber.pollUnsafe(), undefined);
      yield* TestClock.adjust(1);
      const error = yield* Fiber.join(fiber);
      assert.include(error.message, "timed out");
      // a timed-out Claude refresh is not retried: the single-use token may have been consumed
      assert.strictEqual(http.requests.length, 1);
    }),
  );
});
