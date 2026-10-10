/**
 * Per-request trace state, the `X-CPA-TRACE-ID` response header and the structured request log.
 *
 * Go source: internal/logging/cpa_trace.go (CPATraceIDMiddleware, FormatCPATraceID), internal/logging/gin_logger.go
 * (GinLogrusLogger: request id per AI API request, one log line per request), internal/logging/requestid.go.
 *
 * The trace id of Go is `<selection time yyyyMMddHHmmss>-<auth index>-<request id>`, refreshed whenever a credential
 * is selected, and written to the response headers right before they are committed. The auth index is the same
 * stable hash the management API shows (`management/auth-index.ts`), so the header never reveals the credential.
 *
 * Deviation: requests that never selected a credential (validation errors, unknown models, ...) answer with the bare
 * request id instead of no header, so every proxied response can be correlated with the logs.
 */
import { Clock, Context, Effect, Exit } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { authIndexOf } from "../management/auth-index.ts";

export const CPA_TRACE_ID_HEADER = "X-CPA-TRACE-ID";

/** Mutable state of one inbound request, written by the pipeline and read by the middleware. */
export interface RequestTraceState {
  /** Inbound request id (also the usage `trace_id`). */
  readonly requestId: string;
  /** Latest `X-CPA-TRACE-ID` value (set once a credential was selected). */
  traceId: string | undefined;
  /** Access principal id (`user:<email>` / `service:<id>`), set by the pipeline. */
  principal: string | undefined;
  /** Stable index of the last selected credential. */
  authIndex: string | undefined;
  /** Number of upstream attempts started. */
  attempts: number;
  provider: string | undefined;
  model: string | undefined;
}

/** The trace of the current request; `undefined` outside the Worker's router (tests, scheduled jobs). */
export const RequestTrace = Context.Reference<RequestTraceState | undefined>(
  "cliproxy/observability/RequestTrace",
  {
    defaultValue: () => undefined,
  },
);

export const newTraceState = (): RequestTraceState => ({
  requestId: crypto.randomUUID(),
  traceId: undefined,
  principal: undefined,
  authIndex: undefined,
  attempts: 0,
  provider: undefined,
  model: undefined,
});

const pad = (value: number): string => String(value).padStart(2, "0");

/** `FormatCPATraceID`: `yyyyMMddHHmmss-<auth index>-<request id>` (UTC). */
export const formatTraceId = (selectedAt: number, authIndex: string, requestId: string): string => {
  if (authIndex === "" || requestId === "") return "";
  const date = new Date(selectedAt);

  const stamp =
    String(date.getUTCFullYear()) +
    pad(date.getUTCMonth() + 1) +
    pad(date.getUTCDate()) +
    pad(date.getUTCHours()) +
    pad(date.getUTCMinutes()) +
    pad(date.getUTCSeconds());

  return `${stamp}-${authIndex}-${requestId}`;
};

/** Records a credential selection on the request's trace (no-op outside the router). */
export const noteSelection = (credentialId: string, provider: string, model: string) =>
  Effect.gen(function* () {
    const trace = yield* RequestTrace;

    if (trace === undefined) return;
    const authIndex = authIndexOf(credentialId);
    trace.authIndex = authIndex;
    trace.attempts += 1;
    trace.provider = provider;
    trace.model = model;
    trace.traceId = formatTraceId(yield* Clock.currentTimeMillis, authIndex, trace.requestId);
  });

/** Annotates the request's trace with the caller (no-op outside the router). */
export const notePrincipal = (principalId: string) =>
  Effect.gen(function* () {
    const trace = yield* RequestTrace;

    if (trace !== undefined && principalId !== "") trace.principal = principalId;
  });

const logFields = (
  trace: RequestTraceState,
  method: string,
  path: string,
  status: number,
  latencyMs: number,
): Record<string, unknown> => ({
  requestId: trace.requestId,
  method,
  path,
  ...(status > 0 ? { status } : {}),
  latencyMs,
  ...(trace.principal === undefined ? {} : { principal: trace.principal }),
  ...(trace.provider === undefined ? {} : { provider: trace.provider }),
  ...(trace.model === undefined ? {} : { model: trace.model }),
  ...(trace.authIndex === undefined ? {} : { authIndex: trace.authIndex }),
  ...(trace.attempts === 0 ? {} : { attempts: trace.attempts }),
});

const logRequest = (fields: Record<string, unknown>, status: number) => {
  const log = status >= 500 ? Effect.logError : status >= 400 ? Effect.logWarning : Effect.logInfo;

  return log("request").pipe(Effect.annotateLogs(fields));
};

/**
 * Global middleware: gives every request a trace state, sets `X-CPA-TRACE-ID` on the response and logs one structured
 * line per request (method, pathname, status, latency, caller and credential index; never query strings, headers or
 * bodies). The pipeline fills in the caller and credential. Unmatched routes fail inside the router (the CORS layer
 * turns them into 404s further out), so those requests are logged as failures without a status.
 */
export const TraceLayer = HttpRouter.middleware()(
  (app) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const trace = newTraceState();
      const startedAt = yield* Clock.currentTimeMillis;
      const exit = yield* Effect.exit(Effect.provideService(app, RequestTrace, trace));
      const latencyMs = Math.max(0, (yield* Clock.currentTimeMillis) - startedAt);
      const path = new URL(request.originalUrl, "http://localhost").pathname;
      // Like Go, health probes are not logged.
      const quiet = path === "/healthz";

      if (Exit.isFailure(exit)) {
        if (!quiet)
          yield* logRequest(
            { ...logFields(trace, request.method, path, 0, latencyMs), failed: true },
            400,
          );

        return yield* exit;
      }

      const response = exit.value;

      if (!quiet)
        yield* logRequest(
          logFields(trace, request.method, path, response.status, latencyMs),
          response.status,
        );

      return quiet
        ? response
        : HttpServerResponse.setHeader(
            response,
            CPA_TRACE_ID_HEADER,
            trace.traceId ?? trace.requestId,
          );
    }),
  { global: true },
);
