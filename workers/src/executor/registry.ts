/**
 * Provider key -> executor lookup.
 *
 * Go source: sdk/cliproxy/service.go (executor registration per provider; one OpenAI-compatible executor per
 * `openai-compatibility` entry, keyed by `util.OpenAICompatibleProviderKey`). Provider slices register their
 * executors in {@link makeExecutorRegistry}.
 */
import { Context, Layer } from "effect"
import { makeClaudeExecutor } from "./claude/executor.ts"
import { makeCodexExecutor } from "./codex/executor.ts"
import { makeGeminiExecutor, makeGeminiInteractionsExecutor, makeVertexExecutor } from "./gemini/index.ts"
import { makeOpenAICompatExecutor } from "./openai-compat/executor.ts"
import type { ProviderExecutor } from "./types.ts"

export class ExecutorRegistry extends Context.Service<
  ExecutorRegistry,
  {
    /** The executor for a credential's provider key, if any. */
    readonly get: (provider: string) => ProviderExecutor | undefined
  }
>()("cliproxy/executor/ExecutorRegistry") {
  static readonly layer = Layer.sync(ExecutorRegistry, () => ExecutorRegistry.of(makeExecutorRegistry()))
}

const isOpenAICompatProvider = (provider: string): boolean =>
  provider === "openai-compatibility" || provider.startsWith("openai-compatible-")

/** Fixed provider keys (one executor each). */
const FIXED_EXECUTORS: Readonly<Record<string, () => ProviderExecutor>> = {
  codex: makeCodexExecutor,
  claude: makeClaudeExecutor,
  gemini: makeGeminiExecutor,
  "gemini-interactions": makeGeminiInteractionsExecutor,
  vertex: makeVertexExecutor
}

export const makeExecutorRegistry = (): { readonly get: (provider: string) => ProviderExecutor | undefined } => {
  const cache = new Map<string, ProviderExecutor>()
  return {
    get: (provider) => {
      const key = provider.trim().toLowerCase()
      const cached = cache.get(key)
      if (cached !== undefined) return cached
      const fixed = Object.hasOwn(FIXED_EXECUTORS, key) ? FIXED_EXECUTORS[key] : undefined
      if (fixed === undefined && !isOpenAICompatProvider(key)) return undefined
      const executor = fixed === undefined ? makeOpenAICompatExecutor(key) : fixed()
      cache.set(key, executor)
      return executor
    }
  }
}
