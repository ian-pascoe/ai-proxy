/**
 * xAI Grok Responses API: identical to the Codex applier.
 *
 * Go source: internal/thinking/provider/xai/apply.go (embeds codex.Applier).
 */
import { codexApplier } from "./codex.ts"

export const xaiApplier = codexApplier
