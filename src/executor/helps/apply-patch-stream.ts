/**
 * Executor-level `apply_patch` guards for translators that retain tool-input state.
 *
 * Go source: internal/runtime/executor/helps/apply_patch.go (ApplyPatchRequested, IsApplyPatchUpstreamTool,
 * InitializeApplyPatchStream, EndApplyPatchStream). The guards only act when the client declared a winning custom
 * `apply_patch` tool; the error text deliberately excludes upstream JSON and patch text.
 */
import type { Json } from "../../json/index.ts";
import { responsesToolReverseIdentityMap } from "../../translator/gemini/openai/responses/tools.ts";
import type { TranslationState } from "../../translator/registry.ts";
import { APPLY_PATCH_UPSTREAM_ERROR_MESSAGE } from "./apply-patch-responses.ts";
import { ExecutionError } from "../errors.ts";

export { APPLY_PATCH_UPSTREAM_ERROR_MESSAGE };

/** `ApplyPatchRequested`: the original request declares a winning custom `apply_patch` tool. */
export const applyPatchRequested = (original: Json | undefined): boolean => {
  for (const identity of responsesToolReverseIdentityMap(original).values())
    if (identity.applyPatch) return true;

  return false;
};

/** `IsApplyPatchUpstreamTool`: the upstream function `name` is the declared custom `apply_patch` tool. */
export const isApplyPatchUpstreamTool = (original: Json | undefined, name: string): boolean =>
  responsesToolReverseIdentityMap(original).get(name)?.applyPatch === true;

/** The sanitised gateway error Go returns as `statusErr{502, ApplyPatchUpstreamErrorMessage}`. */
export const applyPatchGatewayError = (): ExecutionError =>
  new ExecutionError({ status: 502, message: APPLY_PATCH_UPSTREAM_ERROR_MESSAGE });

/**
 * `EndApplyPatchStream` (the part before delivery): asks the translator state to fail a patch-enabled stream that ends
 * without its protocol terminator. Returns the frames to emit and whether the stream must now fail with the gateway error.
 */
export const endApplyPatchStream = (
  state: TranslationState,
): { readonly chunks: ReadonlyArray<string>; readonly failed: boolean } => {
  const chunks = state.finalizeToolInput?.() ?? [];

  return { chunks, failed: state.toolInputError !== undefined };
};
