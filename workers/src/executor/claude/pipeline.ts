/**
 * Claude request pipeline: client body -> upstream Messages / count_tokens request (URL, headers, signed body).
 *
 * Go source: internal/runtime/executor/claude_executor_execute.go and claude_executor_stream.go (Execute /
 * ExecuteStream), claude_executor_tokens.go (countTokensUpstream). Order (ARCHITECTURE.md "Request pipeline"):
 * translate -> upstream model -> Thinking.apply -> cloaking -> provider shaping (context management, diagnostics,
 * max tokens, sampling, cache control, tool aliases, sanitising, identity, CCH placeholder) -> user payload rules
 * (the last semantic mutation) -> betas extraction / `prompt_cache_options` removal -> serialise + CCH signature.
 * Nothing after the payload rules changes business fields except the caller-betas extraction and the signature.
 */
import { Effect } from "effect"
import { applyPayloadRules } from "../../config/payload/index.ts"
import type { Config } from "../../config/schema.ts"
import { cloneJson, get, type Json, type JsonObject } from "../../json/index.ts"
import { isArr, isObj, str } from "../../translator/common/gjson.ts"
import { Formats } from "../../translator/formats.ts"
import { lookupModelInfo, withModelInfoLookup } from "../../translator/model-info.ts"
import { type TranslatorRegistry } from "../../translator/registry.ts"
import { ExecutionError } from "../errors.ts"
import type { CredentialSnapshot } from "../picker.ts"
import { parseSuffix } from "../suffix.ts"
import { Thinking } from "../thinking.ts"
import type { ExecutorOptions, ExecutorRequest } from "../types.ts"
import { extractAndRemoveBetas, BETA } from "./betas.ts"
import {
  enforceCacheControlLimit,
  ensureCacheControl,
  isExplicitPromptCacheMode,
  normalizeCacheControlTTL,
  shouldEnsureCacheControl,
  stripCacheControlTTL,
  stripPromptCacheOptions,
  upgradeCacheControlTTL,
  CACHE_TTL_1H
} from "./cache-control.ts"
import {
  defaultClaudeVersion,
  detectClaudeCodeRequest,
  extractBillingTags,
  isProbeOrHelperRequest,
  isSubagentRequest,
  subagentRequests1h,
  usesLegacySystemReminder
} from "./classify.ts"
import {
  applyCloaking,
  planContinuity,
  billingFingerprintMessageText,
  CloakError,
  generateBillingHeader,
  injectContextManagement,
  obfuscateSensitiveWords,
  reconcileContextManagement,
  relocateSystemForCountTokens
} from "./cloaking.ts"
import { type ContinuityState, type ContinuityStore } from "./continuity.ts"
import {
  claudeCreds,
  DEFAULT_BASE_URL,
  isAnthropicUpstreamBase,
  resolveClaudeKeyConfig,
  resolveFingerprintPolicy,
  resolveWirePolicy,
  type FingerprintPolicy
} from "./credentials.ts"
import { buildClaudeHeaders, cachedSessionId, defaultDeviceProfile } from "./headers.ts"
import { type ClaudeUpstreamProfile, upstreamModelOf } from "./profile.ts"
import { agentSessionUuid, applyCLIIdentity, IdentityError } from "./identity.ts"
import { remapToolNames, DEFAULT_ALIAS_SECRET } from "./mcp-alias.ts"
import { sanitizeForClaudeUpstream } from "./sanitize.ts"
import { cchSigningEnabled, ensureBillingCCHPlaceholder, CchSigningError, serializeAndSign } from "./signing.ts"
import {
  restoreReplayContent,
  replayModelFamily,
  type ReplayScope,
  type ThinkingReplayStore
} from "./thinking-replay.ts"
import { TokenCountValidationError, validateTokenCountRequest } from "./tokens.ts"

const DEFAULT_MODEL_MAX_TOKENS = 1024

