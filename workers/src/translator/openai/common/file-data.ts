/** Go source: internal/translator/common/file_data.go (NormalizeOpenAIFileData). */
import { MIME_TYPES } from "./mime-types.ts"

export interface NormalizedFileData {
  readonly mimeType: string
  readonly data: string
}

/** Returns the MIME type and raw base64 payload for OpenAI file content, or `undefined` when unusable. */
export const normalizeOpenAIFileData = (
  filename: string,
  fallbackMimeType: string,
  fileData: string
): NormalizedFileData | undefined => {
  if (fileData === "") return undefined
  let fallback = fallbackMimeType
  if (fallback === "") {
    const dot = filename.lastIndexOf(".")
    const ext = dot >= 0 ? filename.slice(dot + 1).toLowerCase() : ""
    fallback = MIME_TYPES[ext] ?? ""
  }
  const prefix = "data:"
  if (fileData.length < prefix.length || fileData.slice(0, prefix.length).toLowerCase() !== prefix) {
    return fallback === "" ? undefined : { mimeType: fallback, data: fileData }
  }
  const rest = fileData.slice(prefix.length)
  const comma = rest.indexOf(",")
  if (comma < 0) return undefined
  const metadata = rest.slice(0, comma)
  const payload = rest.slice(comma + 1)
  if (payload === "") return undefined
  const fields = metadata.split(";")
  const mimeType = (fields[0] as string).trim()
  if (mimeType === "") return undefined
  for (const field of fields.slice(1)) {
    if (field.trim().toLowerCase() === "base64") return { mimeType, data: payload }
  }
  return undefined
}
