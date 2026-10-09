/**
 * Responses content blocks (image/audio/video/file) -> Gemini parts.
 *
 * Go source: internal/translator/gemini/openai/responses/gemini_openai-responses_request.go
 * (openAIResponses*FromBlock, openAIResponsesPartFromBlock, parseOpenAIResponsesDataURL and MIME helpers).
 * Parts use the snake_case spelling (`inline_data`, `file_data`) like Go; the request translator renames them for
 * function response parts.
 */
import { asString, get, type Json, type JsonObject } from "../../../../json/index.ts"
import { normalizeOpenAIFileData } from "../../common/file-data.ts"
import { MIME_TYPES } from "../../common/mime-types.ts"

export interface MediaBlock {
  readonly mimeType: string
  readonly data: string
}

const mimeFor = (key: string): string => (Object.hasOwn(MIME_TYPES, key) ? (MIME_TYPES[key] as string) : "")

/** `firstNonEmpty`: the first value that is not blank, trimmed. */
export const firstNonEmpty = (...values: string[]): string => {
  for (const value of values) if (value.trim() !== "") return value.trim()
  return ""
}

const isDataUrl = (raw: string): boolean => raw.trim().toLowerCase().startsWith("data:")

const isRemoteUrl = (value: string): boolean => {
  const lower = value.trim().toLowerCase()
  return lower.startsWith("http://") || lower.startsWith("https://") || lower.startsWith("gs://")
}

const isGenericMime = (mimeType: string): boolean => {
  const m = mimeType.trim().toLowerCase()
  return m === "" || m === "application/octet-stream" || m === "binary/octet-stream"
}

const firstNonGenericFormat = (...values: string[]): string => {
  for (const value of values) {
    const trimmed = value.trim()
    if (trimmed !== "" && !isGenericMime(trimmed)) return trimmed
  }
  return ""
}

/** `strings.ToLower(strings.TrimPrefix(filepath.Ext(filename), "."))`. */
const fileExtension = (filename: string): string => {
  const base = filename.slice(filename.lastIndexOf("/") + 1)
  const dot = base.lastIndexOf(".")
  return dot < 0 ? "" : base.slice(dot + 1).toLowerCase()
}

/** `filepath.Base`. */
const pathBase = (path: string): string => {
  if (path === "") return "."
  const stripped = path.replace(/\/+$/, "")
  if (stripped === "") return "/"
  return stripped.slice(stripped.lastIndexOf("/") + 1)
}

const BASE64_STD = /^[A-Za-z0-9+/]*={0,2}$/

const isDecodableBase64 = (payload: string): boolean => {
  // StdEncoding (padded) or RawStdEncoding (unpadded); newlines are ignored like Go's decoder.
  const text = payload.replace(/[\r\n]/g, "")
  if (!BASE64_STD.test(text)) return false
  if (text.includes("=")) return text.length % 4 === 0
  return text.length % 4 !== 1
}

/** `parseOpenAIResponsesDataURL`: base64 data URLs only. */
export const parseDataUrl = (rawUrl: string): MediaBlock | undefined => {
  const trimmedRaw = rawUrl.trim()
  if (trimmedRaw.length < 5 || trimmedRaw.slice(0, 5).toLowerCase() !== "data:") return undefined
  const rest = trimmedRaw.slice(5)
  const comma = rest.indexOf(",")
  if (comma < 0) return undefined
  const metadata = rest.slice(0, comma)
  const payload = rest.slice(comma + 1).trim()
  if (payload === "") return undefined
  const fields = metadata.split(";")
  const mimeType = (fields[0] ?? "").trim()
  if (!fields.slice(1).some((field) => field.trim().toLowerCase() === "base64")) return undefined
  if (!isDecodableBase64(payload)) return undefined
  return { mimeType, data: payload }
}

export const audioMimeType = (audioFormat: string): string => {
  const format = audioFormat.trim()
  if (isGenericMime(format)) return "audio/wav"
  if (format.includes("/")) return format
  const lower = format.toLowerCase()
  switch (lower) {
    case "wav":
      return "audio/wav"
    case "mp3":
    case "mpeg":
      return "audio/mpeg"
    case "ogg":
      return "audio/ogg"
    case "flac":
      return "audio/flac"
    case "aac":
      return "audio/aac"
    case "webm":
      return "audio/webm"
    case "pcm16":
    case "pcm":
      return "audio/pcm"
    case "g711_ulaw":
    case "g711_alaw":
      return "audio/basic"
    case "opus":
      return "audio/opus"
    case "m4a":
      return "audio/mp4"
    case "wma":
      return "audio/x-ms-wma"
    default: {
      const mapped = mimeFor(lower)
      return mapped !== "" && mapped.startsWith("audio/") ? mapped : "audio/wav"
    }
  }
}

