/**
 * Claude Code cloaking: billing header, identity system block, caller system relocation, current-date reminder,
 * context management, sensitive word obfuscation and fake user ids.
 *
 * Go source: internal/runtime/executor/claude_executor_cloaking.go (generateBillingHeader, computeFingerprint,
 * checkSystemInstructionsWithSigningModeAt, relocateClaudeSystemPromptForCountTokens,
 * insertClaudeMidConversationSystemBlocks, prependClaudeSystemReminderBlocksToFirstUserMessage,
 * injectClaudeCodeCurrentDateInternal, injectClaudeCodeContextManagement, applyCloakingInternal),
 * helps/cloak_obfuscate.go, helps/cloak_utils.go. Not ported: the Fable/Opus-5.5 payload-rule reconcilers and the
 * system placement reconciliation that only matter when payload rules rewrite the model after cloaking.
 */
import { createHash, randomBytes } from "node:crypto"
import type { Config } from "../../config/schema.ts"
import { cloneJson, get, type Json, type JsonObject } from "../../json/index.ts"
import { isClaudeCodeAttributionSystemText } from "../../translator/common/claude-messages.ts"
import { isArr, isObj, str } from "../../translator/common/gjson.ts"
import type { CredentialSnapshot } from "../picker.ts"
import { isExplicitPromptCacheMode, stripCacheControlTTL, textBlock } from "./cache-control.ts"
import {
  defaultClaudeVersion,
  extractBillingTags,
  isFable51Model,
  isNewPromptTurn,
  isOpus55Model,
  isProbeOrHelperRequest,
  isSubagentRequest,
  isValidUserID,
  subagentRequests1h,
  usesLegacySystemReminder,
  usesProgressDisplay
} from "./classify.ts"
import { type CloakSettings, type WirePolicy } from "./credentials.ts"
import { type ContinuityStore, deterministicPromptId } from "./continuity.ts"
import { defaultDeviceProfile, cachedSessionId } from "./headers.ts"

export const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude."
const FINGERPRINT_SALT = "59cf53e54c78"

export const FABLE_REPORTING_OUTCOMES = `# Reporting outcomes

Report what actually happened, not what you intended. When you say something is done, sent, saved, fixed, or verified, that claim must rest on a result you observed in this session — tool output, the file as it now reads, the page as it now loads — not on what the step should have produced. If you did not check, say you did not check. If any step failed, was skipped, or came back different from what you expected, say so in the first sentence of your report, before anything else, even when the rest of the work succeeded. Never quietly work around a failure in a way that makes it look resolved; a problem the user can see is recoverable, one your summary hides is not. When you stop before the task is complete, your first line says so plainly and names what is left. Do not describe partial work as done, and do not let a summary read as more certain than the evidence behind it.`

const CONTEXT_MANAGEMENT = (): JsonObject => ({ edits: [{ type: "clear_thinking_20251015", keep: "all" }] })

const ephemeral = (): JsonObject => ({ type: "ephemeral" })

/** `computeFingerprint`: 3 hex chars of sha256(salt + chars 4, 7, 20 (UTF-16 units) + version). */
export const computeFingerprint = (messageText: string, version: string): string => {
  let sampled = ""
  for (const index of [4, 7, 20]) {
    const unit = index < messageText.length ? messageText.charCodeAt(index) : 0x30
    sampled += unit >= 0xd800 && unit <= 0xdfff ? "\uFFFD" : String.fromCharCode(unit)
  }
  return createHash("sha256")
    .update(FINGERPRINT_SALT + sampled + version)
    .digest("hex")
    .slice(0, 3)
}

export interface BillingOptions {
  readonly cchSigning: boolean
  readonly version: string
  readonly messageText: string
  readonly entrypoint: string
  readonly workload: string
  readonly isSubagent: boolean
  readonly prevReq: string
  readonly promptId: string
  readonly turnOrigin: string
}

/** `generateBillingHeader`. */
export const generateBillingHeader = (options: BillingOptions): string => {
  const entrypoint = options.entrypoint === "" ? "cli" : options.entrypoint
  let out = `x-anthropic-billing-header: cc_version=${options.version}.${computeFingerprint(options.messageText, options.version)}; cc_entrypoint=${entrypoint};`
  if (options.cchSigning) out += " cch=00000;"
  if (options.workload !== "") out += ` cc_workload=${options.workload};`
  if (options.isSubagent) out += " cc_is_subagent=true;"
  if (options.cchSigning) {
    if (options.prevReq !== "") out += ` cc_prev_req=${options.prevReq};`
    if (options.promptId !== "") out += ` cc_prompt_id=${options.promptId};`
    if (options.turnOrigin === "human") out += " cc_turn_origin=human;"
  }
  return out
}

