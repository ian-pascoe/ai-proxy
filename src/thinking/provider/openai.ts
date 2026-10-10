/**
 * OpenAI Chat Completions: `reasoning_effort`.
 *
 * Go source: internal/thinking/provider/openai/apply.go.
 */
import { effortApplier } from "./effort.ts";

export const openaiApplier = effortApplier("reasoning_effort");