export const videoMimeType = (videoFormat: string): string => {
  const format = videoFormat.trim()
  if (isGenericMime(format)) return "video/mp4"
  if (format.includes("/")) return format
  const lower = format.toLowerCase()
  switch (lower) {
    case "mp4":
      return "video/mp4"
    case "webm":
      return "video/webm"
    case "mov":
    case "quicktime":
      return "video/quicktime"
    case "avi":
    case "x-msvideo":
      return "video/x-msvideo"
    case "mpeg":
      return "video/mpeg"
    case "ogg":
      return "video/ogg"
    case "mkv":
    case "x-matroska":
      return "video/x-matroska"
    case "flv":
    case "x-flv":
      return "video/x-flv"
    case "3gpp":
      return "video/3gpp"
    default: {
      const mapped = mimeFor(lower)
      return mapped !== "" && mapped.startsWith("video/") ? mapped : "video/mp4"
    }
  }
}

const normalizeFormatToMime = (formatText: string): string => {
  const format = formatText.trim()
  if (format === "" || isGenericMime(format)) return ""
  if (format.includes("/")) return format
  const lower = format.toLowerCase()
  switch (lower) {
    case "jpg":
    case "jpeg":
      return "image/jpeg"
    case "wav":
      return "audio/wav"
    case "mp3":
      return "audio/mpeg"
    case "mp4":
      return "video/mp4"
    case "webm":
      return "video/webm"
    case "pdf":
      return "application/pdf"
    default:
      return mimeFor(lower)
  }
}

export const imageMimeType = (formatText: string, filename: string): string => {
  const format = formatText.trim()
  if (format !== "" && !isGenericMime(format)) {
    if (format.includes("/")) return format
    const lower = format.toLowerCase()
    if (lower === "jpg" || lower === "jpeg") return "image/jpeg"
    const mapped = mimeFor(lower)
    return mapped !== "" ? mapped : `image/${format}`
  }
  if (filename !== "") {
    const ext = fileExtension(filename)
    if (ext === "jpg" || ext === "jpeg") return "image/jpeg"
    if (ext !== "") {
      const mapped = mimeFor(ext)
      if (mapped !== "") return mapped
    }
  }
  return "image/png"
}

const str = (block: Json | undefined, path: string): string => asString(get(block, path))

/** Resolves a data URL whose MIME type may be generic. */
const resolveDataUrl = (
  url: string,
  format: string,
  filename: string,
  defaultMime: string,
  mimeOfFormat: (format: string) => string
): MediaBlock | undefined => {
  const parsed = parseDataUrl(url)
  if (parsed === undefined) return undefined
  let mimeType = parsed.mimeType
  if (isGenericMime(mimeType)) {
    if (format !== "" && !isGenericMime(format)) mimeType = mimeOfFormat(format)
    else if (filename !== "") mimeType = mimeOfFormat(fileExtension(filename))
    else mimeType = defaultMime
  }
  return { mimeType, data: parsed.data }
}

export const audioFromBlock = (block: Json): MediaBlock | undefined => {
  const bType = str(block, "type").trim().toLowerCase()
  if (bType !== "input_audio" && bType !== "audio") return undefined
  const filename = firstNonEmpty(str(block, "filename"), str(block, "file.filename"))
  let audioObj = get(block, "input_audio")
  if (audioObj === undefined) audioObj = get(block, "audio")
  let audioFormat = firstNonGenericFormat(
    str(audioObj, "format"),
    str(audioObj, "mime_type"),
    str(block, "format"),
    str(block, "mime_type")
  )
  let audioData = str(audioObj, "data")
  if (audioData === "") audioData = str(block, "data")
  if (audioData === "") {
    const audioUrl = firstNonEmpty(str(block, "audio_url.url"), str(block, "audio_url"), str(block, "url"))
    if (audioUrl !== "") {
      if (isDataUrl(audioUrl)) {
        return resolveDataUrl(audioUrl, audioFormat, filename, "audio/wav", audioMimeType)
      } else if (!isRemoteUrl(audioUrl)) {
        let mimeType = audioMimeType(audioFormat)
        if (isGenericMime(audioFormat) && filename !== "") mimeType = audioMimeType(fileExtension(filename))
        return { mimeType, data: audioUrl }
      }
    }
  }
  if (audioData === "" && str(block, "source.type") === "base64") {
    audioData = str(block, "source.data")
    if (audioFormat === "") audioFormat = str(block, "source.media_type")
  }
  if (audioData === "") return undefined
  if (isDataUrl(audioData)) {
    return resolveDataUrl(audioData, audioFormat, filename, "audio/wav", audioMimeType)
  }
  let mimeType = audioMimeType(audioFormat)
  if (isGenericMime(audioFormat) && filename !== "") mimeType = audioMimeType(fileExtension(filename))
  return { mimeType, data: audioData }
}