export interface PipelineServices {
  readonly registry: TranslatorRegistry
  readonly continuity: ContinuityStore
  readonly replay: ThinkingReplayStore
  readonly now: () => Date
  /** Delegating provider profile (Kimi); `undefined` for the Claude provider itself. */
  readonly profile?: ClaudeUpstreamProfile | undefined
}

export interface PrepareInput {
  readonly services: PipelineServices
  readonly config: Config
  readonly credential: CredentialSnapshot
  readonly request: ExecutorRequest
  readonly options: ExecutorOptions
  /** Whether the upstream request streams (`upstreamStream` in Go; always true for `executeStream`). */
  readonly upstreamStream: boolean
}

export interface PreparedClaudeRequest {
  readonly url: string
  readonly headers: Record<string, string>
  /** Exact body text to send (signed). */
  readonly bodyText: string
  /** Final business payload (after payload rules). */
  readonly body: JsonObject
  /** Provider-format request snapshot handed to response translators (Go `bodyForTranslation`). */
  readonly translatedRequest: JsonObject
  readonly baseModel: string
  readonly fastRequest: boolean
  readonly oauthCredential: boolean
  readonly firstParty: boolean
  /** alias -> client tool name for this request (empty without aliasing). */
  readonly reverseMap: ReadonlyMap<string, string>
  /** Session continuity started for this request (undefined when none, or diagnostics were rewritten by rules). */
  readonly continuity: ContinuityState | undefined
  readonly promptId: string
  readonly replay: ReplayScope | undefined
}

const requestScoped = (status: number, message: string): ExecutionError =>
  new ExecutionError({ status, message, requestScoped: true })

/** `ensureModelMaxTokens`: registry max (or 1024) when the model is a known Claude model without `max_tokens`. */
const ensureModelMaxTokens = (body: JsonObject, modelId: string): void => {
  if (body.max_tokens !== undefined) return
  const info = lookupModelInfo(modelId.trim(), "claude")
  if (info === undefined) return
  const max = info.maxCompletionTokens ?? 0
  body.max_tokens = max > 0 ? max : DEFAULT_MODEL_MAX_TOKENS
}

/** `disableThinkingIfToolChoiceForced`. */
const disableThinkingIfToolChoiceForced = (body: JsonObject): void => {
  const type = str(get(body, "tool_choice.type"))
  if (type !== "any" && type !== "tool") return
  delete body.thinking
  const outputConfig = body.output_config
  if (isObj(outputConfig)) {
    delete outputConfig.effort
    if (Object.keys(outputConfig).length === 0) delete body.output_config
  }
}

/** `normalizeClaudeSamplingForUpstream`. */
const normalizeSampling = (body: JsonObject, nativeOwned: boolean): void => {
  const thinkingType = str(get(body, "thinking.type")).trim().toLowerCase()
  const thinkingActive = thinkingType === "enabled" || thinkingType === "adaptive" || thinkingType === "auto"
  if (!nativeOwned) {
    delete body.temperature
    delete body.top_p
    if (thinkingActive) delete body.top_k
    return
  }
  if (thinkingActive) {
    if (body.temperature !== undefined && Number(body.temperature) !== 1) delete body.temperature
    if (body.top_p !== undefined && Number(body.top_p) < 0.95) delete body.top_p
    delete body.top_k
    return
  }
  if (body.temperature !== undefined && body.top_p !== undefined) delete body.top_p
}

/** `validateClaudeMidSystemMessageModel`. */
const validateMidSystemMessageModel = (
  body: JsonObject,
  confirmed: boolean,
  firstParty: boolean
): ExecutionError | undefined => {
  if (confirmed || !firstParty || !usesLegacySystemReminder(body)) return undefined
  if (!isArr(body.messages) || !body.messages.some((message) => str(get(message, "role")) === "system"))
    return undefined
  const model = str(body.model)
  return requestScoped(
    400,
    `invalid_request_error: role 'system' is not supported on this model. Model "${model === "" ? "unknown" : model}" predates mid-conversation system turns, so system instructions must stay in the top-level system field for it.`
  )
}

