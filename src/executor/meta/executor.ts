/**
 * Meta (Muse, `api.meta.ai`) executor: OpenAI Responses over SSE.
 *
 * Go source: internal/runtime/executor/meta_executor.go, meta_executor_execute.go (Execute, `translateMetaCompleted`,
 * `applyMetaAPIHeaders`, `wrapMetaUpstreamError`, `metaAsCompletedEvent`), meta_executor_stream.go (ExecuteStream).
 * The upstream always streams (non-stream callers get the aggregated terminal event). The lazy DCA -> API-key mint is
 * done by the conductor through `ControlPlane.ensureFresh` before the attempt (`withCredentialRefresh`).
 *
 * `CountTokens` counts the prepared body locally with `o200k_base`. The apply_patch Responses bridge wraps the event
 * flow (`helps/apply-patch-responses.ts`). Not ported: outbound proxies.
 */
import { Clock, Effect, Stream } from "effect";
import { HttpClient, type HttpClientError, HttpClientRequest } from "effect/http";
import { splitLines } from "../../http/sse.ts";
import {
  asString,
  cloneJson,
  get,
  isJsonObject,
  type JsonObject,
  tryParseJson,
} from "../../json/index.ts";
import { builtinTranslators } from "../../translator/builtin.ts";
import { Formats } from "../../translator/formats.ts";
import {
  makeTranslationState,
  type ResponseContext,
  type TranslatorRegistry,
} from "../../translator/registry.ts";
import { responseModelOf } from "../../usage/record.ts";
import {
  ensureResponsesUsageDetails,
  OutputItemCollector,
  parseCodexUsage,
  patchCodexCompletedOutput,
} from "../codex/output.ts";
import { ExecutionError } from "../errors.ts";
import { APPLY_PATCH_UPSTREAM_ERROR_MESSAGE } from "../helps/apply-patch-responses.ts";
import { applyCustomHeaders } from "../helps/custom-headers.ts";
import { TOOL_INPUT_ERROR_MESSAGE } from "../openai-compat/stream.ts";
import type { CredentialSnapshot } from "../picker.ts";
import type {
  ExecutionContext,
  ExecutorOptions,
  ExecutorRequest,
  ExecutorResponse,
  ProviderExecutor,
  StreamResult,
} from "../types.ts";
import { META_CLIENT_ID, META_USER_AGENT, requireMetaToken } from "./credentials.ts";
import { metaStreamEventError, wrapMetaUpstreamError } from "./errors.ts";
import { buildResponsesUsageJson, countCodexInputTokens } from "../helps/token-count.ts";
import { getCodec } from "../../tokenizer/index.ts";
import { type MetaPrepared, prepareMetaRequest } from "./request.ts";

interface StepResult {
  readonly chunks: ReadonlyArray<string>;
  readonly error?: ExecutionError;
}

export const META_PROVIDER = "meta";

const STREAM_STALL =
  "meta stream error: stream disconnected before response.completed or response.incomplete";

export interface MetaExecutorOptions {
  readonly translators?: TranslatorRegistry;
}

const transportError = (error: HttpClientError.HttpClientError) =>
  new ExecutionError({
    status: 500,
    code: "transient_transport",
    message: `upstream request failed: ${error.reason._tag}`,
    cause: error,
  });

/** `applyMetaAPIHeaders`. */
export const metaHeaders = (
  credential: CredentialSnapshot,
  token: string,
  stream: boolean,
  clientHeaders: Headers,
  sessionId: string | undefined,
): Record<string, string> => {
  const headers: Record<string, string> = {};
  headers["content-type"] = "application/json";
  headers["authorization"] = `Bearer ${token}`;
  headers["user-agent"] = META_USER_AGENT;
  headers["x-client-id"] = META_CLIENT_ID;
  headers["accept"] = stream ? "text/event-stream" : "application/json";

  if (stream) headers["cache-control"] = "no-cache";

  return applyCustomHeaders(headers, credential, clientHeaders, sessionId);
};

/** `metaAsCompletedEvent`: a plain JSON response body is wrapped as a `response.completed` event. */
const asCompletedEvent = (data: string): JsonObject | undefined => {
  const root = tryParseJson(data.trim());

  if (!isJsonObject(root)) return undefined;
  const type = asString(root["type"]);

  if (type === "response.completed" || type === "response.incomplete") return root;

  if (asString(root["object"]) === "response" || root["output"] !== undefined) {
    return { type: "response.completed", response: root };
  }

  return undefined;
};

