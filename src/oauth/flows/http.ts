/** HTTP helpers shared by the login flows (thin layer over the refresh protocols' `HttpClient` plumbing). */
import { Effect } from "effect";
import { HttpClient, type HttpClientRequest } from "effect/http";
import { type HttpReply, send } from "../../credentials/refresh/http.ts";
import { flowFailure, type FlowFailure } from "./types.ts";

export {
  clipBody,
  parseJsonObject,
  rfc3339,
  seconds,
  str,
} from "../../credentials/refresh/http.ts";

export type { HttpReply } from "../../credentials/refresh/http.ts";

/**
 * Executes a request; a transport failure or timeout fails with `message` (or the transport error text when omitted,
 * which never includes URLs or bodies).
 */
export const call = (
  request: HttpClientRequest.HttpClientRequest,
  message?: string,
): Effect.Effect<HttpReply, FlowFailure, HttpClient.HttpClient> =>
  send(request).pipe(Effect.mapError((error) => flowFailure(message ?? error.message)));

/** Like {@link call} but a transport failure becomes `undefined` (polls keep waiting through network blips). */
export const tryCall = (
  request: HttpClientRequest.HttpClientRequest,
): Effect.Effect<HttpReply | undefined, never, HttpClient.HttpClient> =>
  send(request).pipe(Effect.catch(() => Effect.succeed(undefined)));

/** Removes known secret values from an upstream error text before it reaches a session status. */
export const scrub = (text: string, secrets: ReadonlyArray<string>): string =>
  secrets.reduce(
    (acc, secret) => (secret.length >= 4 ? acc.split(secret).join("[redacted]") : acc),
    text,
  );

/** Like {@link tryCall} for binary answers (protobuf): status and raw bytes, `undefined` on any failure. */
export const tryCallBytes = (
  request: HttpClientRequest.HttpClientRequest,
): Effect.Effect<
  { readonly status: number; readonly bytes: Uint8Array } | undefined,
  never,
  HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(request);
    const buffer = yield* response.arrayBuffer;

    return { status: response.status, bytes: new Uint8Array(buffer) };
  }).pipe(
    Effect.timeoutOrElse({ duration: "30 seconds", orElse: () => Effect.succeed(undefined) }),
    Effect.catch(() => Effect.succeed(undefined)),
  );