/** The credential's `is-compat` flag for the executed model (`APIKeyModelIsCompat`). */
const modelIsCompat = (config: Config, credential: CredentialSnapshot, model: string): boolean => {
  const entry = resolveClaudeKeyConfig(config, credential)?.entry
  if (entry === undefined) return false
  const base = parseSuffix(model).modelName.toLowerCase()
  return (entry.models ?? []).some(
    (candidate) =>
      candidate["is-compat"] === true &&
      [candidate.name, candidate.alias].some((value) => (value ?? "").trim().toLowerCase() === base)
  )
}

const aliasSecret = (options: ExecutorOptions): string => options.metadata.callerScope.trim() || DEFAULT_ALIAS_SECRET

/** Maps a thrown pipeline failure to an `ExecutionError`. */
const toExecutionError = (error: unknown): ExecutionError => {
  if (error instanceof ExecutionError) return error
  if (error instanceof CloakError) return requestScoped(error.status, error.message)
  if (error instanceof TokenCountValidationError) return requestScoped(400, error.message)
  if (error instanceof IdentityError) return requestScoped(400, error.message)
  if (error instanceof CchSigningError)
    return new ExecutionError({ status: 500, message: `sign Claude CCH: ${error.message}` })
  return new ExecutionError({
    status: 500,
    message: error instanceof Error ? error.message : "claude request preparation failed",
    cause: error
  })
}

const attempt = <A>(run: () => A) => Effect.try({ try: run, catch: toExecutionError })

interface Common {
  readonly baseModel: string
  readonly apiKey: string
  readonly baseURL: string
  readonly parsedUrl: URL
  readonly firstParty: boolean
  readonly fingerprint: FingerprintPolicy
  readonly confirmed: boolean
  readonly sessionId: string
  readonly originalPayload: Json
}

const commonContext = (input: PrepareInput, path: string, countTokens: boolean): Common => {
  const { config, credential, request, options } = input
  const baseModel = parseSuffix(request.model).modelName
  const { apiKey, baseURL: rawBase } = claudeCreds(credential)
  const baseURL = rawBase === "" ? DEFAULT_BASE_URL : rawBase
  const parsedUrl = new URL(`${baseURL}${path}?beta=true`)
  const fingerprint = resolveFingerprintPolicy(config, credential, apiKey)
  const originalPayload = options.originalRequest ?? request.payload
  const confirmed = detectClaudeCodeRequest(
    options.headers,
    originalPayload,
    countTokens,
    defaultDeviceProfile(config).userAgent
  ).confirmed
  const sessionId = fingerprint.profileClaudeCodeCLI
    ? agentSessionUuid({
        headers: options.headers,
        payload: originalPayload,
        confirmedClaudeCode: confirmed,
        sessionId: options.metadata.sessionId
      })
    : ""
  return {
    baseModel,
    apiKey,
    baseURL,
    parsedUrl,
    firstParty: isAnthropicUpstreamBase(baseURL),
    fingerprint,
    confirmed,
    sessionId,
    originalPayload
  }
}

/** `claudeRequestIsFast`: `speed: "fast"` or the fast-mode beta header on a first-party request. */
const isFastRequest = (body: JsonObject, headers: Record<string, string>): boolean =>
  str(body.speed).trim().toLowerCase() === "fast" ||
  (headers["anthropic-beta"] ?? "").split(",").some((beta) => beta.trim() === BETA.fastMode)

