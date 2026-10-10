import { Schema } from "effect"

/**
 * Base tagged errors shared by all slices.
 *
 * Messages are returned to clients through protocol-specific formatters, so they must never contain
 * credentials, tokens or JWTs.
 */

/** A required binding, secret or configuration value is missing or invalid. */
export class ConfigurationError extends Schema.TaggedError<ConfigurationError>()("ConfigurationError", {
  message: Schema.String
}) {}

/** The request is malformed; maps to HTTP 400. */
export class BadRequestError extends Schema.TaggedError<BadRequestError>()("BadRequestError", {
  message: Schema.String
}) {}

/** Authentication failed or was not provided; maps to HTTP 401. */
export class UnauthorizedError extends Schema.TaggedError<UnauthorizedError>()("UnauthorizedError", {
  message: Schema.String
}) {}

/** The caller is authenticated but not allowed; maps to HTTP 403. */
export class ForbiddenError extends Schema.TaggedError<ForbiddenError>()("ForbiddenError", {
  message: Schema.String
}) {}

/** The requested resource does not exist; maps to HTTP 404. */
export class NotFoundError extends Schema.TaggedError<NotFoundError>()("NotFoundError", {
  message: Schema.String
}) {}

/** Unexpected failure; maps to HTTP 500. The cause is logged, never returned to the client. */
export class InternalError extends Schema.TaggedError<InternalError>()("InternalError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect())
}) {}
