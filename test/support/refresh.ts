// Test helpers for token refresh: a recording HttpClient (no network), an in-memory credential store behind a real
// CredentialPool, and an alarm recorder.
import { Effect, Layer } from "effect";
import {
  HttpClient,
  HttpClientError,
  HttpClientResponse,
  type HttpClientRequest,
} from "effect/http";
import type { Config } from "../../src/config/schema.ts";
import { decodeStoredConfig } from "../../src/config/store.ts";
import type { JsonObject } from "../../src/json/index.ts";
import type { StoredCredential } from "../../src/credentials/derive.ts";
import { mergeExistingMetadata, credentialsChanged } from "../../src/credentials/merge.ts";
import type { CredentialState } from "../../src/credentials/model.ts";
import { CredentialPool, type PoolStore } from "../../src/credentials/pool.ts";
import {
  RefreshManager,
  type AlarmScheduler,
  type RefreshManagerOptions,
} from "../../src/credentials/refresh/index.ts";
import type { UpsertOptions, UpsertOutcome } from "../../src/credentials/store.ts";

export interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  /** Body parsed as JSON, or as form fields for urlencoded bodies. */
  readonly json: () => Record<string, unknown>;
  readonly form: () => Record<string, string>;
}

export interface MockReply {
  readonly status?: number;
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
  /** Fail like a network error (connection reset) instead of answering. */
  readonly transportError?: boolean;
}

export type MockHandler = (request: RecordedRequest) => MockReply | Promise<MockReply>;

const decode = (request: HttpClientRequest.HttpClientRequest): string => {
  const body = request.body;

  if (body._tag === "Uint8Array") return new TextDecoder().decode(body.body);

  return "";
};

/** An `HttpClient` that answers from `handler` and records every request. */
export const mockHttp = (handler: MockHandler) => {
  const requests: RecordedRequest[] = [];

  const layer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.flatMap(
        Effect.promise(async () => {
          const body = decode(request);

          const recorded: RecordedRequest = {
            method: request.method,
            url: request.url,
            headers: { ...request.headers },
            body,
            json: () => JSON.parse(body) as Record<string, unknown>,
            form: () => Object.fromEntries(new URLSearchParams(body)),
          };

          requests.push(recorded);

          return handler(recorded);
        }),
        (reply) => {
          if (reply.transportError === true) {
            return Effect.fail(
              new HttpClientError.HttpClientError({
                reason: new HttpClientError.TransportError({ request }),
              }),
            );
          }

          const text =
            typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body ?? {});

          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(text, { status: reply.status ?? 200, headers: reply.headers ?? {} }),
            ),
          );
        },
      ),
    ),
  );

  return { layer, requests };
};

/** Handler that routes by `"<METHOD> <url>"` and fails the test on unexpected calls. */
export const routes =
  (table: Record<string, MockHandler | MockReply>): MockHandler =>
  (request) => {
    const entry = table[`${request.method} ${request.url}`];

    if (entry === undefined) throw new Error(`unexpected request ${request.method} ${request.url}`);

    return typeof entry === "function" ? entry(request) : entry;
  };

/** In-memory `PoolStore`. */
export class MemoryStore implements PoolStore {
  readonly files = new Map<string, StoredCredential>();
  readonly states = new Map<string, CredentialState>();
  writes = 0;
  constructor(private readonly now: () => number = () => 0) {}

  list(): StoredCredential[] {
    return [...this.files.values()].toSorted((a, b) => (a.id < b.id ? -1 : 1));
  }
  get(id: string): StoredCredential | undefined {
    return this.files.get(id);
  }
  upsert(
    id: string,
    provider: string,
    incoming: JsonObject,
    options: UpsertOptions,
  ): UpsertOutcome {
    const existing = this.files.get(id);

    const metadata =
      existing !== undefined && options.mergeExisting
        ? mergeExistingMetadata(provider, incoming, existing.metadata)
        : structuredClone(incoming);

    const changed = existing === undefined ? true : credentialsChanged(existing.metadata, metadata);

    const record: StoredCredential = {
      id,
      provider,
      metadata,
      credentialVersion:
        existing === undefined ? 1 : existing.credentialVersion + (changed ? 1 : 0),
      createdAt: existing?.createdAt ?? this.now(),
      updatedAt: this.now(),
    };

    this.files.set(id, record);
    this.writes += 1;

    return { record, created: existing === undefined, credentialsChanged: changed };
  }
  setDisabled(id: string, disabled: boolean): StoredCredential | undefined {
    const existing = this.files.get(id);

    if (existing === undefined) return undefined;
    const record = { ...existing, metadata: { ...existing.metadata, disabled } };
    this.files.set(id, record);

    return record;
  }
  remove(id: string): boolean {
    return this.files.delete(id);
  }
  loadStates(): Map<string, CredentialState> {
    return new Map(this.states);
  }
  saveState(id: string, state: CredentialState): void {
    this.states.set(id, state);
  }
  deleteState(id: string): void {
    this.states.delete(id);
  }
}

export class FakeAlarm implements AlarmScheduler {
  at: number | undefined;
  sets: number[] = [];
  set(at: number): Promise<void> {
    this.at = at;
    this.sets.push(at);

    return Promise.resolve();
  }
  clear(): Promise<void> {
    this.at = undefined;

    return Promise.resolve();
  }
}

export const EMPTY_CONFIG: Config = Effect.runSync(decodeStoredConfig("{}"));

export interface Fixture {
  readonly clock: { now: number };
  readonly store: MemoryStore;
  readonly pool: CredentialPool;
  readonly alarm: FakeAlarm;
  readonly manager: RefreshManager;
  readonly http: ReturnType<typeof mockHttp>;
  /** Imports an auth file through the pool (like the RPC does). */
  readonly add: (name: string, metadata: JsonObject) => void;
}

export const T0 = 1_800_000_000_000;

export const makeFixture = (
  handler: MockHandler,
  options: Partial<Pick<RefreshManagerOptions, "workers" | "timeoutMs">> & {
    readonly start?: number;
  } = {},
): Fixture => {
  const clock = { now: options.start ?? T0 };
  const store = new MemoryStore(() => clock.now);
  const http = mockHttp(handler);
  const alarm = new FakeAlarm();
  let manager: RefreshManager | undefined;

  const pool = new CredentialPool({
    store,
    config: () => ({ version: 1, config: EMPTY_CONFIG }),
    now: () => clock.now,
    decorate: (credential) => manager?.decorate(credential) ?? credential,
  });

  manager = new RefreshManager({
    host: pool,
    alarm,
    http: http.layer,
    now: () => clock.now,
    retryDelayMs: () => 0,
    ...(options.workers === undefined ? {} : { workers: options.workers }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });

  return {
    clock,
    store,
    pool,
    alarm,
    manager,
    http,
    add: (name, metadata) => {
      const result = pool.upsert(name, metadata, { mergeExisting: false });

      if (!result.ok) throw new Error(`import failed: ${result.message}`);
    },
  };
};

/** Unsigned JWT with the given claims (tests only read claims). */
const b64 = (value: unknown) =>
  btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export const jwt = (claims: Record<string, unknown>): string =>
  `${b64({ alg: "none" })}.${b64(claims)}.sig`;
