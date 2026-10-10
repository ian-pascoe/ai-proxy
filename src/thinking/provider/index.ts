/**
 * Provider applier registry. Go registers appliers in `init()` through `thinking.RegisterProvider`; plugin-owned
 * appliers have no Workers counterpart.
 */
import type { ProviderApplier } from "../types.ts"
import { antigravityApplier } from "./antigravity.ts"
import { claudeApplier } from "./claude.ts"
import { codexApplier } from "./codex.ts"
import { geminiApplier } from "./gemini.ts"
import { interactionsApplier } from "./interactions.ts"
import { kimiApplier } from "./kimi.ts"
import { openaiApplier } from "./openai.ts"
import { xaiApplier } from "./xai.ts"

const APPLIERS: ReadonlyMap<string, ProviderApplier> = new Map([
  ["gemini", geminiApplier],
  ["claude", claudeApplier],
  ["openai", openaiApplier],
  ["codex", codexApplier],
  ["antigravity", antigravityApplier],
  ["kimi", kimiApplier],
  ["kimi-ai", kimiApplier],
  ["kimi.ai", kimiApplier],
  ["kimi.com", kimiApplier],
  ["xai", xaiApplier],
  ["interactions", interactionsApplier]
])

/** The applier for a provider format (case-insensitive); `undefined` for unknown providers (passthrough). */
export const getProviderApplier = (provider: string): ProviderApplier | undefined => {
  const name = provider.trim().toLowerCase()
  return name === "" ? undefined : APPLIERS.get(name)
}

export {
  antigravityApplier,
  claudeApplier,
  codexApplier,
  geminiApplier,
  interactionsApplier,
  kimiApplier,
  openaiApplier,
  xaiApplier
}
