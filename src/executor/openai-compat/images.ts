/**
 * OpenAI-compatible Images API requests (`openai-image` source format): `/images/generations` and `/images/edits`.
 *
 * Go source: internal/runtime/executor/openai_compat_executor.go (openAICompatImageEndpointPath,
 * prepareOpenAICompatImagesPayload, executeImages, executeImagesStream) and sdk/api/handlers/openai/
 * openai_images_handlers.go (buildOpenAICompatImagesMultipartRequest).
 *
 * Difference from Go: the handler converts multipart edit uploads to the JSON edit form (`images[].image_url`,
 * `mask.image_url`) before execution, so the multipart body that Go forwards byte for byte is rebuilt here from that
 * JSON form (original file names are not kept; uploads are named after their MIME type).
 */
import {
  asString,
  get,
  type Json,
  type JsonObject,
  isJsonArray,
  isJsonObject,
} from "../../json/index.ts";

export const IMAGES_GENERATIONS_PATH = "/images/generations";

export const IMAGES_EDITS_PATH = "/images/edits";

/** `openAICompatImageEndpointPath`: edits when the inbound path says so, generations otherwise. */
export const compatImageEndpointPath = (requestPath: string): string =>
  requestPath.endsWith(IMAGES_EDITS_PATH) ? IMAGES_EDITS_PATH : IMAGES_GENERATIONS_PATH;

/** `prepareOpenAICompatImagesPayload` (JSON form): model forced, `stream: true` or removed. */
export const prepareCompatImagesBody = (
  payload: Json,
  model: string,
  stream: boolean,
): JsonObject => {
  const body: JsonObject = isJsonObject(payload) ? { ...payload } : {};

  if (model.trim() !== "") body["model"] = model.trim();

  if (stream) body["stream"] = true;
  else delete body["stream"];

  return body;
};

/** Edits are re-encoded as multipart unless the client sent JSON (an empty content type counts as multipart). */
export const wantsMultipartEdit = (endpoint: string, contentType: string): boolean =>
  endpoint === IMAGES_EDITS_PATH &&
  !contentType.trim().toLowerCase().startsWith("application/json");

const EXTENSIONS = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/webp", "webp"],
  ["image/gif", "gif"],
]);

const dataUrlBlob = (
  value: string,
  index: number,
): { readonly blob: Blob; readonly filename: string } | undefined => {
  const match = /^data:([^;,]*)((?:;[^;,]*)*),(.*)$/s.exec(value);

  if (match === null) return undefined;
  const mime = (match[1] ?? "").trim() || "application/octet-stream";
  const isBase64 = (match[2] ?? "").toLowerCase().split(";").includes("base64");

  try {
    const raw = isBase64 ? atob(match[3] ?? "") : decodeURIComponent(match[3] ?? "");
    const bytes = new Uint8Array(raw.length);

    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);

    return {
      blob: new Blob([bytes], { type: mime }),
      filename: `image-${index}.${EXTENSIONS.get(mime) ?? "bin"}`,
    };
  } catch {
    return undefined;
  }
};

/** `buildOpenAICompatImagesMultipartRequest`: the JSON edit form back to `multipart/form-data` (model, stream first). */
export const editBodyToFormData = (body: JsonObject, model: string, stream: boolean): FormData => {
  const form = new FormData();
  form.append("model", model);

  if (stream) form.append("stream", "true");
  let index = 0;

  for (const [key, value] of Object.entries(body)) {
    if (key === "model" || key === "stream") continue;

    if (key === "images" && isJsonArray(value)) {
      for (const image of value) {
        const file = dataUrlBlob(asString(get(image, "image_url")), index++);

        if (file !== undefined) form.append("image[]", file.blob, file.filename);
      }

      continue;
    }

    if (key === "mask" && isJsonObject(value)) {
      const file = dataUrlBlob(asString(value["image_url"]), index++);

      if (file !== undefined) form.append("mask", file.blob, file.filename);
      const fileId = asString(value["file_id"]);

      if (fileId !== "") form.append("mask[file_id]", fileId);
      continue;
    }

    form.append(key, typeof value === "string" ? value : JSON.stringify(value));
  }

  return form;
};
