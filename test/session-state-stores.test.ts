// The replay and continuity stores over the real SessionState Durable Object: state written by one Worker invocation
// (a fresh store instance with its own request context) is read by another, TTLs follow the Effect clock (TestClock)
// and a turn costs the documented number of round trips.
import { env } from "cloudflare:workers";
import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import { makeSessionStateContinuityStore } from "../src/executor/claude/continuity.ts";
import { makeSessionStateReplayStore as makeClaudeReplayStore } from "../src/executor/claude/thinking-replay.ts";
import {
  CODEX_REASONING_REPLAY_TURN_TYPE,
  makeSessionStateReplayStore as makeCodexStore,
} from "../src/executor/codex/replay.ts";
import { nextSessionTurnIndex, resetSessionTurnIndex } from "../src/executor/devin/credentials.ts";
import { makeRequestReplayCache } from "../src/executor/gemini/replay.ts";
import { makeSessionStateKimiReplayStore } from "../src/executor/kimi/replay.ts";
import { makeSessionStateXaiReplayStore } from "../src/executor/xai/replay.ts";
import { WorkerEnv } from "../src/platform/env.ts";
import {
  addressName,
  durableObjectBackend,
  fixedBackend,
  resolveBackend,
  type SessionStateBackend,
} from "../src/session-state/client.ts";
import type { SessionAddress } from "../src/session-state/protocol.ts";
import { grokCiphertext } from "./support/xai.ts";

const workerEnv = env;

/** One Worker invocation: the effect runs with its own request context (the bindings of `env`). */
const invocation = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, E> =>
  effect.pipe(Effect.provideService(WorkerEnv, workerEnv));

// The Durable Object arms alarms at absolute expiry times: start the test clock at the real time so they stay in the
// future, then move it with TestClock.
const startClock = TestClock.setTime(Date.now());

const unique = (name: string): string => `${name}-${crypto.randomUUID()}`;

const MINUTE = 60_000;

/** Counts backend round trips. */
const counting = (inner: SessionStateBackend) => {
  let count = 0;

  const backend: SessionStateBackend = {
    run: (address, ops) => {
      count++;

      return inner.run(address, ops);
    },
  };

  return { backend, runs: () => count };
};

const countingDo = () => counting(durableObjectBackend(workerEnv.SESSION_STATE));

// A structurally valid GPT reasoning signature (version 0x80, 73 bytes), as in codex-unit.test.ts.
const gptSignature = (() => {
  const bytes = new Uint8Array(73);
  bytes[0] = 0x80;
  bytes.fill(7, 5);

  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
})();

describe("Codex reasoning replay over SessionState", () => {
  const turn = (id: string) => [
    { type: CODEX_REASONING_REPLAY_TURN_TYPE, id, call_ids: ["call_1"] },
    { type: "reasoning", summary: [], content: null, encrypted_content: gptSignature },
    { type: "function_call", call_id: "call_1", name: "Read", arguments: "{}" },
  ];

  it.effect("is shared across invocations, expires after an hour and clears", () =>
    Effect.gen(function* () {
      yield* startClock;
      const session = unique("claude:sess");
      const first = makeCodexStore();
      const second = makeCodexStore();
      yield* invocation(first.append("gpt-5.4", session, turn("t1")));
      // A duplicate turn id is ignored, a new turn is appended (compare-and-swap read-modify-write).
      yield* invocation(second.append("gpt-5.4", session, turn("t1")));
      yield* invocation(second.append("gpt-5.4", session, turn("t2")));
      const items = yield* invocation(makeCodexStore().get("gpt-5.4", session));
      assert.strictEqual(items?.length, 6);

      // The entry lives in the Durable Object, not in this isolate.
      const [raw] = yield* Effect.promise(
        async () =>
          await workerEnv.SESSION_STATE.getByName(
            addressName({ store: "codex-replay", scope: "", session }),
          ).run([{ op: "get", key: "gpt-5.4" }], Date.now()),
      );

      assert.strictEqual(raw?.status, "ok");
      assert.isTrue(raw?.status === "ok" && raw.value !== undefined);

      // Other models and sessions are independent.
      assert.isUndefined(yield* invocation(first.get("gpt-5.5", session)));
      assert.isUndefined(yield* invocation(first.get("gpt-5.4", unique("other"))));

      yield* TestClock.adjust(59 * MINUTE);
      assert.strictEqual((yield* invocation(first.get("gpt-5.4", session)))?.length, 6);
      yield* TestClock.adjust(2 * MINUTE);
      assert.isUndefined(yield* invocation(first.get("gpt-5.4", session)));

      yield* invocation(first.append("gpt-5.4", session, turn("t3")));
      yield* invocation(second.clear("gpt-5.4", session));
      assert.isUndefined(yield* invocation(first.get("gpt-5.4", session)));
    }),
  );

  it.effect("costs one round trip for a read and two for an append", () =>
    Effect.gen(function* () {
      yield* startClock;
      const { backend, runs } = countingDo();
      const store = makeCodexStore(fixedBackend(backend));
      const session = unique("claude:rt");
      yield* invocation(store.append("gpt-5.4", session, turn("t1")));
      assert.strictEqual(runs(), 2); // read + compare-and-swap write
      yield* invocation(store.get("gpt-5.4", session));
      assert.strictEqual(runs(), 3);
    }),
  );

  it.effect("falls back to the per-isolate memory without the binding", () =>
    Effect.gen(function* () {
      const session = unique("claude:mem");
      const store = makeCodexStore();
      yield* store.append("gpt-5.4", session, turn("t1"));
      assert.strictEqual((yield* makeCodexStore().get("gpt-5.4", session))?.length, 3);
    }),
  );
});

