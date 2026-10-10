/**
 * Default Gemini safety settings.
 *
 * Go source: internal/translator/gemini/common/safety.go (DefaultSafetySettings, AttachDefaultSafetySettings).
 */
import { get, type Json, set } from "../../../json/index.ts";

export const defaultSafetySettings = (): Json[] => [
  { category: "HARM_CATEGORY_HARASSMENT", threshold: "OFF" },
  { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "OFF" },
  { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "OFF" },
  { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "OFF" },
  { category: "HARM_CATEGORY_CIVIC_INTEGRITY", threshold: "BLOCK_NONE" },
];

/** Attaches the default safety settings at `path` (e.g. `safetySettings`) when absent. */
export const attachDefaultSafetySettings = (body: Json, path: string): Json =>
  get(body, path) !== undefined ? body : set(body, path, defaultSafetySettings());