export const makeMetaExecutor = (executorOptions: MetaExecutorOptions = {}): ProviderExecutor => {
  const registry = executorOptions.translators ?? builtinTranslators;

  const responseContext = (
    prepared: MetaPrepared,
    request: ExecutorRequest,
    options: ExecutorOptions,
  ): ResponseContext => ({
    model: request.model,
    originalRequest: options.originalRequest ?? request.payload,
    translatedRequest: prepared.translated,
    state: makeTranslationState(),
  });

  const unsupported = (options: ExecutorOptions) =>
    options.alt === "responses/compact"
      ? Effect.fail(
          new ExecutionError({
            status: 501,
            message: "/responses/compact not supported",
            requestScoped: true,
          }),
        )
      : Effect.void;

  /** Prepares the body and sends it; non-2xx answers are wrapped with the Meta cooldown rules. */
  const send = Effect.fnUntraced(function* (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions,
  ) {
    yield* unsupported(options);

    const creds = yield* Effect.try({
      try: () => requireMetaToken(context.credential),
      catch: (error) =>
        error instanceof ExecutionError
          ? error
          : new ExecutionError({ status: 500, message: String(error) }),
    });

    const prepared = yield* prepareMetaRequest(registry, context, request, options, META_PROVIDER);
    const effort = asString(get(prepared.body, "reasoning.effort"));
    context.usage.setReasoningEffort(effort !== "" ? effort : undefined);
    const client = yield* HttpClient.HttpClient;
    const url = `${creds.baseUrl.replace(/\/+$/, "")}/responses`;

    const httpRequest = HttpClientRequest.post(url).pipe(
      HttpClientRequest.bodyText(JSON.stringify(prepared.body), "application/json"),
      HttpClientRequest.setHeaders(
        metaHeaders(
          context.credential,
          creds.token,
          true,
          options.headers,
          options.metadata.sessionId,
        ),
      ),
    );

    const response = yield* client
      .execute(httpRequest)
      .pipe(
        Effect.provideService(HttpClient.TracerPropagationEnabled, false),
        Effect.mapError(transportError),
      );

    context.usage.markFirstByte(yield* Clock.currentTimeMillis);

    if (response.status < 200 || response.status >= 300) {
      const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
      context.usage.fail(response.status, text);

      return yield* wrapMetaUpstreamError(response.status, text, yield* Clock.currentTimeMillis);
    }

    return { response, prepared };
  });

  const execute = Effect.fnUntraced(function* (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions,
  ) {
    const { response, prepared } = yield* send(context, request, options);
    const data = yield* response.text.pipe(Effect.mapError(transportError));
    context.usage.observeResponseModel(responseModelOf(tryParseJson(data)));
    const collector = new OutputItemCollector();
    const nowMs = yield* Clock.currentTimeMillis;

    const gatewayError = () =>
      new ExecutionError({ status: 502, message: APPLY_PATCH_UPSTREAM_ERROR_MESSAGE });

    let completed: JsonObject | undefined;

    for (const line of data.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      const parsed = tryParseJson(payload);
      const failure = metaStreamEventError(parsed, payload, nowMs);

      if (failure !== undefined) {
        context.usage.fail(failure.status, failure.message);

        return yield* failure;
      }

      if (parsed === undefined) continue;
      const bridged = prepared.applyPatch.transform(parsed);

      if (bridged.error !== undefined) return yield* gatewayError();

      for (const event of bridged.events) {
        const type = asString(get(event, "type"));

        if (type === "response.output_item.done") collector.collect(event);
        else if (
          (type === "response.completed" || type === "response.incomplete") &&
          isJsonObject(event)
        ) {
          completed = event;
          break;
        }
      }

      if (completed !== undefined) break;
    }

    let event: JsonObject;

    if (completed === undefined) {
      const fallback = asCompletedEvent(data);

      if (fallback === undefined) {
        // `Finish`: an unvalidated apply_patch call is a gateway failure before the stall error.
        if (prepared.applyPatch.finish() !== undefined) return yield* gatewayError();
        const error = new ExecutionError({ status: 408, message: STREAM_STALL });
        context.usage.fail(error.status, error.message);

        return yield* error;
      }

      event = cloneJson(fallback);
      patchCodexCompletedOutput(event, collector);
      const bridged = prepared.applyPatch.bridge.transformNonStream(event);

      if ("error" in bridged || !isJsonObject(bridged.body)) return yield* gatewayError();
      event = bridged.body;
    } else {
      event = cloneJson(completed);

      if (isJsonObject(event)) patchCodexCompletedOutput(event, collector);
    }

    let out = registry.translateNonStream(
      prepared.responseFormat,
      Formats.Codex,
      responseContext(prepared, request, options),
      JSON.stringify(event),
    );

    if (out === undefined || out === "") {
      return yield* new ExecutionError({ status: 502, message: TOOL_INPUT_ERROR_MESSAGE });
    }

    const detail = parseCodexUsage(event);

    if (detail !== undefined) context.usage.publish(detail);

    if (prepared.responseFormat === Formats.OpenAIResponse) out = ensureResponsesUsageDetails(out);

    return { payload: out, headers: new Headers(response.headers) } satisfies ExecutorResponse;
  });

  const executeStream = Effect.fnUntraced(function* (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions,
  ) {
    const { response, prepared } = yield* send(context, request, options);
    const collector = new OutputItemCollector();
    const state = responseContext(prepared, request, options);

    const gatewayError = () =>
      new ExecutionError({ status: 502, message: APPLY_PATCH_UPSTREAM_ERROR_MESSAGE });

    const translate = (line: string): string[] => {
      const chunks = [
        ...registry.translateStream(prepared.responseFormat, Formats.Codex, state, line),
      ];

      return prepared.responseFormat === Formats.OpenAIResponse
        ? chunks.map((chunk) => ensureResponsesUsageDetails(chunk))
        : chunks;
    };

    /** `emitTranslatedLine`: the apply_patch bridge first, then the translator; a retained failure ends the stream. */
    const emit = (line: string): StepResult => {
      const bridged = prepared.applyPatch.stream(line);
      const chunks = bridged.lines.flatMap(translate);
      const failed = bridged.error !== undefined || state.state.toolInputError !== undefined;

      return { chunks, ...(failed ? { error: gatewayError() } : {}) };
    };

    let stopped = false;

    const lines = splitLines(response.stream).pipe(
      Stream.mapError(transportError),
      Stream.mapEffect((line) =>
        Effect.gen(function* () {
          if (stopped) return { chunks: [] };

          if (!line.startsWith("data:")) return emit(line);
          const payload = line.slice(5).trim();
          const event = tryParseJson(payload);
          context.usage.observeResponseModel(responseModelOf(event));
          const failure = metaStreamEventError(event, payload, yield* Clock.currentTimeMillis);

          if (failure !== undefined) return yield* failure;

          switch (asString(get(event, "type"))) {
            case "response.output_item.done":
              collector.collect(event);
              break;
            case "response.completed":
            case "response.incomplete": {
              if (!isJsonObject(event)) break;
              const detail = parseCodexUsage(event);

              if (detail !== undefined) context.usage.publish(detail);
              patchCodexCompletedOutput(event, collector);

              return emit(`data: ${JSON.stringify(event)}`);
            }
          }

          return emit(`data: ${payload}`);
        }),
      ),
      Stream.tap((step) =>
        Effect.sync(() => {
          if (step.error !== undefined) stopped = true;
        }),
      ),
    );

    // `FinishStream`: EOF without a validated completion emits the local failure once.
    const tail = Stream.suspend(() => {
      if (stopped) return Stream.empty;
      const finished = prepared.applyPatch.finishStream();
      const chunks = finished.lines.flatMap(translate);
      const emitted = Stream.fromIterable(chunks);

      return finished.error === undefined
        ? emitted
        : Stream.concat(emitted, Stream.fail(gatewayError()));
    });

    const chunks = Stream.concat(
      lines.pipe(
        Stream.takeUntil((step) => step.error !== undefined),
        Stream.flatMap((step) => {
          const emitted = Stream.fromIterable(step.chunks);

          return step.error === undefined
            ? emitted
            : Stream.concat(emitted, Stream.fail(step.error));
        }),
      ),
      tail,
    ).pipe(
      Stream.filter((chunk) => chunk.length > 0),
      Stream.tapError((error) =>
        Effect.sync(() => context.usage.fail(error.status, error.message)),
      ),
    );

    return { headers: new Headers(response.headers), chunks } satisfies StreamResult;
  });

  /** `CountTokens`: the Responses body that would be sent upstream, counted locally with `o200k_base`. */
  const countTokens: ProviderExecutor["countTokens"] = Effect.fnUntraced(function* (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions,
  ) {
    yield* Effect.try({
      try: () => requireMetaToken(context.credential),
      catch: (error) =>
        error instanceof ExecutionError
          ? error
          : new ExecutionError({ status: 500, message: String(error) }),
    });

    const prepared = yield* prepareMetaRequest(
      registry,
      context,
      request,
      options,
      META_PROVIDER,
      false,
    );

    const count = countCodexInputTokens(getCodec("o200k_base"), prepared.body);

    return {
      payload: registry.translateTokenCount(
        prepared.responseFormat,
        Formats.Codex,
        count,
        buildResponsesUsageJson(count),
      ),
      headers: new Headers(),
    } satisfies ExecutorResponse;
  });

  return { identifier: META_PROVIDER, execute, executeStream, countTokens };
};