describe("xAI reasoning replay over SessionState", () => {
  const items = [
    { type: "reasoning", summary: [], content: null, encrypted_content: grokCiphertext(5) },
  ];

  it.effect("is shared across invocations and a hit slides the TTL", () =>
    Effect.gen(function* () {
      yield* startClock;
      const session = unique("caller:abc");
      assert.strictEqual(
        yield* invocation(makeSessionStateXaiReplayStore().store("grok-4.3", session, items)),
        "stored",
      );
      assert.strictEqual(
        yield* invocation(
          makeSessionStateXaiReplayStore().store("grok-4.3", session, [{ type: "message" }]),
        ),
        "none",
      );
      yield* TestClock.adjust(40 * MINUTE);
      assert.strictEqual(
        (yield* invocation(makeSessionStateXaiReplayStore().get("grok-4.3", session)))?.length,
        1,
      );
      yield* TestClock.adjust(40 * MINUTE);
      assert.strictEqual(
        (yield* invocation(makeSessionStateXaiReplayStore().get("grok-4.3", session)))?.length,
        1,
      );
      yield* TestClock.adjust(61 * MINUTE);
      assert.isUndefined(
        yield* invocation(makeSessionStateXaiReplayStore().get("grok-4.3", session)),
      );
      yield* invocation(makeSessionStateXaiReplayStore().store("grok-4.3", session, items));
      yield* invocation(makeSessionStateXaiReplayStore().delete("grok-4.3", session));
      assert.isUndefined(
        yield* invocation(makeSessionStateXaiReplayStore().get("grok-4.3", session)),
      );
    }),
  );
});

describe("Claude and Kimi thinking replay over SessionState", () => {
  const content = [
    { type: "thinking", thinking: "plan", signature: "sig" },
    { type: "tool_use", id: "toolu_1", name: "Read", input: {} },
  ];

  it.effect("guards writes with the snapshot generation (compare-and-swap)", () =>
    Effect.gen(function* () {
      yield* startClock;
      const session = unique("caller:claude");
      const a = makeClaudeReplayStore();
      const b = makeClaudeReplayStore();
      assert.isUndefined(yield* invocation(a.get("claude:fam", session)));
      // Both turns read an empty ledger; the first writer wins, the stale one is refused.
      assert.isTrue(
        yield* invocation(a.replaceIfUnchanged("claude:fam", session, undefined, content)),
      );
      assert.isFalse(
        yield* invocation(
          b.replaceIfUnchanged("claude:fam", session, undefined, [{ type: "text" }]),
        ),
      );
      assert.isFalse(yield* invocation(b.deleteIfUnchanged("claude:fam", session, undefined)));

      const stored = yield* invocation(b.get("claude:fam", session));
      assert.deepStrictEqual(stored?.contents, [content]);
      assert.isTrue(
        yield* invocation(
          b.replaceIfUnchanged("claude:fam", session, stored?.snapshot, [{ type: "text" }]),
        ),
      );
      // `a` still holds the first snapshot: its delete must not remove the newer entry.
      assert.isFalse(
        yield* invocation(a.deleteIfUnchanged("claude:fam", session, stored?.snapshot)),
      );
      const latest = yield* invocation(a.get("claude:fam", session));
      assert.deepStrictEqual(latest?.contents, [[{ type: "text" }]]);
      assert.isTrue(
        yield* invocation(a.deleteIfUnchanged("claude:fam", session, latest?.snapshot)),
      );
      assert.isUndefined(yield* invocation(a.get("claude:fam", session)));
    }),
  );

  it.effect(
    "keeps Claude and Kimi in separate namespaces and expires the Kimi entry after an hour",
    () =>
      Effect.gen(function* () {
        yield* startClock;
        const session = unique("caller:kimi");
        const claude = makeClaudeReplayStore();
        const kimi = makeSessionStateKimiReplayStore();
        yield* invocation(kimi.replaceIfUnchanged("k3", session, undefined, content));
        assert.isUndefined(yield* invocation(claude.get("k3", session)));
        assert.isDefined(yield* invocation(makeSessionStateKimiReplayStore().get("k3", session)));
        yield* TestClock.adjust(61 * MINUTE);
        assert.isUndefined(yield* invocation(makeSessionStateKimiReplayStore().get("k3", session)));
      }),
  );
});

