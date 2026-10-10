/**
 * Upstream HTTP for the xAI executor: one request, status classification and transport failures.
 *
 * Go source: the `httpClient.Do` + status check blocks of internal/runtime/executor/xai_executor_*.go. Error bodies
 * are read in full and classified by the caller-supplied function (`xaiStatusErr` / `xaiSpeechStatusErr`).
 */
import { Clock, Effect } from "effect";
import {
  HttpClient,
  type HttpClientError,
  HttpClientRequest,
  type HttpClientResponse,
} from "effect/http";
import { ExecutionError, headersRecord } from "../errors.ts";
import type { ExecutionContext } from "../types.ts";

/** `fetch` failures carry no HTTP answer: the conductor treats them as transient transport errors (no cooldown). */
export const transportError = (error: HttpClientError.HttpClientError) =>
  new ExecutionError({
    status: 500,
    code: "transient_transport",
    message: `upstream request failed: ${error.reason._tag}`,
    cause: error,
  });

export interface UpstreamRequest {
  readonly method: "GET" | "POST";
  readonly url: string;
  readonly headers: Record<string, string>;
  /** JSON text; omitted for GET. */
  readonly body?: string;
  /** Streams record the effective TTFT on the first token event (`observeTokenEvent`), not on the headers. */
  readonly ttft?: "first-byte" | "token-event";
  readonly classify: (
    status: number,
    body: string,
    headers: Record<string, string>,
  ) => ExecutionError;
}

/** Sends the request; non-2xx answers become classified `ExecutionError`s (usage is marked failed). */
export const sendUpstream = Effect.fnUntraced(function* (
  context: ExecutionContext,
  request: UpstreamRequest,
) {
  const client = yield* HttpClient.HttpClient;
  const base =
    request.method === "GET"
      ? HttpClientRequest.get(request.url)
      : HttpClientRequest.post(request.url);

  const httpRequest = (
    request.body === undefined
      ? base
      : HttpClientRequest.bodyText(base, request.body, "application/json")
  ).pipe(HttpClientRequest.setHeaders(request.headers));

  const response: HttpClientResponse.HttpClientResponse = yield* client
    .execute(httpRequest)
    .pipe(
      Effect.provideService(HttpClient.TracerPropagationEnabled, false),
      Effect.mapError(transportError),
    );

  if (request.ttft === "token-event")
    context.usage.recordFirstPacket(yield* Clock.currentTimeMillis);
  else context.usage.markFirstByte(yield* Clock.currentTimeMillis);

  if (response.status < 200 || response.status >= 300) {
    const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
    const error = request.classify(
      response.status,
      text,
      headersRecord(new Headers(response.headers)),
    );
    context.usage.fail(error.status, error.message);

    return yield* error;
  }

  return response;
});