/** Builds the upstream Messages request. */
export const prepareMessagesRequest = Effect.fnUntraced(function* (input: PrepareInput) {
  const { services, config, credential, request, options, upstreamStream } = input
  const thinking = yield* Thinking
  const c = yield* attempt(() => commonContext(input, "/v1/messages", false))
  const { baseModel, apiKey, firstParty, fingerprint, confirmed, sessionId, originalPayload, parsedUrl } = c
  const from = options.sourceFormat
  const to = Formats.Claude
  const cchSigning = cchSigningEnabled(apiKey, fingerprint.profileClaudeCodeCLI, parsedUrl.toString())
  const isCompat = modelIsCompat(config, credential, request.model)
  const replayEnabled =
    from === Formats.Claude &&
    credential.provider === "claude" &&
    credential.kind === "apikey" &&
    isCompat &&
    apiKey.trim() !== "" &&
    !apiKey.includes("sk-ant-oat")

  // Thinking replay: restore cached thinking blocks into the client payload.
  let payload: Json = request.payload
  let replay: ReplayScope | undefined
  if (replayEnabled) {
    const family = replayModelFamily(credential.id, c.baseURL, apiKey, baseModel)
    const sessionKey =
      (options.metadata.sessionId ?? "").trim() === ""
        ? ""
        : `${options.metadata.callerScope}:${options.metadata.sessionId}`
    const stored = family !== "" && sessionKey !== "" ? yield* services.replay.get(family, sessionKey) : undefined
    let applied = false
    if (stored !== undefined) {
      const restored = cloneJson(payload)
      for (const content of stored.contents)
        if (isObj(restored) && restoreReplayContent(restored, content)) applied = true
      if (applied) payload = restored
    }
    replay = { modelFamily: family, sessionKey, snapshot: stored?.snapshot, cacheReady: true, replayApplied: applied }
  }

  const translate = (body: Json) =>
    withModelInfoLookup(request.modelLookup, () =>
      services.registry.translateRequest(
        from,
        to,
        { format: from, model: baseModel, stream: upstreamStream, body },
        thinking.summary
      )
    )
  const translated = translate(payload)
  if (translated.error !== undefined) return yield* requestScoped(translated.error.status, translated.error.message)
  const originalTranslated = options.originalRequest === undefined ? translated : translate(options.originalRequest)
  if (!isObj(translated.body)) return yield* requestScoped(400, "invalid Claude request body")
  translated.body.model = upstreamModelOf(services.profile, baseModel)
  const thinkingBody = yield* thinking.apply({
    body: translated.body,
    model: request.model,
    from,
    to,
    provider: "claude",
    source: request.payload,
    ...(options.originalRequest === undefined ? {} : { originalSource: options.originalRequest }),
    configurationUpdatesChanged: translated.configurationUpdatesChanged === true,
    modelInfo: request.modelInfo,
    lookupModelInfo: request.modelLookup
  })
  if (!isObj(thinkingBody)) return yield* requestScoped(400, "invalid Claude request body")
  const body: JsonObject = thinkingBody

  // Session continuity is started (one store round trip) before the synchronous request shaping.
  const wire = yield* attempt(() => resolveWirePolicy(config, credential, apiKey, confirmed))
  const now = services.now()
  const plan = yield* attempt(() => planContinuity({ config, credential, body, policy: wire.policy, sessionId, now }))
  const continuity =
    plan === undefined
      ? undefined
      : yield* services.continuity.begin(
          plan.identity,
          plan.sessionId,
          plan.isNewPromptTurn,
          plan.explicitPromptId,
          plan.date
        )

  return yield* attempt(() => {
    const { policy, settings } = wire
    const explicitCacheMode = isExplicitPromptCacheMode(originalPayload, request.payload, body)
    let probeOrHelper = isProbeOrHelperRequest(body)
    const cloak = applyCloaking({
      config,
      credential,
      body,
      apiKey,
      policy,
      settings,
      cchSigning,
      explicitCacheMode,
      incoming: options.headers,
      sessionId,
      continuity,
      now
    })
    const cloaked = cloak.cloaked
    if (!probeOrHelper) probeOrHelper = isProbeOrHelperRequest(body)

    const contextManagement = {
      eligible: cloaked && firstParty,
      callerOwned: body.context_management !== undefined,
      automaticallyInjected: false
    }
    if (contextManagement.eligible) {
      const injected = injectContextManagement(body)
      Object.assign(contextManagement, { automaticallyInjected: injected })
      if (fingerprint.injectDiagnostics && !probeOrHelper && cloak.continuityKey !== "") {
        // `diagnostics.previous_message_id` is null unless an earlier turn of the session was committed.
        body.diagnostics = { previous_message_id: cloak.previousMessageId === "" ? null : cloak.previousMessageId }
      }
    }

    withModelInfoLookup(request.modelLookup, () => ensureModelMaxTokens(body, baseModel))
    disableThinkingIfToolChoiceForced(body)
    reconcileContextManagement(body, contextManagement)
    normalizeSampling(body, confirmed)

    const cpaOwnsCacheControl = shouldEnsureCacheControl(body, cloaked, confirmed, originalPayload, request.payload)
    if (cpaOwnsCacheControl) ensureCacheControl(body)
    enforceCacheControlLimit(body, 4)
    stripPromptCacheOptions(body)
    const subagent = isSubagentRequest(options.headers, body)
    const subagent1h = subagent && subagentRequests1h(options.headers, body)
    if (cpaOwnsCacheControl && fingerprint.profileClaudeCodeCLI && (!subagent || subagent1h) && !probeOrHelper) {
      upgradeCacheControlTTL(body, CACHE_TTL_1H)
    } else if ((probeOrHelper || (subagent && !subagent1h)) && !explicitCacheMode) {
      stripCacheControlTTL(body)
    }
    if (!explicitCacheMode) normalizeCacheControlTTL(body)
    body.stream = upstreamStream

    const translatedRequest = cloneJson(body) as JsonObject
    let reverseMap: ReadonlyMap<string, string> = new Map()
    if (fingerprint.mcpAlias && cloaked) reverseMap = remapToolNames(body, aliasSecret(options))
    sanitizeForClaudeUpstream(body, baseModel, isCompat)
    if (fingerprint.applyCLIIdentity)
      applyCLIIdentity(body, credential, apiKey, sessionId, fingerprint.synthesizeIdentity)
    if (cloaked && settings.sensitiveWords.length > 0) obfuscateSensitiveWords(body, settings.sensitiveWords)
    if (cchSigning) {
      const tags = extractBillingTags(body)
      const fallback =
        body.system !== undefined
          ? generateBillingHeader({
              cchSigning: true,
              version: defaultClaudeVersion(defaultDeviceProfile(config).userAgent),
              messageText: billingFingerprintMessageText(body),
              entrypoint: "cli",
              workload: "",
              isSubagent: isSubagentRequest(options.headers, body),
              prevReq: tags.prevReq,
              promptId: tags.promptId,
              turnOrigin: ""
            })
          : ""
      ensureBillingCCHPlaceholder(body, fallback)
    }
    // Kimi treats the Claude Code attribution block as prompt text (`stripDefaultKimiClaudeCodeAttribution`).
    if (services.profile?.stripDefaultAttribution === true && !fingerprint.profileClaudeCodeCLI) {
      stripAttributionSystem(body)
    }

    // User payload rules: the final semantic mutation of the business payload (AGENTS.md).
    const requestedModel = options.metadata.requestedModel !== "" ? options.metadata.requestedModel : request.model
    const rules = applyPayloadRules(
      config,
      {
        model: baseModel,
        requestedModel,
        protocol: to,
        fromProtocol: from,
        requestPath: options.metadata.requestPath,
        headers: options.headers,
        original: originalTranslated.body,
        trackedPaths: ["diagnostics"]
      },
      body
    )
    const finalBody = rules.payload as JsonObject
    const extraBetas = extractAndRemoveBetas(finalBody)
    stripPromptCacheOptions(finalBody)
    const midSystemError = validateMidSystemMessageModel(finalBody, confirmed, firstParty)
    if (midSystemError !== undefined) throw midSystemError

    const headers = buildClaudeHeaders({
      config,
      credential,
      apiKey,
      url: parsedUrl,
      stream: upstreamStream,
      countTokens: false,
      extraBetas,
      body: finalBody,
      incoming: options.headers,
      confirmedClaudeCode: confirmed && !cloaked,
      fingerprint,
      wire: policy,
      sessionId,
      cpaSessionId: options.metadata.sessionId
    })
    const bodyText = serializeAndSign(finalBody, cchSigning)
    return {
      url: parsedUrl.toString(),
      headers,
      bodyText,
      body: finalBody,
      translatedRequest,
      baseModel,
      fastRequest: firstParty && isFastRequest(finalBody, headers),
      oauthCredential: fingerprint.authIsOAuthToken,
      firstParty,
      reverseMap,
      continuity: rules.touched.has("diagnostics") ? undefined : continuity,
      promptId: cloak.promptId,
      replay
    } satisfies PreparedClaudeRequest
  })
})