describe("Claude continuity over SessionState", () => {
  it.effect(
    "shares prompt id, previous ids and pinned date across invocations with few round trips",
    () =>
      Effect.gen(function* () {
        yield* startClock;
        const identity = `id:${unique("cred")}`;
        const session = unique("session");
        const { backend, runs } = countingDo();
        const a = makeSessionStateContinuityStore(fixedBackend(backend));
        const b = makeSessionStateContinuityStore();

        const first = yield* invocation(a.begin(identity, session, true, "", "2026-01-01"));
        assert.isDefined(first);

        if (first === undefined) return;
        assert.strictEqual(runs(), 2); // read + write of the new prompt id and date
        assert.strictEqual(first.previousMessageId, "");
        assert.strictEqual(first.pinnedDate, "2026-01-01");
        yield* invocation(a.commit(first, "msg_1", "req_abc", first.promptId));
        assert.strictEqual(runs(), 3); // one compare-and-swap write, no read

        // Another invocation continues the same prompt turn: ids and the pinned date survive, nothing is rewritten.
        const second = yield* invocation(b.begin(identity, session, false, "", "2026-01-02"));
        assert.strictEqual(second?.promptId, first.promptId);
        assert.strictEqual(second?.previousMessageId, "msg_1");
        assert.strictEqual(second?.previousRequestId, "req_abc");
        assert.strictEqual(second?.pinnedDate, "2026-01-01");

        // A new prompt turn gets a new prompt id but keeps the history and the date.
        const third = yield* invocation(b.begin(identity, session, true, "", "2026-01-03"));
        assert.notStrictEqual(third?.promptId, first.promptId);
        assert.strictEqual(third?.previousMessageId, "msg_1");

        // A different credential or session is a different conversation.
        const other = yield* invocation(
          b.begin(`id:${unique("cred")}`, session, false, "", "2026-02-01"),
        );

        assert.strictEqual(other?.previousMessageId, "");
        assert.strictEqual(other?.pinnedDate, "2026-02-01");

        yield* TestClock.adjust(61 * MINUTE);
        const expired = yield* invocation(b.begin(identity, session, false, "", "2026-03-01"));
        assert.strictEqual(expired?.previousMessageId, "");
        assert.strictEqual(expired?.pinnedDate, "2026-03-01");
      }),
  );

  it.effect(
    "a commit does not resurrect an expired session and loses to nothing it did not read",
    () =>
      Effect.gen(function* () {
        yield* startClock;
        const identity = `id:${unique("cred")}`;
        const session = unique("session");
        const store = makeSessionStateContinuityStore();
        const state = yield* invocation(store.begin(identity, session, true, "", "2026-01-01"));

        if (state === undefined) return assert.fail("no state");
        yield* TestClock.adjust(61 * MINUTE);
        yield* invocation(store.commit(state, "msg_late", "req_x", state.promptId));
        const fresh = yield* invocation(store.begin(identity, session, false, "", "2026-01-01"));
        assert.strictEqual(fresh?.previousMessageId, "");
      }),
  );
});

