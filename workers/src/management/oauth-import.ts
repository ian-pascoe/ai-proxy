/**
 * `POST /v8/management/oauth/import?provider=vertex`: uploads a Vertex service-account JSON as an auth file.
 *
 * Go source: internal/api/handlers/management/auth_files_v8.go (`ImportOAuthV8`), vertex_import.go
 * (`ImportVertexCredential`, `sanitizeVertexFilePart`, `labelForVertex`), internal/auth/vertex/keyutil.go
 * (`NormalizeServiceAccountMap`). The credential is stored in the ControlPlane like any auth file, merged over an
 * existing file of the same name (`saveTokenRecord` -> `mergeExistingAuthFileMetadata`).
 */
import { Effect } from "effect"
import { HttpRouter, HttpServerRequest } from "effect/http"
import { normalizePrivateKey } from "../credentials/refresh/vertex.ts"
import { isJsonObject, type Json, type JsonObject } from "../json/index.ts"
import { controlPlane, handled, jsonReply, queryParams, replyError } from "./http.ts"

const BASE = "/v8/management/oauth"
const DEFAULT_LOCATION = "us-central1"

/** `valueAsString`. */
const valueAsString = (value: Json | undefined): string => {
  if (value === undefined || value === null) return ""
  return typeof value === "string" ? value : typeof value === "object" ? JSON.stringify(value) : String(value)
}

/** `sanitizeVertexFilePart`. */
const sanitizeFilePart = (value: string): string => {
  const out = value
    .trim()
    .replace(/[/\\:]/g, "_")
    .replaceAll(" ", "-")
  return out === "" ? "vertex" : out
}

/** `labelForVertex`. */
const labelFor = (projectId: string, email: string): string => {
  const project = projectId.trim()
  const mail = email.trim()
  if (project !== "" && mail !== "") return `${project} (${mail})`
  return project !== "" ? project : mail !== "" ? mail : "vertex"
}

/** The first file of the multipart field `file` and the optional `location` form field. */
const readUpload = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest
  if (!(request.headers["content-type"] ?? "").toLowerCase().startsWith("multipart/form-data")) {
    return yield* replyError(400, "file required")
  }
  const web = yield* HttpServerRequest.toWeb(request).pipe(Effect.mapError(() => replyError(400, "file required")))
  const form = yield* Effect.tryPromise({
    try: async () => await web.formData(),
    catch: () => replyError(400, "file required")
  })
  const file = form.getAll("file").find((value) => typeof value !== "string")
  if (file === undefined || typeof file === "string") return yield* replyError(400, "file required")
  const content = yield* Effect.tryPromise({
    try: async () => await file.text(),
    catch: (cause) => replyError(400, `failed to read file: ${cause instanceof Error ? cause.message : "unreadable"}`)
  })
  const location = form.get("location")
  return { content, location: typeof location === "string" ? location.trim() : "" }
})

const importVertex = Effect.gen(function* () {
  const upload = yield* readUpload
  const parsed = yield* Effect.try({
    try: () => JSON.parse(upload.content) as Json,
    catch: (cause) =>
      replyError(400, "invalid json", { message: cause instanceof Error ? cause.message : "invalid json" })
  })
  if (!isJsonObject(parsed)) {
    return yield* replyError(400, "invalid json", { message: "service account must be a JSON object" })
  }
  const privateKey = parsed.private_key
  if (typeof privateKey !== "string" || privateKey.trim() === "") {
    return yield* replyError(400, "invalid service account", { message: "service account missing private_key" })
  }
  const normalized = yield* Effect.promise(async () => await normalizePrivateKey(privateKey))
  if (!normalized.ok) return yield* replyError(400, "invalid service account", { message: normalized.message })
  const serviceAccount: JsonObject = { ...parsed, private_key: normalized.pem }

  const projectId = valueAsString(serviceAccount.project_id).trim()
  if (projectId === "") return yield* replyError(400, "project_id missing")
  const email = valueAsString(serviceAccount.client_email).trim()
  const location = upload.location || (yield* queryParams).get("location")?.trim() || DEFAULT_LOCATION

  const name = `vertex-${sanitizeFilePart(projectId)}.json`
  const label = labelFor(projectId, email)
  const metadata: JsonObject = {
    service_account: serviceAccount,
    project_id: projectId,
    email,
    location,
    type: "vertex",
    label
  }
  const result = yield* controlPlane("importAuthFile", (stub) =>
    stub.importAuthFile(name, metadata, { mergeExisting: true })
  )
  if (!result.ok) return yield* replyError(500, "save_failed", { message: result.message })
  return jsonReply(200, { status: "ok", "auth-file": name, project_id: projectId, email, location })
})

/** `ImportOAuthV8`: dispatches on the `provider` query parameter. */
const importCredential = Effect.gen(function* () {
  const provider = ((yield* queryParams).get("provider") ?? "").trim().toLowerCase()
  if (provider === "") return yield* replyError(400, "provider is required")
  if (provider === "vertex") return yield* importVertex
  return yield* replyError(404, "provider_not_found")
})

export const oauthImportRoutes = [HttpRouter.route("POST", `${BASE}/import`, handled(importCredential))]