const isContextReminder = (text: string): boolean =>
  text.startsWith("<system-reminder>") && text.includes("</system-reminder>")
const isCurrentDateReminder = (text: string): boolean =>
  text.startsWith(
    "<system-reminder>\nAs you answer the user's questions, you can use the following context:\n# currentDate\nToday's date is "
  )

export const currentDateReminder = (date: string): string =>
  `<system-reminder>\nAs you answer the user's questions, you can use the following context:\n# currentDate\nToday's date is ${date}.\n\n      IMPORTANT: this context may or may not be relevant to your tasks. You should not respond to this context unless it is highly relevant to your task.\n</system-reminder>\n`

const firstUserMessageIndex = (body: JsonObject): number =>
  isArr(body.messages) ? body.messages.findIndex((message) => str(get(message, "role")) === "user") : -1

/** `claudeBillingFingerprintMessageText`. */
export const billingFingerprintMessageText = (body: JsonObject): string => {
  const index = firstUserMessageIndex(body)
  if (index < 0) return ""
  const content = get(body, `messages.${index}.content`)
  if (typeof content === "string") return content
  if (isArr(content)) {
    for (const part of content) {
      if (str(get(part, "type")) !== "text") continue
      const text = str(get(part, "text"))
      if (!isCurrentDateReminder(text) && !isContextReminder(text)) return text
    }
  }
  return ""
}

interface ForwardedBlock {
  readonly text: string
  readonly cacheControl: JsonObject | undefined
}

const collectForwardedBlocks = (system: Json | undefined): ForwardedBlock[] => {
  const blocks: ForwardedBlock[] = []
  const push = (text: string, cacheControl?: JsonObject): void => {
    if (text.trim() === "" || isClaudeCodeAttributionSystemText(text) || text === CLAUDE_CODE_IDENTITY) return
    blocks.push({ text, cacheControl })
  }
  if (typeof system === "string") push(system)
  else if (isArr(system)) {
    for (const item of system) {
      if (str(get(item, "type")) !== "text") continue
      const cc = get(item, "cache_control")
      push(str(get(item, "text")), isObj(cc) && cc.type === "ephemeral" ? cc : undefined)
    }
  }
  return blocks
}

/** `buildForwardedSystemBlock`. */
const forwardedBlock = (block: ForwardedBlock, explicit: boolean): JsonObject =>
  explicit
    ? textBlock(block.text, block.cacheControl === undefined ? undefined : cloneJson(block.cacheControl))
    : textBlock(block.text, ephemeral())

const hasAdvisorHistory = (body: JsonObject): boolean => {
  if (!isArr(body.messages)) return false
  for (const message of body.messages) {
    const content = get(message, "content")
    const blocks = isArr(content) ? content : isObj(content) ? [content] : []
    for (const block of blocks) {
      switch (str(get(block, "type"))) {
        case "advisor_tool_result":
        case "advisor_redacted_result":
          return true
        case "server_tool_use":
          if (str(get(block, "name")) === "advisor") return true
          break
        case "tool_result": {
          const inner = get(block, "content")
          const innerBlocks = isArr(inner) ? inner : isObj(inner) ? [inner] : []
          if (innerBlocks.some((item) => str(get(item, "type")) === "advisor_redacted_result")) return true
        }
      }
    }
  }
  return false
}

const messageContentText = (content: Json | undefined): string => {
  if (typeof content === "string") return content
  if (!isArr(content)) return ""
  return content
    .filter((block) => str(get(block, "type")) === "text")
    .map((block) => str(get(block, "text")))
    .join("\n\n")
}

/** `claudeMidConversationSystemMessagesAtEnd`. */
const midConversationSystemAtEnd = (body: JsonObject): boolean => {
  const firstUser = firstUserMessageIndex(body)
  if (firstUser < 0 || !isArr(body.messages)) return false
  let insertAt = firstUser + 1
  while (insertAt < body.messages.length && str(get(body.messages[insertAt], "role")) === "user") insertAt++
  return insertAt === body.messages.length || insertAt > firstUser + 1
}