describe("Devin turn counter over SessionState", () => {
  it.effect("counts turns atomically across invocations, per caller scope", () =>
    Effect.gen(function* () {
      yield* startClock;
      const session = unique("devin-session");
      const indexes: number[] = [];

      for (let turn = 0; turn < 3; turn++)
        indexes.push(yield* invocation(nextSessionTurnIndex(session, "alice")));
      assert.deepStrictEqual(indexes, [0, 1, 2]);
      assert.strictEqual(yield* invocation(nextSessionTurnIndex(session, "bob")), 0);
      assert.strictEqual(yield* invocation(nextSessionTurnIndex("", "alice")), 0);

      // Two concurrent turns of one session get distinct ordinals.
      const [x, y] = yield* Effect.all(
        [
          invocation(nextSessionTurnIndex(session, "alice")),
          invocation(nextSessionTurnIndex(session, "alice")),
        ],
        { concurrency: 2 },
      );

      assert.deepStrictEqual(
        [x, y].toSorted((a, b) => a - b),
        [3, 4],
      );
    }),
  );

  it.effect("keeps the per-isolate fallback resettable for tests", () =>
    Effect.gen(function* () {
      const session = unique("devin-memory");
      assert.strictEqual(yield* nextSessionTurnIndex(session), 0);
      assert.strictEqual(yield* nextSessionTurnIndex(session), 1);
      resetSessionTurnIndex(session);
      assert.strictEqual(yield* nextSessionTurnIndex(session), 0);
    }),
  );
});

describe("Gemini text signature cache over SessionState", () => {
  const entry = [{ type: "thought_signature", thoughtSignature: "sig", targetHash: "h" }];

  it.effect("hydrates with one read and writes back with one write per flush", () =>
    Effect.gen(function* () {
      yield* startClock;
      const caller = unique("alice");
      const writer = counting(durableObjectBackend(workerEnv.SESSION_STATE));
      const first = makeRequestReplayCache(caller, fixedBackend(writer.backend));
      assert.isTrue(first.set("gemini-2.5-pro", "gemini-responses-text:msg_1", entry));
      assert.isTrue(first.set("gemini-2.5-pro", "gemini-responses-text:msg_2", entry));
      assert.isFalse(first.set("gemini-2.5-pro", "", entry));
      assert.isFalse(first.set("gemini-2.5-pro", "k", []));
      yield* invocation(first.flush);
      yield* invocation(first.flush); // nothing pending: no round trip
      assert.strictEqual(writer.runs(), 1);

      const reader = counting(durableObjectBackend(workerEnv.SESSION_STATE));
      const second = makeRequestReplayCache(caller, fixedBackend(reader.backend));
      yield* invocation(
        second.prefetch("gemini-2.5-pro", [
          "gemini-responses-text:msg_1",
          "gemini-responses-text:msg_2",
          "gemini-responses-text:missing",
        ]),
      );
      assert.strictEqual(reader.runs(), 1);
      assert.deepStrictEqual(second.get("gemini-2.5-pro", "gemini-responses-text:msg_1"), entry);
      assert.isUndefined(second.get("gemini-2.5-pro", "gemini-responses-text:missing"));
      assert.isUndefined(second.get("other-model", "gemini-responses-text:msg_1"));
      // Loaded keys are not read again.
      yield* invocation(second.prefetch("gemini-2.5-pro", ["gemini-responses-text:msg_1"]));
      assert.strictEqual(reader.runs(), 1);

      // Callers are isolated; entries expire after an hour.
      const stranger = makeRequestReplayCache(unique("bob"));
      yield* invocation(stranger.prefetch("gemini-2.5-pro", ["gemini-responses-text:msg_1"]));
      assert.isUndefined(stranger.get("gemini-2.5-pro", "gemini-responses-text:msg_1"));
      yield* TestClock.adjust(61 * MINUTE);
      const late = makeRequestReplayCache(caller);
      yield* invocation(late.prefetch("gemini-2.5-pro", ["gemini-responses-text:msg_1"]));
      assert.isUndefined(late.get("gemini-2.5-pro", "gemini-responses-text:msg_1"));
    }),
  );
});

describe("backend resolution", () => {
  it.effect("uses the Durable Object with a binding and the isolate memory without one", () =>
    Effect.gen(function* () {
      yield* startClock;
      const address: SessionAddress = { store: "probe", scope: "", session: unique("probe") };
      const withBinding = yield* invocation(resolveBackend());
      yield* withBinding.run(address, [{ op: "put", key: "k", value: "v", ttlMs: 60_000 }]);

      const direct = yield* Effect.promise(
        async () =>
          await workerEnv.SESSION_STATE.getByName(addressName(address)).run(
            [{ op: "get", key: "k" }],
            Date.now(),
          ),
      );

      assert.strictEqual(direct[0]?.status === "ok" ? direct[0].value : undefined, "v");

      const memory = yield* resolveBackend();
      const [miss] = yield* memory.run(address, [{ op: "get", key: "k" }]);
      assert.strictEqual(miss?.status === "ok" ? miss.generation : -1, 0);
    }),
  );
});
