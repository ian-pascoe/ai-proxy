/**
 * Per-API-key configuration scoping.
 *
 * Go source: internal/runtime/executor/oauth_scope_executor.go (`ForAPIKey` on Codex, Claude, Gemini, Vertex,
 * OpenAICompat, Meta, XAI and Kimi), internal/config/oauth_scope.go (`Config.ForAPIKey`),
 * sdk/cliproxy/auth/conductor_execution.go (the executor is cloned with the scoped config when the selected
 * credential is an API key). `Config.ForAPIKey` zeroes every field that was set under `oauth.providers.*`; the
 * Workers config keeps those settings in `oauth.providers` (the aliased `upstream.*` spellings lose their origin on
 * import, so they stay global). Devin has no `ForAPIKey` and is not wrapped.
 */
import { Schema } from "effect"
import { Config } from "../../config/schema.ts"
import type { ExecutionContext, ProviderExecutor } from "../types.ts"

/** Provider keys whose Go executors implement `ForAPIKey`. */
const SCOPED_PROVIDERS: ReadonlySet<string> = new Set([
  "codex",
  "claude",
  "gemini",
  "vertex",
  "meta",
  "kimi",
  "kimi-ai",
  "xai"
])

let defaults: Config | undefined
const defaultConfig = (): Config => (defaults ??= Schema.decodeUnknownSync(Config)({}))

/** `Config.ForAPIKey`: a request-local view without the OAuth-only provider settings (the input is not modified). */
export const configForApiKey = (config: Config): Config => ({
  ...config,
  oauth: { ...config.oauth, providers: defaultConfig().oauth.providers }
})

/** Execution context for the selected credential: API-key credentials get the scoped config. */
export const scopeContext = (context: ExecutionContext): ExecutionContext =>
  context.credential.kind === "apikey" ? { ...context, config: configForApiKey(context.config) } : context

/** Wraps `executor` so API-key credentials see the scoped config (identity for providers without `ForAPIKey`). */
export const withApiKeyScope = (provider: string, executor: ProviderExecutor): ProviderExecutor =>
  SCOPED_PROVIDERS.has(provider.trim().toLowerCase()) || provider.startsWith("openai-compatible-")
    ? {
        identifier: executor.identifier,
        execute: (context, request, options) => executor.execute(scopeContext(context), request, options),
        executeStream: (context, request, options) => executor.executeStream(scopeContext(context), request, options),
        countTokens: (context, request, options) => executor.countTokens(scopeContext(context), request, options)
      }
    : executor
