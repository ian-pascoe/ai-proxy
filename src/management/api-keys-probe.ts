/**
 * `POST /v8/management/api-keys/probe` (`contract/api-keys.ts` `ProbeResult`): one connection test of a config API key.
 *
 * Workers addition, no Go counterpart. The upstream panel tests keys from the browser through `POST /requests/api-call`
 * with the raw key (`useConnectivityTest.ts`, `models.ts`); here the ControlPlane hands the Worker a probe target
 * (`apiKeyProbeTarget`, like `quotaProbeTarget`) and the Worker makes the request itself, so the key never reaches the
 * browser and can only go to the key's own configured base host. The probe is a model listing (which doubles as model
 * discovery) or, for Vertex (no listing), a one-token `countTokens`. Per family:
 *
 * - gemini / interactions: `GET {base}/v1beta/models` (`x-goog-api-key`, paged by `nextPageToken`, at most 20 pages);
 * - claude: `GET {base}/v1/models` with `x-api-key` + `anthropic-version` on api.anthropic.com, Bearer elsewhere
 *   (and for OAuth tokens), as the executor authenticates;
 * - codex / xai / meta: `GET {base}/models` when the base ends with `/v1`, else `{base}/v1/models` (Bearer);
 * - openai-compatibility: `GET {base}/models` (Bearer);
 * - vertex: `POST {base}/v1/publishers/google/models/{first configured model}:countTokens` (`x-goog-api-key`).
 *
 * The call is not reported to the credential pool (no counters, no cooldown) and is bounded to 30 s in total. Failures
 * carry a fixed message and the upstream status only: response bodies are never copied (an upstream can echo a key).
 * Unverified against the live services: that Meta serves `/models` and that Vertex API-key mode accepts `countTokens`.
 */
import { Clock, Effect, Result } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import type { Credential } from "../credentials/model.ts";
import { isAnthropicUpstreamURL, isClaudeOAuthToken } from "../executor/claude/credentials.ts";
import { isJsonObject, type Json, tryParseJson } from "../json/index.ts";
import { DEFAULT_BASE_URLS } from "./api-keys-view.ts";
import type { ApiKeyFamily, ProbeResult } from "./contract/api-keys.ts";

/** What a probe needs from one config credential; carries the key, so it only crosses the RPC boundary to the Worker. */
export interface ApiKeyProbeTarget {
  readonly id: string;
  readonly family: ApiKeyFamily;
  /** Configured base URL, or the family's default. */
  readonly baseUrl: string;
  readonly apiKey: string;
  /** Configured headers except the `$name` ones (which copy a client header). */
  readonly headers: Readonly<Record<string, string>>;
  /** Names of the configured models (Vertex tests the first). */
  readonly models: ReadonlyArray<string>;
}

export type ApiKeyProbeTargetResult =
  | { readonly ok: true; readonly target: ApiKeyProbeTarget }
  | { readonly ok: false; readonly error: "not_found" };

const PROVIDER_FAMILIES = {
  gemini: "gemini",
  "gemini-interactions": "interactions",
  vertex: "vertex",
  codex: "codex",
  claude: "claude",
  xai: "xai",
  meta: "meta",
} as const satisfies Readonly<Record<string, ApiKeyFamily>>;

/** The probe target of a config credential; `undefined` for a credential of another provider. */
export const buildApiKeyProbeTarget = (
  credential: Pick<Credential, "id" | "provider" | "attributes" | "headers" | "models">,
): ApiKeyProbeTarget | undefined => {
  const compat = credential.attributes.compat_name !== undefined;

  const family: ApiKeyFamily | undefined = compat
    ? "openai-compatibility"
    : Object.entries(PROVIDER_FAMILIES).find(([provider]) => provider === credential.provider)?.[1];

  if (family === undefined) return undefined;
  const configured = (credential.attributes.base_url ?? "").trim();

  const base =
    configured === "" && family !== "openai-compatibility" ? DEFAULT_BASE_URLS[family] : configured;

  return {
    id: credential.id,
    family,
    baseUrl: base,
    apiKey: (credential.attributes.api_key ?? "").trim(),
    headers: Object.fromEntries(
      Object.entries(credential.headers).filter(([, value]) => !value.startsWith("$")),
    ),
    models: (credential.models ?? []).map((model) => model.name),
  };
};

