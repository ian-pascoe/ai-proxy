/**
 * Provider key -> executor lookup.
 *
 * Go source: sdk/cliproxy/service.go (executor registration per provider; one OpenAI-compatible executor per
 * `openai-compatibility` entry, keyed by `util.OpenAICompatibleProviderKey`). Provider slices register their
 * executors in {@link makeExecutorRegistry}.
 */
import { Context, Layer } from "effect";
import { makeAntigravityExecutor } from "./antigravity/executor.ts";
import { makeClaudeExecutor } from "./claude/executor.ts";
import { makeCodexExecutor } from "./codex/executor.ts";
import { makeDevinExecutor } from "./devin/executor.ts";
import {
  makeGeminiExecutor,
  makeGeminiInteractionsExecutor,
  makeVertexExecutor,
} from "./gemini/index.ts";
import { withApiKeyScope } from "./helps/oauth-scope.ts";
import { makeKimiExecutor } from "./kimi/executor.ts";
import { makeMetaExecutor } from "./meta/executor.ts";
import { makeOpenAICompatExecutor } from "./openai-compat/executor.ts";
import { makeXaiExecutor } from "./xai/executor.ts";
import type { ProviderExecutor } from "./types.ts";

export class ExecutorRegistry extends Context.Service<
  ExecutorRegistry,
  {
    /** The executor for a credential's provider key, if any. */
    readonly get: (provider: string) => ProviderExecutor | undefined;
  }
>()("cliproxy/executor/ExecutorRegistry") {
  static readonly layer = Layer.sync(ExecutorRegistry, () =>
    ExecutorRegistry.of(makeExecutorRegistry()),
  );
}

const isOpenAICompatProvider = (provider: string): boolean =>
  provider === "openai-compatibility" || provider.startsWith("openai-compatible-");

/** Fixed provider keys (one executor each). */
const FIXED_EXECUTORS = new Map<string, () => ProviderExecutor>([
  ["antigravity", makeAntigravityExecutor],
  ["codex", makeCodexExecutor],
  ["xai", makeXaiExecutor],
  ["claude", makeClaudeExecutor],
  ["gemini", makeGeminiExecutor],
  ["gemini-interactions", makeGeminiInteractionsExecutor],
  ["vertex", makeVertexExecutor],
  ["devin", makeDevinExecutor],
  ["meta", makeMetaExecutor],
  ["kimi", makeKimiExecutor],
  ["kimi-ai", makeKimiExecutor],
]);

export const makeExecutorRegistry = () => {
  const cache = new Map<string, ProviderExecutor>();

  return {
    get: (provider: string): ProviderExecutor | undefined => {
      const key = provider.trim().toLowerCase();
      const cached = cache.get(key);

      if (cached !== undefined) return cached;
      const fixed = FIXED_EXECUTORS.get(key);

      if (fixed === undefined && !isOpenAICompatProvider(key)) return undefined;
      const executor = fixed === undefined ? makeOpenAICompatExecutor(key) : fixed();
      // `ForAPIKey` (oauth_scope_executor.go): API-key credentials see the config without OAuth-only settings.
      const scoped = withApiKeyScope(key, executor);
      cache.set(key, scoped);

      return scoped;
    },
  };
};