/** `insertClaudeMidConversationSystemBlocks`: one `role:"system"` message per caller block after the first user turn(s). */
const insertMidConversationSystemBlocks = (
  body: JsonObject,
  blocks: readonly ForwardedBlock[],
  explicit: boolean
): void => {
  const firstUser = firstUserMessageIndex(body)
  if (firstUser < 0 || blocks.length === 0 || !isArr(body.messages)) return
  const messages = body.messages
  let insertAt = firstUser + 1
  while (insertAt < messages.length && str(get(messages[insertAt], "role")) === "user") insertAt++
  if (messages.length - insertAt >= blocks.length) {
    const matches = blocks.every((block, index) => {
      const message = messages[insertAt + index]
      return str(get(message, "role")) === "system" && messageContentText(get(message, "content")) === block.text
    })
    if (matches) return
  }
  const systemMessages: Json[] = blocks.map((block) => ({ role: "system", content: [forwardedBlock(block, explicit)] }))
  messages.splice(insertAt, 0, ...systemMessages)
}

const callerSystemReminder = (text: string): string =>
  `<system-reminder>\n${text}${text.endsWith("\n") ? "" : "\n"}</system-reminder>`

/** `prependClaudeSystemReminderBlocksToFirstUserMessage`. */
const prependSystemReminderBlocks = (body: JsonObject, blocks: readonly ForwardedBlock[], explicit: boolean): void => {
  const firstUser = firstUserMessageIndex(body)
  if (firstUser < 0 || blocks.length === 0 || !isArr(body.messages)) return
  const message = body.messages[firstUser] as JsonObject
  const content = message.content
  const reminder = (block: ForwardedBlock): JsonObject => {
    const text = callerSystemReminder(block.text)
    return explicit && block.cacheControl !== undefined
      ? textBlock(text, cloneJson(block.cacheControl))
      : textBlock(text)
  }
  if (isArr(content)) {
    const existing = new Map<string, number>()
    for (const block of content) {
      if (str(get(block, "type")) === "text") {
        const text = str(get(block, "text"))
        existing.set(text, (existing.get(text) ?? 0) + 1)
      }
    }
    const reminders: JsonObject[] = []
    for (const block of blocks) {
      const text = callerSystemReminder(block.text)
      const count = existing.get(text) ?? 0
      if (count > 0) {
        existing.set(text, count - 1)
        continue
      }
      reminders.push(reminder(block))
    }
    if (reminders.length === 0) return
    let insertAt = 0
    while (insertAt < content.length && str(get(content[insertAt], "type")) === "tool_result") insertAt++
    content.splice(insertAt, 0, ...reminders)
  } else if (typeof content === "string") {
    message.content = [...blocks.map(reminder), textBlock(content)]
  }
}

/** `injectClaudeCodeCurrentDateInternal`. */
export const injectCurrentDate = (body: JsonObject, date: string, explicit: boolean): void => {
  const firstUser = firstUserMessageIndex(body)
  if (firstUser < 0 || !isArr(body.messages)) return
  const message = body.messages[firstUser] as JsonObject
  const content = message.content
  const dateBlock = textBlock(currentDateReminder(date))
  if (typeof content === "string") {
    message.content = [dateBlock, textBlock(content, explicit ? undefined : ephemeral())]
    return
  }
  if (!isArr(content)) return
  const blocks: Json[] = []
  let actualTextCached = false
  for (const block of content) {
    if (str(get(block, "type")) === "text") {
      const text = str(get(block, "text"))
      if (isCurrentDateReminder(text)) continue
      if (!actualTextCached && !isContextReminder(text) && !explicit && isObj(block)) {
        blocks.push({ ...block, cache_control: ephemeral() })
        actualTextCached = true
        continue
      }
    }
    blocks.push(block)
  }
  let insertAt = 0
  while (insertAt < blocks.length && str(get(blocks[insertAt], "type")) === "tool_result") insertAt++
  blocks.splice(insertAt, 0, dateBlock)
  message.content = blocks
}

export interface SystemInstructionOptions {
  readonly strictMode: boolean
  readonly cchSigning: boolean
  readonly version: string
  readonly entrypoint: string
  readonly workload: string
  readonly currentDate: string
  readonly isSubagent: boolean
  readonly prevReq: string
  readonly promptId: string
  readonly keepCallerSystemTopLevel: boolean
  readonly turnOrigin: string
  readonly explicitCacheMode: boolean
}