const TIMEOUT = "30 seconds";

const MAX_PAGES = 20;

const MAX_MODELS = 1000;

const trimSlash = (value: string): string => value.replace(/\/+$/, "");

interface Exchange {
  readonly status: number;
  readonly body: Json | undefined;
}

type ProbedModel = { id: string; display_name?: string };

/** An answered probe request with the models its body listed. */
interface Probed extends Exchange {
  readonly models: ReadonlyArray<ProbedModel>;
}

/** A failed probe: a fixed message safe to show, and the upstream status when there was one. */
interface Failure {
  readonly message: string;
  readonly status?: number;
}

const failure = (message: string, status?: number): Failure =>
  status === undefined ? { message } : { message, status };

const send = (
  request: HttpClientRequest.HttpClientRequest,
): Effect.Effect<Exchange, Failure, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(request);
    const body = yield* response.text;

    return { status: response.status, body: tryParseJson(body) };
  }).pipe(
    Effect.mapError(() => failure("request failed")),
    Effect.provideService(HttpClient.TracerPropagationEnabled, false),
  );

const ok = (exchange: Exchange): boolean => exchange.status >= 200 && exchange.status < 300;

/** Request headers: the configured ones first, so the authentication headers always win. */
const headersOf = (target: ApiKeyProbeTarget, auth: Readonly<Record<string, string>>) => ({
  accept: "application/json",
  ...target.headers,
  ...auth,
});

const bearer = (key: string) => (key === "" ? {} : { authorization: `Bearer ${key}` });

const claudeAuth = (target: ApiKeyProbeTarget) => {
  const first = (() => {
    try {
      return isAnthropicUpstreamURL(new URL(target.baseUrl));
    } catch {
      return false;
    }
  })();

  if (target.apiKey === "") return { "anthropic-version": "2023-06-01" };

  return first && !isClaudeOAuthToken(target.apiKey)
    ? { "x-api-key": target.apiKey, "anthropic-version": "2023-06-01" }
    : { ...bearer(target.apiKey), "anthropic-version": "2023-06-01" };
};

const modelIdOf = (value: string): string => value.replace(/^models\//, "");

/** Models of a listing: OpenAI `{data:[{id}]}`, Anthropic `{data:[{id,display_name}]}`, Gemini `{models:[{name,displayName}]}`. */
export const parseModelList = (
  body: Json | undefined,
): ReadonlyArray<{ id: string; display_name?: string }> => {
  if (!isJsonObject(body)) return [];
  const list = Array.isArray(body.data) ? body.data : Array.isArray(body.models) ? body.models : [];
  const models: Array<{ id: string; display_name?: string }> = [];

  for (const item of list) {
    if (!isJsonObject(item)) continue;

    const id =
      typeof item.id === "string" ? item.id : typeof item.name === "string" ? item.name : "";

    const label = item.display_name ?? item.displayName;

    if (id === "") continue;
    models.push({
      id: modelIdOf(id),
      ...(typeof label === "string" && label !== "" ? { display_name: label } : {}),
    });

    if (models.length >= MAX_MODELS) break;
  }

  return models;
};

const listing = Effect.fnUntraced(function* (
  target: ApiKeyProbeTarget,
): Effect.fn.Return<Probed, Failure, HttpClient.HttpClient> {
  const base = trimSlash(target.baseUrl);
  const { family } = target;

  if (family === "gemini" || family === "interactions") {
    const headers = headersOf(
      target,
      target.apiKey === "" ? {} : { "x-goog-api-key": target.apiKey },
    );

    const models: Array<{ id: string; display_name?: string }> = [];
    let token: string | undefined;
    let last: Exchange = { status: 0, body: undefined };

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const params = new URLSearchParams({ pageSize: "1000" });

      if (token !== undefined) params.set("pageToken", token);

      const request = HttpClientRequest.get(`${base}/v1beta/models?${params.toString()}`).pipe(
        HttpClientRequest.setHeaders(headers),
      );

      last = yield* send(request);

      if (!ok(last)) return { ...last, models: [] };
      models.push(...parseModelList(last.body));
      const next = isJsonObject(last.body) ? last.body.nextPageToken : undefined;
      token = typeof next === "string" && next !== "" ? next : undefined;

      if (token === undefined) break;
    }

    return { status: last.status, body: last.body, models };
  }

  const url =
    family === "claude"
      ? `${base}/v1/models?limit=1000`
      : family === "openai-compatibility" || base.endsWith("/v1")
        ? `${base}/models`
        : `${base}/v1/models`;

  const auth = family === "claude" ? claudeAuth(target) : bearer(target.apiKey);

  const exchange = yield* send(
    HttpClientRequest.get(url).pipe(HttpClientRequest.setHeaders(headersOf(target, auth))),
  );

  return { ...exchange, models: ok(exchange) ? parseModelList(exchange.body) : [] };
});