export const videoFromBlock = (block: Json): MediaBlock | undefined => {
  const bType = str(block, "type").trim().toLowerCase()
  if (bType !== "input_video" && bType !== "video_url" && bType !== "video") return undefined
  const filename = firstNonEmpty(str(block, "filename"), str(block, "file.filename"))
  let videoObj = get(block, "input_video")
  if (videoObj === undefined) videoObj = get(block, "video")
  let format = firstNonGenericFormat(
    str(videoObj, "format"),
    str(videoObj, "mime_type"),
    str(block, "format"),
    str(block, "mime_type")
  )
  const videoUrl = firstNonEmpty(str(block, "video_url.url"), str(block, "video_url"), str(block, "url"))
  if (videoUrl !== "") {
    if (isDataUrl(videoUrl)) {
      return resolveDataUrl(videoUrl, format, filename, "video/mp4", videoMimeType)
    } else if (!isRemoteUrl(videoUrl)) {
      let mimeType = videoMimeType(format)
      if (isGenericMime(format) && filename !== "") mimeType = videoMimeType(fileExtension(filename))
      return { mimeType, data: videoUrl }
    }
  }
  let videoData = str(videoObj, "data")
  if (videoData === "") videoData = str(block, "data")
  if (videoData === "" && str(block, "source.type") === "base64") {
    videoData = str(block, "source.data")
    if (format === "") format = str(block, "source.media_type")
  }
  if (videoData === "") return undefined
  if (isDataUrl(videoData)) {
    return resolveDataUrl(videoData, format, filename, "video/mp4", videoMimeType)
  }
  let mimeType = videoMimeType(format)
  if (isGenericMime(format) && filename !== "") mimeType = videoMimeType(fileExtension(filename))
  return { mimeType, data: videoData }
}

export const imageFromBlock = (block: Json): MediaBlock | undefined => {
  const blockType = str(block, "type").trim().toLowerCase()
  if (blockType !== "input_image" && blockType !== "image_url" && blockType !== "image") return undefined
  let format = firstNonGenericFormat(
    str(block, "format"),
    str(block, "mime_type"),
    str(block, "input_image.format"),
    str(block, "input_image.mime_type"),
    str(block, "image.format"),
    str(block, "image.mime_type")
  )
  const filename = firstNonEmpty(str(block, "filename"), str(block, "file.filename"))
  const imageUrl = firstNonEmpty(str(block, "image_url.url"), str(block, "image_url"), str(block, "url"))
  const fromDataUrl = (url: string): MediaBlock | undefined => {
    const parsed = parseDataUrl(url)
    if (parsed === undefined) return undefined
    return {
      mimeType: isGenericMime(parsed.mimeType) ? imageMimeType(format, filename) : parsed.mimeType,
      data: parsed.data
    }
  }
  if (imageUrl !== "") {
    if (isDataUrl(imageUrl)) return fromDataUrl(imageUrl)
    if (!isRemoteUrl(imageUrl)) return { mimeType: imageMimeType(format, filename), data: imageUrl }
  }
  let imageData = ""
  if (str(block, "source.type") === "base64") {
    imageData = str(block, "source.data")
    if (format === "") format = str(block, "source.media_type")
  }
  if (imageData === "" && get(block, "data") !== undefined) imageData = str(block, "data")
  if (imageData === "") return undefined
  if (isDataUrl(imageData)) return fromDataUrl(imageData)
  return { mimeType: imageMimeType(format, filename), data: imageData }
}