/** `checkSystemInstructionsWithSigningModeAt`. */
export const applySystemInstructions = (body: JsonObject, options: SystemInstructionOptions): void => {
  const system = body.system
  const messageText = billingFingerprintMessageText(body)
  const billingText = generateBillingHeader({
    cchSigning: options.cchSigning,
    version: options.version,
    messageText,
    entrypoint: options.entrypoint,
    workload: options.workload,
    isSubagent: options.isSubagent,
    prevReq: options.prevReq,
    promptId: options.promptId,
    turnOrigin: options.turnOrigin
  })
  const explicit = options.explicitCacheMode || isExplicitPromptCacheMode(body)
  const systemBlocks: JsonObject[] = [
    textBlock(billingText),
    textBlock(CLAUDE_CODE_IDENTITY, explicit ? undefined : ephemeral())
  ]
  const model = str(body.model).trim().toLowerCase()
  if (isFable51Model(model) && !isProbeOrHelperRequest(body)) systemBlocks.push(textBlock(FABLE_REPORTING_OUTCOMES))
  body.system = systemBlocks
  if (options.strictMode) return injectCurrentDate(body, options.currentDate, explicit)
  const forwarded = collectForwardedBlocks(system)
  if (forwarded.length === 0) return injectCurrentDate(body, options.currentDate, explicit)
  if (hasAdvisorHistory(body)) {
    for (const block of forwarded) systemBlocks.push(forwardedBlock(block, explicit))
  } else if (usesLegacySystemReminder(body)) {
    prependSystemReminderBlocks(body, forwarded, explicit)
  } else if (options.keepCallerSystemTopLevel && midConversationSystemAtEnd(body)) {
    for (const block of forwarded) systemBlocks.push(forwardedBlock(block, explicit))
  } else {
    insertMidConversationSystemBlocks(body, forwarded, explicit)
  }
  injectCurrentDate(body, options.currentDate, explicit)
}

/** `relocateClaudeSystemPromptForCountTokens`: caller system moves into messages; no billing/identity blocks. */
export const relocateSystemForCountTokens = (body: JsonObject, strictMode: boolean, explicit: boolean): void => {
  if (body.system === undefined) return
  const forwarded = strictMode ? [] : collectForwardedBlocks(body.system)
  if (forwarded.length === 0) {
    delete body.system
    return
  }
  if (hasAdvisorHistory(body)) {
    body.system = forwarded.map((block) => forwardedBlock(block, explicit))
    return
  }
  delete body.system
  if (usesLegacySystemReminder(body)) prependSystemReminderBlocks(body, forwarded, explicit)
  else insertMidConversationSystemBlocks(body, forwarded, explicit)
}

const thinkingAcceptsClearThinking = (body: JsonObject): boolean => {
  const type = str(get(body, "thinking.type"))
  return type === "enabled" || type === "adaptive"
}

/** `injectClaudeCodeContextManagement`; returns whether it was injected. */
export const injectContextManagement = (body: JsonObject): boolean => {
  if (body.context_management !== undefined || !thinkingAcceptsClearThinking(body)) return false
  body.context_management = CONTEXT_MANAGEMENT()
  return true
}

export interface ContextManagementState {
  readonly eligible: boolean
  readonly callerOwned: boolean
  readonly automaticallyInjected: boolean
}

/** `reconcileClaudeCodeContextManagement`. */
export const reconcileContextManagement = (body: JsonObject, state: ContextManagementState): void => {
  const current = body.context_management
  if (!thinkingAcceptsClearThinking(body)) {
    if (state.callerOwned || !state.automaticallyInjected) return
    if (JSON.stringify(current) !== JSON.stringify(CONTEXT_MANAGEMENT())) return
    delete body.context_management
    return
  }
  if (!state.eligible || state.callerOwned || current !== undefined) return
  body.context_management = CONTEXT_MANAGEMENT()
}

const ZERO_WIDTH_SPACE = "\u200B"

export interface SensitiveWordMatcher {
  /** `Matches`: the text contains a configured word. */
  readonly matches: (text: string) => boolean
  /** `ObfuscateText`: inserts a zero-width space after the first character of every match. */
  readonly obfuscate: (text: string) => string
}

/**
 * `BuildSensitiveWordMatcher`: case-insensitive, longest word first, words of at least two characters;
 * `undefined` when no usable word is configured.
 */
