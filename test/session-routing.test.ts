// Session routing against the Go implementation (`go run ./tools/fixturegen/session`,
// test/fixtures/session.json): canonical turns and fingerprints, the derived content-hash identity, the message-hash
// fallback, identity helpers and scripted LCP matcher scenarios.
import { describe, expect, it } from "vitest";
import { extractSessionInfo } from "../src/handlers/session.ts";
import type { Json, JsonObject } from "../src/json/index.ts";
import { derivedAntigravitySessionId } from "../src/executor/antigravity/derived-session.ts";
import { extractCanonicalTurns, prepareFingerprints } from "../src/session-routing/canonical.ts";
import {
  boundSessionIdentity,
  deriveId,
  hasExplicitSession,
  messageHashIds,
  normalizeToCanonicalUuid,
} from "../src/session-routing/identity.ts";
import { MerklePrefixMatcher } from "../src/session-routing/matcher.ts";
import fixtures from "./fixtures/session.json";

const parse = (body: string): Json => JSON.parse(body) as Json;

interface Step {
  readonly op: string;
  readonly format?: string;
  readonly body?: string;
  readonly auth?: string;
  readonly namespace?: string;
  readonly ms?: number;
  readonly generationOf: number;
}

describe("canonical turns and fingerprints (Go parity)", () => {
  for (const entry of fixtures.canonical) {
    it(entry.name, () => {
      const turns = extractCanonicalTurns(entry.format, parse(entry.body));
      const prepared = prepareFingerprints(turns);
      expect(turns.map((turn) => turn.role)).toEqual(entry.roles ?? []);
      expect(prepared.fingerprints).toEqual(entry.fingerprints ?? []);
      expect(prepared.minPrefixLength).toBe(entry.minPrefixLength);
      expect(prepared.tailFingerprints).toEqual(entry.tailFingerprints ?? []);
      expect(prepared.envDigest).toBe(entry.envDigest);
    });
  }
});

describe("derived identity and message hash (Go parity)", () => {
  fixtures.derive.forEach((entry, index) => {
    it(`${index}: ${entry.name} [${entry.callerScope || "no scope"}${entry.headers === undefined ? "" : ` ${JSON.stringify(entry.headers)}`}]`, () => {
      const headers = new Headers(entry.headers ?? {});
      const body = parse(entry.body);

      const derived = hasExplicitSession(headers, body)
        ? ""
        : deriveId(entry.format, body, entry.callerScope);

      expect(derived).toBe(entry.derived);

      // Go's ExtractSessionID falls back to the message hash only without an explicit identity.
      if (extractSessionInfo(new Headers(), body) === undefined) {
        expect(messageHashIds(body).primary).toBe(entry.messageHash);
      }
    });
  });

  it("the fallback hash of a conversation with an assistant turn is the primary hash of its opening", () => {
    const opening = {
      messages: [
        { role: "system", content: "s" },
        { role: "user", content: "hello" },
      ],
    };

    const full = { messages: [...opening.messages, { role: "assistant", content: "hi" }] };
    const hashes = messageHashIds(full);
    expect(hashes.fallback).toBe(messageHashIds(opening).primary);
    expect(hashes.primary).not.toBe(hashes.fallback);
  });
});

describe("identity helpers (Go parity)", () => {
  for (const entry of fixtures.identity) {
    it(`bound/uuid of ${JSON.stringify(entry.input.slice(0, 24))}`, () => {
      expect(boundSessionIdentity(entry.input)).toBe(entry.bound);
      expect(normalizeToCanonicalUuid(entry.input)).toBe(entry.uuid);
      expect(normalizeToCanonicalUuid(entry.uuid)).toBe(entry.uuid);
    });
  }
});

describe("LCP matcher scenarios (Go parity)", () => {
  for (const scenario of fixtures.scenarios) {
    it(scenario.name, () => {
      const matcher = new MerklePrefixMatcher({
        ttlMs: 3_600_000,
        ...(scenario.config.maxGroups === undefined
          ? {}
          : { maxGroups: scenario.config.maxGroups }),
        ...(scenario.config.maxPrefixes === undefined
          ? {}
          : { maxPrefixes: scenario.config.maxPrefixes }),
        ...(scenario.config.maxTurns === undefined ? {} : { maxTurns: scenario.config.maxTurns }),
      });

      let now = 1_700_000_000_000;
      const results: Array<Record<string, unknown>> = [];
      const steps = scenario.steps as Step[];
      steps.forEach((step, index) => {
        const expected = scenario.results[index] as Record<string, unknown>;

        const prepared = prepareFingerprints(
          step.body === undefined
            ? []
            : extractCanonicalTurns(step.format ?? "openai", parse(step.body)),
        );

        const namespace = step.namespace ?? "";
        const auth = step.auth ?? "";
        let actual: JsonObject = { ok: true };

        switch (step.op) {
          case "advance":
            now += step.ms ?? 0;
            break;
          case "bind": {
            const result = matcher.bind(namespace, prepared, auth, now);
            actual =
              result === undefined
                ? { ok: false }
                : {
                    ok: true,
                    sessionId: result.sessionId,
                    ...(result.parentSessionId === ""
                      ? {}
                      : { parentSessionId: result.parentSessionId }),
                    ...(result.isFork ? { isFork: true } : {}),
                    ...(result.isCompaction ? { isCompaction: true } : {}),
                    ...(result.nodeKind === "" ? {} : { nodeKind: result.nodeKind }),
                    accessNumber: result.accessNumber,
                  };
            break;
          }

          case "match": {
            const result = matcher.match(namespace, prepared, now);
            actual =
              result === undefined
                ? { ok: false }
                : {
                    ok: true,
                    ...(result.authId === "" ? {} : { authId: result.authId }),
                    sessionId: result.sessionId,
                    ...(result.parentSessionId === ""
                      ? {}
                      : { parentSessionId: result.parentSessionId }),
                    ...(result.prefixLength === 0 ? {} : { prefixLength: result.prefixLength }),
                    ...(result.isFork ? { isFork: true } : {}),
                    ...(result.isCompaction ? { isCompaction: true } : {}),
                    ...(result.nodeKind === "" ? {} : { nodeKind: result.nodeKind }),
                    accessNumber: result.accessNumber,
                  };
            break;
          }

          case "touch":
            actual = { ok: matcher.touch(namespace, prepared, auth, now) };
            break;
          case "remove": {
            const generation =
              step.generationOf >= 0
                ? ((results[step.generationOf]?.["accessNumber"] as number) ?? 0)
                : 0;

            actual = {
              ok: matcher.removeBefore(namespace, prepared.fingerprints, auth, generation, now),
            };
            break;
          }

          case "invalidate":
            matcher.invalidateAuth(auth);
            break;
          case "lookup": {
            const found = matcher.match(namespace, prepared, now);

            const looked =
              found === undefined ? undefined : matcher.lookupSession(found.sessionId, now);

            actual =
              found === undefined
                ? { ok: false }
                : {
                    ok: looked !== undefined,
                    sessionId: found.sessionId,
                    ...(looked === undefined ? {} : { auths: looked.authIds }),
                  };
            break;
          }

          default:
            throw new Error(`unknown op ${step.op}`);
        }

        results.push(actual);
        expect(actual, `step ${index} (${step.op})`).toEqual(expected);
      });
    });
  }
});

describe("derived Antigravity session ids (Go parity)", () => {
  for (const entry of fixtures.antigravitySessions) {
    it(`derived ${JSON.stringify(entry.derived)}`, () => {
      expect(derivedAntigravitySessionId(entry.derived)).toBe(entry.id);
    });
  }
});