const countTokens = Effect.fnUntraced(function* (
  target: ApiKeyProbeTarget,
  model: string,
): Effect.fn.Return<Probed, Failure, HttpClient.HttpClient> {
  const request = HttpClientRequest.post(
    `${trimSlash(target.baseUrl)}/v1/publishers/google/models/${encodeURIComponent(model)}:countTokens`,
  ).pipe(
    HttpClientRequest.setHeaders(
      headersOf(target, target.apiKey === "" ? {} : { "x-goog-api-key": target.apiKey }),
    ),
    HttpClientRequest.bodyText(
      JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }] }),
      "application/json",
    ),
  );

  const exchange = yield* send(request);

  return { ...exchange, models: [] };
});

const validBase = (value: string): boolean => {
  try {
    const url = new URL(value);

    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      url.username === "" &&
      url.password === ""
    );
  } catch {
    return false;
  }
};

const run = Effect.fnUntraced(function* (
  target: ApiKeyProbeTarget,
): Effect.fn.Return<Probed, Failure, HttpClient.HttpClient> {
  if (!validBase(target.baseUrl)) return yield* Effect.fail(failure("invalid base url"));

  if (target.family === "vertex") {
    const [model] = target.models;

    if (model === undefined) return yield* Effect.fail(failure("no model configured to test"));

    return yield* countTokens(target, model);
  }

  return yield* listing(target);
});

/** Probes one key; always answers a result (a failure is `ok: false`), never fails. */
export const probeApiKey = (
  target: ApiKeyProbeTarget,
): Effect.Effect<ProbeResult, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const started = yield* Clock.currentTimeMillis;

    const outcome = yield* run(target).pipe(
      Effect.timeoutOrElse({
        duration: TIMEOUT,
        orElse: () => Effect.fail(failure("request timed out")),
      }),
      Effect.result,
    );

    const latency = Math.max(0, (yield* Clock.currentTimeMillis) - started);

    if (Result.isFailure(outcome)) {
      const { message, status } = outcome.failure;

      return {
        ok: false,
        latency_ms: latency,
        error: message,
        ...(status === undefined ? {} : { status_code: status }),
      } satisfies ProbeResult;
    }

    const exchange = outcome.success;

    if (!ok(exchange)) {
      return {
        ok: false,
        status_code: exchange.status,
        latency_ms: latency,
        error: `upstream answered ${exchange.status}`,
      } satisfies ProbeResult;
    }

    // A 2xx that is not JSON is a wrong base URL (a login page, a proxy), not a working key.
    if (exchange.body === undefined) {
      return {
        ok: false,
        status_code: exchange.status,
        latency_ms: latency,
        error: "unexpected response (not JSON)",
      } satisfies ProbeResult;
    }

    return {
      ok: true,
      status_code: exchange.status,
      latency_ms: latency,
      ...(exchange.models.length === 0 ? {} : { models: exchange.models }),
    } satisfies ProbeResult;
  });