export const buildSensitiveWordMatcher = (words: readonly string[]): SensitiveWordMatcher | undefined => {
  const valid = words
    .map((word) => word.trim())
    .filter((word) => [...word].length >= 2 && !word.includes(ZERO_WIDTH_SPACE))
    .toSorted((a, b) => new TextEncoder().encode(b).length - new TextEncoder().encode(a).length)
  if (valid.length === 0) return undefined
  const pattern = valid.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")
  const regex = new RegExp(pattern, "giu")
  const probe = new RegExp(pattern, "iu")
  return {
    matches: (text) => probe.test(text),
    obfuscate: (text) =>
      text.replace(regex, (word) => {
        if (word.includes(ZERO_WIDTH_SPACE)) return word
        const first = [...word][0] as string
        return word.length <= first.length ? word : first + ZERO_WIDTH_SPACE + word.slice(first.length)
      })
  }
}

/** `ObfuscateSensitiveWords` for system blocks and message text. */
export const obfuscateSensitiveWords = (body: JsonObject, words: readonly string[]): void => {
  const obfuscate = buildSensitiveWordMatcher(words)?.obfuscate
  if (obfuscate === undefined) return
  const system = body.system
  if (isArr(system)) {
    for (const block of system) {
      if (isObj(block) && str(block.type) === "text" && !str(block.text).startsWith("x-anthropic-billing-header:")) {
        block.text = obfuscate(str(block.text))
      }
    }
  } else if (typeof system === "string" && !system.startsWith("x-anthropic-billing-header:")) {
    body.system = obfuscate(system)
  }
  if (!isArr(body.messages)) return
  for (const message of body.messages) {
    if (!isObj(message)) continue
    if (typeof message.content === "string") message.content = obfuscate(message.content)
    else if (isArr(message.content)) {
      for (const block of message.content) {
        if (isObj(block) && str(block.type) === "text") block.text = obfuscate(str(block.text))
      }
    }
  }
}

/** `generateFakeUserIDWithSessionID` (cloak without the CLI profile). */
const fakeUserId = (apiKey: string, cacheUserID: boolean): string => {
  const sessionId = cachedSessionId(apiKey)
  const deviceId = cacheUserID
    ? createHash("sha256").update(`cpa-claude-fake-device|${apiKey}`).digest("hex")
    : randomBytes(32).toString("hex")
  return JSON.stringify({ device_id: deviceId, account_uuid: "", session_id: sessionId })
}

/** `injectFakeUserID`. */
const injectFakeUserID = (body: JsonObject, apiKey: string, cacheUserID: boolean): void => {
  const metadata = body.metadata
  const existing = str(get(body, "metadata.user_id"))
  if (metadata === undefined || existing === "" || !isValidUserID(existing)) {
    if (!isObj(metadata)) body.metadata = { user_id: fakeUserId(apiKey, cacheUserID) }
    else metadata.user_id = fakeUserId(apiKey, cacheUserID)
  }
}

/** Local date (`YYYY-MM-DD`) in the credential/config timezone; UTC when none is usable. */
export const claudeCodeLocalDate = (now: Date, timezone: string): string => {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone === "" ? "UTC" : timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).format(now)
  } catch {
    return now.toISOString().slice(0, 10)
  }
}

export interface CloakRequest {
  readonly config: Config
  readonly credential: CredentialSnapshot
  readonly body: JsonObject
  readonly apiKey: string
  readonly policy: WirePolicy
  readonly settings: CloakSettings
  readonly cchSigning: boolean
  readonly explicitCacheMode: boolean
  readonly incoming: Headers
  readonly sessionId: string
  readonly continuity: ContinuityStore
  readonly now: Date
  readonly workload?: string
}

export interface CloakResult {
  readonly cloaked: boolean
  /** Continuity key / prompt id used for the request (empty when none). */
  readonly continuityKey: string
  readonly promptId: string
  readonly previousMessageId: string
}

const credentialIdentity = (credential: CredentialSnapshot): string =>
  credential.id.trim() === "" ? "" : `id:${credential.id.trim()}`

export class CloakError extends Error {
  override readonly name = "CloakError"
  constructor(
    message: string,
    readonly status = 400
  ) {
    super(message)
  }
}

