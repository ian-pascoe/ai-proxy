// Helpers to run provider executors directly against a mocked upstream HttpClient.
import { Effect, Layer, Predicate, Result, Stream } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { parseConfigYaml } from "../../src/config/codec.ts";
import type { Config } from "../../src/config/schema.ts";
import { ExecutionError } from "../../src/executor/errors.ts";
import type { CredentialSnapshot } from "../../src/executor/picker.ts";
import { Thinking } from "../../src/executor/thinking.ts";
import type {
  ExecutionContext,
  ExecutorOptions,
  ExecutorRequest,
  ExecutorResponse,
  ProviderExecutor,
  StreamResult,
} from "../../src/executor/types.ts";
import type { Json } from "../../src/json/index.ts";
import { UsageReporter } from "../../src/usage/reporter.ts";

export interface RecordedCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly bytes: Uint8Array;
  readonly text: string;
}

export type Responder = (call: RecordedCall) => Response | Promise<Response>;

/** HttpClient that records every request (raw body bytes included) and answers with `respond`. */
export const recordingClient = (
  calls: RecordedCall[],
  respond: Responder,
): Layer.Layer<HttpClient.HttpClient> =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request, url) =>
      Effect.promise(async () => {
        const bytes = Predicate.isTagged(request.body, "Uint8Array")
          ? request.body.body
          : new Uint8Array(0);

        const call: RecordedCall = {
          url: url.toString(),
          method: request.method,
          headers: { ...request.headers },
          bytes,
          text: new TextDecoder().decode(bytes),
        };

        calls.push(call);

        return HttpClientResponse.fromWeb(request, await respond(call));
      }),
    ),
  );

export const newUsage = (provider: string, stream = false): UsageReporter =>
  new UsageReporter({
    requestId: "req",
    provider,
    executorType: provider,
    model: "m",
    alias: "m",
    endpoint: "POST /v1/test",
    principalId: "user:test",
    authId: "a",
    authType: "oauth",
    source: "s",
    stream,
    serviceTier: "auto",
    requestedAt: 0,
  });

export const loadConfig = (yaml = "requests: {}"): Promise<Config> =>
  Effect.runPromise(parseConfigYaml(yaml));

export const options = (overrides: Partial<ExecutorOptions> = {}): ExecutorOptions => ({
  stream: false,
  alt: "",
  headers: new Headers(),
  query: new URLSearchParams(),
  originalRequest: undefined,
  sourceFormat: "openai",
  metadata: {
    requestPath: "/v1/chat/completions",
    requestedModel: "",
    serviceTier: "auto",
    generate: true,
    callerScope: "scope",
  },
  ...overrides,
});

export interface Harness {
  readonly calls: RecordedCall[];
  readonly usage: UsageReporter;
  readonly context: ExecutionContext;
  readonly layers: Layer.Layer<HttpClient.HttpClient | Thinking>;
}

export const harness = async (
  credential: CredentialSnapshot,
  respond: Responder,
  yaml?: string,
  stream = false,
): Promise<Harness> => {
  const calls: RecordedCall[] = [];
  const usage = newUsage(credential.provider, stream);
  const config = await loadConfig(yaml);

  return {
    calls,
    usage,
    context: { credential, config, usage },
    layers: Layer.mergeAll(recordingClient(calls, respond), Thinking.live),
  };
};

export const run = <A, E, R>(effect: Effect.Effect<A, E, R>, layers: Layer.Layer<R>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(layers)));

export const runFail = async <A>(
  effect: Effect.Effect<A, ExecutionError, HttpClient.HttpClient | Thinking>,
  layers: Layer.Layer<HttpClient.HttpClient | Thinking>,
): Promise<ExecutionError> => {
  const result = await Effect.runPromise(Effect.result(effect.pipe(Effect.provide(layers))));

  if (Result.isSuccess(result)) throw new Error("expected a failure");

  return result.failure;
};

export const execute = (
  executor: ProviderExecutor,
  h: Harness,
  request: ExecutorRequest,
  opts: ExecutorOptions,
): Promise<ExecutorResponse> =>
  Effect.runPromise(executor.execute(h.context, request, opts).pipe(Effect.provide(h.layers)));

export interface Collected {
  readonly chunks: string[];
  readonly error?: ExecutionError;
  readonly result?: StreamResult;
}

/** Starts a stream and drains it; a failing start (bootstrap) is reported as `error` with no chunks. */
export const collectStream = async (
  executor: ProviderExecutor,
  h: Harness,
  request: ExecutorRequest,
  opts: ExecutorOptions,
): Promise<Collected> => {
  const started = await Effect.runPromise(
    Effect.result(executor.executeStream(h.context, request, opts).pipe(Effect.provide(h.layers))),
  );

  if (Result.isFailure(started)) return { chunks: [], error: started.failure };
  const chunks: string[] = [];

  const drained = await Effect.runPromise(
    Effect.result(
      Stream.runForEach(started.success.chunks, (chunk) =>
        Effect.sync(() => void chunks.push(chunk)),
      ),
    ),
  );

  return Result.isFailure(drained)
    ? { chunks, error: drained.failure, result: started.success }
    : { chunks, result: started.success };
};

export const credential = (
  provider: string,
  overrides: Partial<CredentialSnapshot> = {},
): CredentialSnapshot => ({
  id: `${provider}-1`,
  provider,
  kind: "oauth",
  label: "test",
  attributes: {},
  metadata: {},
  ...overrides,
});

export const json = (value: Json): Json => value;