/** Builds the upstream `count_tokens` request (first-party upstreams only). */
export const prepareCountTokensRequest = Effect.fnUntraced(function* (input: PrepareInput) {
  const { services, config, credential, request, options } = input
  const thinking = yield* Thinking
  const c = yield* attempt(() => commonContext(input, "/v1/messages/count_tokens", true))
  const { baseModel, apiKey, firstParty, fingerprint, confirmed, sessionId, originalPayload, parsedUrl } = c
  const from = options.sourceFormat
  const to = Formats.Claude
  const isCompat = modelIsCompat(config, credential, request.model)
  const stream = from !== to
  const translate = (body: Json) =>
    withModelInfoLookup(request.modelLookup, () =>
      services.registry.translateRequest(from, to, { format: from, model: baseModel, stream, body }, thinking.summary)
    )
  const translated = translate(request.payload)
  if (translated.error !== undefined) return yield* requestScoped(translated.error.status, translated.error.message)
  const originalTranslated = options.originalRequest === undefined ? translated : translate(options.originalRequest)
  if (!isObj(translated.body)) return yield* requestScoped(400, "invalid Claude request body")
  translated.body.model = upstreamModelOf(services.profile, baseModel)
  const thinkingBody = yield* thinking.apply({
    body: translated.body,
    model: request.model,
    from,
    to,
    provider: "claude",
    source: request.payload,
    ...(options.originalRequest === undefined ? {} : { originalSource: options.originalRequest }),
    configurationUpdatesChanged: translated.configurationUpdatesChanged === true,
    modelInfo: request.modelInfo,
    lookupModelInfo: request.modelLookup
  })
  if (!isObj(thinkingBody)) return yield* requestScoped(400, "invalid Claude request body")
  const body: JsonObject = thinkingBody

  return yield* attempt(() => {
    const { policy, settings } = resolveWirePolicy(config, credential, apiKey, confirmed)
    const cloaked = policy.cloak
    const explicitCacheMode = isExplicitPromptCacheMode(originalPayload, request.payload, body)
    if (cloaked) {
      if (!settings.strictMode && isArr(body.system)) {
        const index = body.system.findIndex((part) => str(get(part, "type")).trim() !== "text")
        if (index >= 0) {
          throw requestScoped(
            400,
            `invalid_request_error: system.${index}.type: Input should be 'text'. System instructions support text only, but this block has type "${str(get(body.system[index], "type")).trim() || "unknown"}". Move non-text content into a user message.`
          )
        }
      }
      relocateSystemForCountTokens(body, settings.strictMode, explicitCacheMode)
      if (settings.sensitiveWords.length > 0) obfuscateSensitiveWords(body, settings.sensitiveWords)
    }
    enforceCacheControlLimit(body, 4)
    if (!explicitCacheMode) normalizeCacheControlTTL(body)
    const extraBetas = extractAndRemoveBetas(body)
    extraBetas.push(BETA.tokenCounting)
    if (fingerprint.mcpAlias && cloaked) remapToolNames(body, aliasSecret(options))
    sanitizeForClaudeUpstream(body, baseModel, isCompat)
    stripPromptCacheOptions(body)
    if (firstParty || fingerprint.profileClaudeCodeCLI) {
      delete body.metadata
      delete body.context_management
      delete body.diagnostics
    }
    if (fingerprint.profileClaudeCodeCLI) stripAttributionSystem(body)
    const midSystemError = validateMidSystemMessageModel(body, confirmed, firstParty)
    if (midSystemError !== undefined) throw midSystemError
    // User payload rules last (final barrier), then the final removal of cache options.
    const requestedModel = options.metadata.requestedModel !== "" ? options.metadata.requestedModel : request.model
    const finalBody = applyPayloadRules(
      config,
      {
        model: baseModel,
        requestedModel,
        protocol: to,
        fromProtocol: from,
        requestPath: options.metadata.requestPath,
        headers: options.headers,
        original: originalTranslated.body
      },
      body
    ).payload as JsonObject
    stripPromptCacheOptions(finalBody)
    const headers = buildClaudeHeaders({
      config,
      credential,
      apiKey,
      url: parsedUrl,
      stream: false,
      countTokens: true,
      extraBetas,
      body: finalBody,
      incoming: options.headers,
      confirmedClaudeCode: confirmed && !cloaked,
      fingerprint,
      wire: policy,
      sessionId,
      cpaSessionId: options.metadata.sessionId
    })
    return { url: parsedUrl.toString(), headers, bodyText: JSON.stringify(finalBody), body: finalBody }
  })
})

