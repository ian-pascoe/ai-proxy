import { Schema } from "effect";

/** The config document (YAML or JSON) is malformed or fails validation; maps to HTTP 400 in management. */
export class ConfigValidationError extends Schema.TaggedError<ConfigValidationError>()(
  "ConfigValidationError",
  {
    message: Schema.String,
  },
) {}

/** The ControlPlane Durable Object could not be reached or returned an unusable config snapshot. */
export class ConfigStoreError extends Schema.TaggedError<ConfigStoreError>()("ConfigStoreError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

/** `putConfig` was called with a stale `expectedVersion`. */
export class ConfigVersionConflict extends Schema.TaggedError<ConfigVersionConflict>()(
  "ConfigVersionConflict",
  {
    message: Schema.String,
    currentVersion: Schema.Number,
  },
) {}