export const fileFromBlock = (block: Json): MediaBlock | undefined => {
  const bType = str(block, "type").trim().toLowerCase()
  if (bType !== "input_file" && bType !== "file") return undefined
  const filename = firstNonEmpty(str(block, "filename"), str(block, "file.filename"))
  let fileData = firstNonEmpty(str(block, "file_data"), str(block, "file.file_data"), str(block, "data"))
  if (fileData === "") {
    const fileUrl = firstNonEmpty(
      str(block, "file_url.url"),
      str(block, "file_url"),
      str(block, "file.file_url"),
      str(block, "url")
    )
    if (isDataUrl(fileUrl)) fileData = fileUrl
  }
  let fallbackMime = firstNonGenericFormat(
    str(block, "mime_type"),
    str(block, "file.mime_type"),
    str(block, "format"),
    str(block, "file.format")
  )
  if (fallbackMime !== "") fallbackMime = normalizeFormatToMime(fallbackMime)
  if (isGenericMime(fallbackMime) && filename !== "") {
    const ext = fileExtension(filename)
    if (ext !== "") fallbackMime = normalizeFormatToMime(ext)
  }
  if (isDataUrl(fileData)) {
    const parsed = parseDataUrl(fileData)
    if (parsed === undefined) return undefined
    let mimeType = parsed.mimeType
    if (isGenericMime(mimeType) && fallbackMime !== "") mimeType = fallbackMime
    if (isGenericMime(mimeType) && filename !== "") {
      const ext = fileExtension(filename)
      if (ext !== "") {
        const normalized = normalizeFormatToMime(ext)
        if (normalized !== "") mimeType = normalized
      }
    }
    if (isGenericMime(mimeType)) mimeType = "application/octet-stream"
    return { mimeType, data: parsed.data }
  }
  return normalizeOpenAIFileData(filename, fallbackMime, fileData)
}

/** `openAIResponsesMediaFromBlock`. */
export const mediaFromBlock = (block: Json): MediaBlock | undefined =>
  imageFromBlock(block) ?? audioFromBlock(block) ?? videoFromBlock(block) ?? fileFromBlock(block)

export const inlineDataPart = (mimeType: string, data: string): JsonObject => ({
  inline_data: { mime_type: mimeType, data }
})

export const fileDataPart = (mimeType: string, fileUri: string): JsonObject => ({
  file_data: { mime_type: mimeType, file_uri: fileUri }
})

const remoteFilename = (rawUrl: string, block: Json): string => {
  const filename = firstNonEmpty(str(block, "filename"), str(block, "file.filename"))
  if (filename !== "") return filename
  try {
    const parsed = new URL(rawUrl)
    let path = parsed.pathname
    try {
      path = decodeURIComponent(path)
    } catch {
      // keep the encoded path
    }
    return pathBase(path)
  } catch {
    return ""
  }
}

/** `openAIResponsesPartFromBlock`: remote URLs become `file_data`, inline/base64 content `inline_data`. */
export const partFromBlock = (block: Json): JsonObject | undefined => {
  const bType = str(block, "type").trim().toLowerCase()
  const rawUrl = firstNonEmpty(
    str(block, "video_url.url"),
    str(block, "video_url"),
    str(block, "audio_url.url"),
    str(block, "audio_url"),
    str(block, "image_url.url"),
    str(block, "image_url"),
    str(block, "file_url.url"),
    str(block, "file_url"),
    str(block, "file.file_url"),
    str(block, "url")
  )
  if (isRemoteUrl(rawUrl)) {
    const filename = remoteFilename(rawUrl, block)
    const format = firstNonGenericFormat(
      str(block, "format"),
      str(block, "mime_type"),
      str(block, "input_video.format"),
      str(block, "input_video.mime_type"),
      str(block, "video.format"),
      str(block, "video.mime_type"),
      str(block, "input_audio.format"),
      str(block, "input_audio.mime_type"),
      str(block, "audio.format"),
      str(block, "audio.mime_type"),
      str(block, "input_image.format"),
      str(block, "input_image.mime_type"),
      str(block, "image.format"),
      str(block, "image.mime_type"),
      str(block, "file.format"),
      str(block, "file.mime_type")
    )
    let mimeType = ""
    switch (bType) {
      case "input_video":
      case "video_url":
      case "video":
        if (format !== "" && !isGenericMime(format)) mimeType = videoMimeType(format)
        else if (filename !== "") {
          const ext = fileExtension(filename)
          if (ext !== "") mimeType = videoMimeType(ext)
        }
        if (isGenericMime(mimeType)) mimeType = "video/mp4"
        break
      case "input_audio":
      case "audio":
        if (format !== "" && !isGenericMime(format)) mimeType = audioMimeType(format)
        else if (filename !== "") {
          const ext = fileExtension(filename)
          if (ext !== "") mimeType = audioMimeType(ext)
        }
        if (isGenericMime(mimeType)) mimeType = "audio/wav"
        break
      case "input_image":
      case "image_url":
      case "image":
        mimeType = imageMimeType(format, filename)
        break
      default:
        if (format !== "") mimeType = normalizeFormatToMime(format)
        if (isGenericMime(mimeType) && filename !== "") {
          const ext = fileExtension(filename)
          if (ext !== "") mimeType = normalizeFormatToMime(ext)
        }
        if (isGenericMime(mimeType)) mimeType = "application/octet-stream"
    }
    return fileDataPart(mimeType, rawUrl)
  }
  const media = mediaFromBlock(block)
  return media === undefined ? undefined : inlineDataPart(media.mimeType, media.data)
}