/** `applyCloakingInternal`: mutates `body`; returns whether the request was cloaked. */
export const applyCloaking = (request: CloakRequest): CloakResult => {
  const { body, policy, settings, config, credential } = request
  const none: CloakResult = { cloaked: false, continuityKey: "", promptId: "", previousMessageId: "" }
  if (!policy.cloak) return none
  const explicit = request.explicitCacheMode
  if (!settings.strictMode && isArr(body.system)) {
    let index = 0
    for (const part of body.system) {
      const type = str(get(part, "type")).trim()
      if (type !== "text") {
        throw new CloakError(
          `invalid_request_error: system.${index}.type: Input should be 'text'. System instructions support text only, but this block has type "${type === "" ? "unknown" : type}". Move non-text content into a user message.`
        )
      }
      index++
    }
  }
  const profile = defaultDeviceProfile(config)
  const version = defaultClaudeVersion(profile.userAgent)
  const probeOrHelper = isProbeOrHelperRequest(body)
  let isSubagent = false
  let prevReq = ""
  let promptId = ""
  let pinnedDate = ""
  let continuityKey = ""
  let previousMessageId = ""
  if (!probeOrHelper) {
    isSubagent = isSubagentRequest(request.incoming, body)
    const existing = extractBillingTags(body)
    prevReq = existing.prevReq
    promptId = existing.promptId
    const sessionId = request.sessionId
    if (sessionId !== "" && credentialIdentity(credential) !== "") {
      const state = request.continuity.begin(
        credentialIdentity(credential),
        sessionId,
        isNewPromptTurn(body),
        existing.promptId
      )
      if (state !== undefined) {
        continuityKey = state.key
        pinnedDate = request.continuity.pinDate(
          state.key,
          claudeCodeLocalDate(request.now, credentialTimezone(config, credential))
        )
        // No execution-session metadata on plain HTTP requests: the prompt id is derived from the first user text.
        promptId =
          existing.promptId !== ""
            ? existing.promptId
            : deterministicPromptId(`cpa:prompt:${billingFingerprintMessageText(body)}`)
        if (existing.prevReq !== "") {
          prevReq = existing.prevReq
          previousMessageId = state.previousMessageId
        }
      }
    }
  }
  if (pinnedDate === "") pinnedDate = claudeCodeLocalDate(request.now, credentialTimezone(config, credential))
  const turnOrigin = !probeOrHelper && !isSubagent ? "human" : ""
  applySystemInstructions(body, {
    strictMode: settings.strictMode,
    cchSigning: request.cchSigning,
    version,
    entrypoint: "cli",
    workload: request.workload ?? "",
    currentDate: pinnedDate,
    isSubagent,
    prevReq,
    promptId,
    // OAuth top-level caller prompts trigger Anthropic's third-party classifier (#6432).
    keepCallerSystemTopLevel: !policy.oauth,
    turnOrigin,
    explicitCacheMode: explicit
  })
  const model = str(body.model).trim().toLowerCase()
  if (isOpus55Model(model) && !probeOrHelper && body.fallbacks === undefined)
    body.fallbacks = [{ model: "claude-opus-4-8" }]
  if (isFable51Model(model) && !probeOrHelper && body.fallbacks === undefined)
    body.fallbacks = [{ model: "claude-opus-5" }]
  if (!probeOrHelper) applyThinkingDisplay(body)
  if (!explicit && (probeOrHelper || (isSubagent && !subagentRequests1h(request.incoming, body))))
    stripCacheControlTTL(body)
  if (!policy.profileClaudeCodeCLI) injectFakeUserID(body, request.apiKey, settings.cacheUserID)
  return { cloaked: true, continuityKey, promptId, previousMessageId }
}

/** `applyClaudeCloakThinkingDisplay`: progress-display models show `updates` unless the caller chose. */
const applyThinkingDisplay = (body: JsonObject): void => {
  if (get(body, "thinking.display") !== undefined || !usesProgressDisplay(str(body.model))) return
  const type = str(get(body, "thinking.type")).trim().toLowerCase()
  if (type !== "adaptive" && type !== "enabled") return
  ;(body.thinking as JsonObject).display = "updates"
}

const credentialTimezone = (config: Config, credential: CredentialSnapshot): string => {
  const attribute = (credential.attributes["timezone"] ?? "").trim()
  if (attribute !== "") return attribute
  const metadata = credential.metadata["timezone"]
  if (typeof metadata === "string" && metadata.trim() !== "") return metadata.trim()
  return (config.upstream.claude["header-defaults"].timezone ?? "").trim()
}
