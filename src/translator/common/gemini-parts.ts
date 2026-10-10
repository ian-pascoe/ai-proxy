/**
 * Gemini part helpers.
 *
 * Go source: internal/translator/common/gemini.go.
 */
import { asBool, get, type Json } from "../../json/index.ts";

/** `IsGeminiThoughtPart`: the part carries hidden model thought. */
export const isGeminiThoughtPart = (part: Json | undefined): boolean =>
  asBool(get(part, "thought"));
