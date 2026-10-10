/**
 * The management API's error body: every handler answers failures as `{"error": "<message>"}` (Go's
 * `c.JSON(status, gin.H{"error": ...})`, see `../http.ts`). Shared with the browser: imports `effect` only.
 */
import { Schema } from "effect";
import { HttpApiSchema } from "effect/http-api";

export class ManagementError extends Schema.Error<ManagementError>("ManagementError")({
  error: Schema.String,
}) {}

/** Statuses the management handlers answer with an error body; the client decodes each into `ManagementError`. */
const ERROR_STATUSES = [400, 401, 403, 404, 409, 413, 415, 422, 500, 502, 503] as const;

/** Error schemas of a management endpoint (one per status: the client picks a decoder by status code). */
export const managementErrors = ERROR_STATUSES.map((status) =>
  ManagementError.pipe(HttpApiSchema.status(status)),
);
