/** Gemini API-key, Gemini Interactions and Vertex executors. */
import { makeGoogleExecutor } from "./google.ts"
import { geminiVariant, vertexVariant } from "./targets.ts"

export const makeGeminiExecutor = () => makeGoogleExecutor(geminiVariant("gemini"))
export const makeGeminiInteractionsExecutor = () => makeGoogleExecutor(geminiVariant("gemini-interactions"))
export const makeVertexExecutor = () => makeGoogleExecutor(vertexVariant)
