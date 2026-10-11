/**
 * `/v8/management/api-keys*` (`ApiKeysGroup` in contract/api-keys.ts): the API keys page's list, group writes and
 * connection test.
 *
 * Workers addition, no Go counterpart (Go's panel edits whole family arrays through `PUT /api-keys` style routes with
 * raw keys). Reads never carry secrets (`api-keys-view.ts`). Writes are semantic, one group at a time, and carry the
 * config `version` of the list they came from: the edit is applied to the stored document and stored with
 * `putConfig(text, version)` and no retry, so a stale view is a `409 conflict` instead of silently overwriting a
 * concurrent change. The edited document is dry-run through the config decoder first, so a group the normaliser
 * would drop (codex without base-url, a duplicate key) is refused with `422` and the reason instead of "succeeding".
 */
import { Effect, Schema } from "effect";
import { HttpRouter, type HttpServerRequest } from "effect/http";
import { decodeConfig } from "../config/codec.ts";
import { decodeStoredConfig } from "../config/store.ts";
import { isJsonObject, type JsonObject } from "../json/index.ts";
import { probeApiKey } from "./api-keys-probe.ts";
import { applyGroupWrite, checkSurvival, type Edit, removeGroup } from "./api-keys-write.ts";
import { configKeyIds } from "./config-document.ts";
import {
  type ApiKeyFamily,
  DeleteGroupRequest,
  ProbeRequest,
  PutGroupRequest,
} from "./contract/api-keys.ts";
import { bodyJson, controlPlane, handled, jsonReply, type Reply, replyError } from "./http.ts";

const BASE = "/v8/management/api-keys";

const invalidBody = () => replyError(400, "invalid body");

/** The request body, decoded with `schema`; the raw JSON is returned for the parts written through untouched. */
const decoded = <S extends Schema.Decoder<unknown>>(
  schema: S,
): Effect.Effect<
  { readonly value: S["Type"]; readonly raw: JsonObject },
  Reply,
  HttpServerRequest.HttpServerRequest
> =>
  Effect.gen(function* () {
    const raw = yield* bodyJson;

    if (!isJsonObject(raw)) return yield* invalidBody();
    const value = yield* Schema.decodeUnknownEffect(schema)(raw).pipe(Effect.mapError(invalidBody));

    return { value, raw };
  });

const conflict = () => replyError(409, "conflict");

/** The stored config at its version, decoded; a failed decode of the stored document is an internal error. */
const storedConfig = Effect.gen(function* () {
  const wire = yield* controlPlane("getConfig", (stub) => stub.getConfig());
  const text = wire.document ?? "{}";

  const config = yield* decodeStoredConfig(text).pipe(
    Effect.mapError(() => replyError(500, "invalid_config")),
  );

  // SAFETY: the stored config document is always a serialized JSON object (writes reject non-objects).
  return { version: wire.version, document: JSON.parse(text) as JsonObject, config };
});

const refuse = <A>(edit: Edit<A>) =>
  edit.ok ? Effect.succeed(edit.value) : Effect.fail(replyError(edit.status, edit.error));

/** Stores `document` at `version` (no retry); answers the new version. */
const store = (document: JsonObject, version: number) =>
  Effect.gen(function* () {
    const result = yield* controlPlane("putConfig", (stub) =>
      stub.putConfig(JSON.stringify(document), version),
    );

    if (result.ok) {
      if (result.notApplied.length > 0) {
        yield* Effect.logWarning("config keys not applied on Workers (see MIGRATION.md)").pipe(
          Effect.annotateLogs({ keys: result.notApplied.join(", ") }),
        );
      }

      return jsonReply(200, { status: "ok", version: result.version });
    }

    if (result.error === "conflict") return yield* conflict();

    return yield* replyError(422, result.message);
  });

const familyCounts = (groups: ReadonlyArray<{ readonly keys: ReadonlyArray<unknown> }>): number[] =>
  groups.map((group) => group.keys.length);

const familyOf = (
  config: {
    readonly "api-keys": Record<
      ApiKeyFamily,
      ReadonlyArray<{ readonly keys: ReadonlyArray<unknown> }>
    >;
  },
  family: ApiKeyFamily,
) => config["api-keys"][family];

const list = Effect.gen(function* () {
  const view = yield* controlPlane("apiKeysView", (stub) => stub.apiKeysView());

  return jsonReply(200, view);
});

const putGroup = Effect.gen(function* () {
  const { value, raw } = yield* decoded(PutGroupRequest);
  const group = raw.group;

  // The decoder accepted `raw`, so `group` is an object.
  if (!isJsonObject(group)) return yield* invalidBody();
  const current = yield* storedConfig;

  if (current.version !== value.version) return yield* conflict();
  const ids = configKeyIds(current.config, { includeDisabledGroups: true });

  const write = yield* refuse(
    applyGroupWrite(current.document, ids, {
      family: value.family,
      ...(value.index === undefined ? {} : { index: value.index }),
      group,
    }),
  );

  // Dry run through the decoder (what the ControlPlane will store): the group must survive normalisation.
  const normalised = yield* decodeConfig(write.document).pipe(
    Effect.mapError((error) => replyError(422, error.message)),
  );

  yield* refuse(
    checkSurvival(
      value.family,
      familyCounts(familyOf(current.config, value.family)),
      familyCounts(familyOf(normalised, value.family)),
      value.index,
      write.group,
    ),
  );

  return yield* store(write.document, value.version);
});

const deleteGroup = Effect.gen(function* () {
  const { value } = yield* decoded(DeleteGroupRequest);
  const current = yield* storedConfig;

  if (current.version !== value.version) return yield* conflict();
  const edited = yield* refuse(removeGroup(current.document, value.family, value.index));

  return yield* store(edited, value.version);
});

const probe = Effect.gen(function* () {
  const { value } = yield* decoded(ProbeRequest);
  const authIndex = value.auth_index.trim();

  if (authIndex === "") return yield* replyError(400, "auth_index is required");

  const resolved = yield* controlPlane("apiKeyProbeTarget", (stub) =>
    stub.apiKeyProbeTarget(authIndex),
  );

  if (!resolved.ok) return yield* replyError(404, "api key not found");
  const result = yield* probeApiKey(resolved.target);

  return jsonReply(200, result);
});

export const apiKeysRoutes = [
  HttpRouter.route("GET", BASE, handled(list)),
  HttpRouter.route("PUT", `${BASE}/groups`, handled(putGroup)),
  HttpRouter.route("DELETE", `${BASE}/groups`, handled(deleteGroup)),
];

/** Needs an `HttpClient` (bound in `routes.ts`). */
export const apiKeyProbeHandler = handled(probe);
