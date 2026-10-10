/**
 * Antigravity web-search grounding: Vertex Search redirect URLs in `groundingChunks[].web.uri` are replaced by their
 * targets before the response is translated.
 *
 * Go source: internal/runtime/executor/helps/antigravity_grounding_urls.go (isAntigravityVertexSearchRedirect,
 * resolveAntigravityGroundingURL, ResolveAntigravityGroundingURLs) and antigravity_executor.go
 * (shouldResolveAntigravityWebSearchGroundingURLs, resolveWebSearchGroundingURLs).
 *
 * The redirect is read with `HEAD` and `redirect: "manual"` (the 3xx `Location` must be an https URL); any failure keeps
 * the original URL. No timeout, like Go (the request is cancelled with the client).
 */
import { Effect } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { asString, get, isJsonArray, type Json, set, tryParseJson } from "../../json/index.ts"
import { Formats, type Format } from "../../translator/formats.ts"
import { hasResponsesWebSearchTool } from "../../translator/gemini/openai/responses/web-search.ts"
import {
  hasAntigravityGoogleSearchTool,
  hasClaudeTypedWebSearchTool
} from "../../translator/antigravity/claude/web-search.ts"

const REDIRECT_HOST = "vertexaisearch.cloud.google.com"

const REDIRECT_PATH_PREFIX = "/grounding-api-redirect/"

/** `isAntigravityVertexSearchRedirect`. */
export const isVertexSearchRedirect = (rawUrl: string): boolean => {
  try {
    const parsed = new URL(rawUrl)

    return (
      parsed.protocol === "https:" && parsed.host === REDIRECT_HOST && parsed.pathname.startsWith(REDIRECT_PATH_PREFIX)
    )
  } catch {
    return false
  }
}

/** `shouldResolveAntigravityWebSearchGroundingURLs`. */
export const shouldResolveGroundingUrls = (
  from: Format,
  originalRequest: Json | undefined,
  translatedRequest: Json | undefined
): boolean => {
  if (!hasAntigravityGoogleSearchTool(translatedRequest)) return false

  switch (from) {
    case Formats.Claude:
      return hasClaudeTypedWebSearchTool(originalRequest)
    case Formats.OpenAIResponse:
      return hasResponsesWebSearchTool(originalRequest)
    default:
      return false
  }
}

/** `resolveAntigravityGroundingURL`: the `Location` of the redirect, or the input URL on any failure. */
export const resolveGroundingUrl = (rawUrl: string): Effect.Effect<string, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    if (!isVertexSearchRedirect(rawUrl)) return rawUrl
    const client = yield* HttpClient.HttpClient

    const response = yield* client
      .execute(HttpClientRequest.head(rawUrl))
      .pipe(
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
        Effect.provideService(HttpClient.TracerPropagationEnabled, false)
      )

    if (response.status < 300 || response.status >= 400) return rawUrl
    const location = (response.headers["location"] ?? "").trim()

    if (location === "") return rawUrl

    try {
      const parsed = new URL(location)

      return parsed.protocol === "https:" && parsed.host !== "" ? location : rawUrl
    } catch {
      return rawUrl
    }
  }).pipe(Effect.catchCause(() => Effect.succeed(rawUrl)))

/**
 * `ResolveAntigravityGroundingURLs` over a response payload text. The text is only re-serialised when a URL changed.
 */
export const resolveGroundingUrlsInPayload = (payload: string): Effect.Effect<string, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    if (payload === "" || !payload.includes(REDIRECT_HOST)) return payload
    const parsed = tryParseJson(payload)
    let basePath = "response.candidates.0.groundingMetadata.groundingChunks"
    let chunks = get(parsed, basePath)

    if (!isJsonArray(chunks)) {
      basePath = "candidates.0.groundingMetadata.groundingChunks"
      chunks = get(parsed, basePath)
    }

    if (parsed === undefined || !isJsonArray(chunks)) return payload
    const resolved = new Map<string, string>()
    let changed = false

    for (const [index, chunk] of chunks.entries()) {
      const uri = asString(get(chunk, "web.uri")).trim()

      if (uri === "") continue
      let target = resolved.get(uri)

      if (target === undefined) {
        target = yield* resolveGroundingUrl(uri)
        resolved.set(uri, target)
      }

      if (target === uri) continue
      set(parsed, `${basePath}.${index}.web.uri`, target)
      changed = true
    }

    return changed ? JSON.stringify(parsed) : payload
  })
