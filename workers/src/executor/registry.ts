/**
 * Provider key -> executor lookup.
 *
 * Go source: sdk/cliproxy/service.go (executor registration per provider; one OpenAI-compatible executor per
 * `openai-compatibility` entry, keyed by `util.OpenAICompatibleProviderKey`). Provider slices register their
 * executors in {@link makeExecutorRegistry}.
 */
import { Context, Layer } from "effect"
import { makeCodexExecutor } from "./codex/executor.ts"
import { makeClaudeExecutor } from "./claude/executor.ts"
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

export const makeExecutorRegistry = (): { readonly get: (provider: string) => ProviderExecutor | undefined } => {
  const cache = new Map<string, ProviderExecutor>()
  return {
    get: (provider) => {
      const key = provider.trim().toLowerCase()
      const cached = cache.get(key)
      if (cached !== undefined) return cached
      const executor =
        key === "codex"
          ? makeCodexExecutor()
          : key === "claude"
            ? makeClaudeExecutor()
            : isOpenAICompatProvider(key)
              ? makeOpenAICompatExecutor(key)
              : undefined
      if (executor === undefined) return undefined
      cache.set(key, executor)
      return executor
    }
  }
}