/** `StripClaudeCodeAttributionSystem`: removes billing/attribution system text blocks. */
const stripAttributionSystem = (body: JsonObject): void => {
  const system = body.system
  if (typeof system === "string") {
    if (system.trimStart().startsWith("x-anthropic-billing-header:")) delete body.system
    return
  }
  if (!isArr(system)) return
  const kept = system.filter(
    (block) =>
      !(
        str(get(block, "type")) === "text" &&
        str(get(block, "text")).trimStart().startsWith("x-anthropic-billing-header:")
      )
  )
  if (kept.length === system.length) return
  if (kept.length === 0) delete body.system
  else body.system = kept
}

/** Validation + local estimate inputs for `countTokens` without an upstream (third-party gateway). */
export const prepareLocalCountBody = Effect.fnUntraced(function* (input: PrepareInput) {
  const { services, config, credential, request, options } = input
  const thinking = yield* Thinking
  const c = yield* attempt(() => commonContext(input, "/v1/messages/count_tokens", true))
  const { baseModel } = c
  const from = options.sourceFormat
  const to = Formats.Claude
  const isCompat = modelIsCompat(config, credential, request.model)
  const translate = (body: Json) =>
    withModelInfoLookup(request.modelLookup, () =>
      services.registry.translateRequest(
        from,
        to,
        { format: from, model: baseModel, stream: from !== to, body },
        thinking.summary
      )
    )
  const translated = translate(request.payload)
  if (translated.error !== undefined) return yield* requestScoped(translated.error.status, translated.error.message)
  const originalTranslated = options.originalRequest === undefined ? translated : translate(options.originalRequest)
  const thinkingBody = yield* thinking.apply({
    body: translated.body,
    model: request.model,
    from,
    to,
    provider: "claude",
    source: request.payload,
    ...(options.originalRequest === undefined ? {} : { originalSource: options.originalRequest }),
    configurationUpdatesChanged: translated.configurationUpdatesChanged === true,
    modelInfo: request.modelInfo,
    lookupModelInfo: request.modelLookup
  })
  return yield* attempt(() => {
    if (!isObj(thinkingBody)) throw requestScoped(400, "invalid Claude token count request JSON")
    sanitizeForClaudeUpstream(thinkingBody, baseModel, isCompat)
    const requestedModel = options.metadata.requestedModel !== "" ? options.metadata.requestedModel : request.model
    const finalBody = applyPayloadRules(
      config,
      {
        model: baseModel,
        requestedModel,
        protocol: to,
        fromProtocol: from,
        requestPath: options.metadata.requestPath,
        headers: options.headers,
        original: originalTranslated.body
      },
      thinkingBody
    ).payload as JsonObject
    stripPromptCacheOptions(finalBody)
    validateTokenCountRequest(finalBody)
    return finalBody
  })
})

export { cachedSessionId, DEFAULT_MODEL_MAX_TOKENS }
