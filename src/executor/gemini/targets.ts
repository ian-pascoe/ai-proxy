/**
 * Endpoint and credential resolution of the Gemini API-key and Vertex executors.
 *
 * Go source: internal/runtime/executor/gemini_executor.go (geminiAPIKey, resolveGeminiBaseURL, shouldExecuteNativeInteractions,
 * nativeInteractionsSourceFormat), internal/runtime/executor/gemini_vertex_executor.go (vertexCreds, vertexAPICreds,
 * vertexBaseURL, vertexInteractionsURL, isNativeVertexInteractionsAuth, shouldExecuteVertexInteractions).
 */
import { Effect } from "effect";
import type { JsonObject } from "../../json/index.ts";
import { Formats } from "../../translator/formats.ts";
import { ExecutionError } from "../errors.ts";

import type { ExecutionContext } from "../types.ts";
import type { GoogleTarget, GoogleVariant } from "./google.ts";

export const GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com";

export const GEMINI_API_VERSION = "v1beta";

export const VERTEX_API_VERSION = "v1";

export const VERTEX_DEFAULT_BASE_URL = "https://aiplatform.googleapis.com";

const trimSlash = (value: string): string => value.replace(/\/+$/, "");

// --- Gemini API key ---------------------------------------------------------------------------------------------------

const NATIVE_INTERACTIONS_SOURCES: ReadonlySet<string> = new Set([
  Formats.Interactions,
  Formats.OpenAI,
  Formats.OpenAIResponse,
  Formats.Claude,
  Formats.Gemini,
]);

/** `resolveGeminiBaseURL`. */
export const geminiBaseUrl = (context: ExecutionContext): string => {
  const custom = (context.credential.attributes["base_url"] ?? "").trim();

  return custom === "" ? GEMINI_ENDPOINT : trimSlash(custom);
};

export const geminiVariant = (identifier: "gemini" | "gemini-interactions"): GoogleVariant => ({
  identifier,
  vertex: false,
  resolveTarget: (context) =>
    Effect.sync((): GoogleTarget => {
      const base = geminiBaseUrl(context);
      const apiKey = context.credential.attributes["api_key"] ?? "";

      return {
        url: (action, model) => `${base}/${GEMINI_API_VERSION}/models/${model}:${action}`,
        interactionsUrl: () => `${base}/${GEMINI_API_VERSION}/interactions`,
        authHeaders: apiKey === "" ? {} : { "x-goog-api-key": apiKey },
      };
    }),
  nativeInteractions: (context, options) =>
    NATIVE_INTERACTIONS_SOURCES.has(options.sourceFormat) &&
    context.credential.provider.trim().toLowerCase() === "gemini-interactions",
});

// --- Vertex -------------------------------------------------------------------------------------------------------------

/** `vertexBaseURL`: `global` uses the bare host, other locations a regional host. */
export const vertexBaseUrl = (location: string): string => {
  const loc = location.trim();

  if (loc === "global") return VERTEX_DEFAULT_BASE_URL;

  return `https://${loc === "" ? "us-central1" : loc}-aiplatform.googleapis.com`;
};

/** `vertexInteractionsURL`. */
export const vertexInteractionsUrl = (
  baseUrl: string,
  projectId: string,
  stream: boolean,
): string => {
  const base = trimSlash(baseUrl.trim() === "" ? VERTEX_DEFAULT_BASE_URL : baseUrl.trim());
  const project = projectId.trim();

  const url =
    project === ""
      ? `${base}/v1beta1/interactions`
      : `${base}/v1beta1/projects/${project}/locations/global/interactions`;

  return stream ? `${url}?alt=sse` : url;
};

/** `isNativeVertexInteractionsAuth`. */
export const isNativeVertexInteractions = (context: ExecutionContext): boolean => {
  const flag = (context.credential.attributes["interactions"] ?? "").trim().toLowerCase();

  if (flag === "true" || flag === "1") return true;
  const { metadata } = context.credential;

  return metadata["interactions"] === true || metadata["native_interactions"] === true;
};

const accessTokenOf = (metadata: JsonObject): string => metadataString(metadata, "access_token");

const metadataString = (metadata: JsonObject, key: string): string => {
  const value = metadata[key];

  return typeof value === "string" ? value.trim() : "";
};

interface VertexApiCreds {
  readonly apiKey: string;
  readonly baseUrl: string;
}

/** `vertexAPICreds`: the `api_key` attribute, else an access token stored on an API-key style credential. */
const vertexApiKey = (context: ExecutionContext): VertexApiCreds => {
  const { attributes, metadata } = context.credential;
  let apiKey = attributes["api_key"] ?? "";

  // Service-account credentials carry a minted `access_token` too; that is a bearer token, not an API key.
  if (apiKey === "" && metadata["service_account"] === undefined) apiKey = accessTokenOf(metadata);

  return { apiKey, baseUrl: attributes["base_url"] ?? "" };
};

/** Service-account access token: minted by the ControlPlane before the attempt (`withCredentialRefresh`). */
const serviceAccountToken = (context: ExecutionContext) => {
  const token = accessTokenOf(context.credential.metadata);

  return token === ""
    ? Effect.fail(
        new ExecutionError({
          status: 401,
          message: "missing access token",
          credentialScoped: true,
        }),
      )
    : Effect.succeed(token);
};

export const vertexVariant: GoogleVariant = {
  identifier: "vertex",
  vertex: true,
  resolveTarget: (context: ExecutionContext) =>
    Effect.gen(function* () {
      const { apiKey, baseUrl } = vertexApiKey(context);
      const { metadata } = context.credential;

      if (apiKey !== "") {
        const base = trimSlash(baseUrl.trim() === "" ? VERTEX_DEFAULT_BASE_URL : baseUrl.trim());
        const project = metadataString(metadata, "project_id");

        return {
          url: (action, model) =>
            `${base}/${VERTEX_API_VERSION}/publishers/google/models/${model}:${action}`,
          interactionsUrl: (stream) => vertexInteractionsUrl(baseUrl, project, stream),
          authHeaders: { "x-goog-api-key": apiKey },
        } satisfies GoogleTarget;
      }

      // Service account.
      let projectId = metadataString(metadata, "project_id");

      if (projectId === "") projectId = metadataString(metadata, "project");

      if (projectId === "") {
        return yield* new ExecutionError({
          status: 500,
          message: "vertex executor: missing project_id in credentials",
        });
      }

      if (metadata["service_account"] === undefined || metadata["service_account"] === null) {
        return yield* new ExecutionError({
          status: 500,
          message: "vertex executor: missing service_account in credentials",
        });
      }

      const location = metadataString(metadata, "location") || "us-central1";
      const token = yield* serviceAccountToken(context);
      const base = vertexBaseUrl(location);

      return {
        url: (action, model) =>
          `${base}/${VERTEX_API_VERSION}/projects/${projectId}/locations/${location}/publishers/google/models/${model}:${action}`,
        interactionsUrl: (stream) =>
          vertexInteractionsUrl(context.credential.attributes["base_url"] ?? "", projectId, stream),
        authHeaders: { authorization: `Bearer ${token}` },
      } satisfies GoogleTarget;
    }),
  nativeInteractions: (context, options) =>
    options.sourceFormat === Formats.Interactions && isNativeVertexInteractions(context),
};
