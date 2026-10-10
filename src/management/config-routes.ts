/**
 * `/v8/management/config`, `/config.yaml` and `/config/*path`.
 *
 * Go source: internal/api/handlers/management/config_v8.go (`ConfigV8`), server_management_v8.go (route table). The
 * document is the ControlPlane's canonical config (all defaults included); `config.yaml` is the sparse YAML export.
 * Writes are read-modify-write with the stored version as `expectedVersion` (retried on a concurrent write), and the
 * ControlPlane validates and normalises the result: invalid documents answer `422 invalid_config`.
 */
import { Effect } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { parseConfigYaml, stringifyConfigYaml } from "../config/codec.ts";
import { decodeStoredConfig } from "../config/store.ts";
import { isJsonObject, type Json, type JsonObject } from "../json/index.ts";
import {
  deleteAtPath,
  getAtPath,
  injectAuthIndexes,
  parseConfigPath,
  stripAuthIndexes,
  writeAtPath,
} from "./config-document.ts";
import { bodyText, controlPlane, handled, jsonReply, Reply, replyError } from "./http.ts";

const PREFIX = "/v8/management/config";

const MAX_ATTEMPTS = 4;

const pathRemainder = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;

  return new URL(request.originalUrl, "http://localhost").pathname.slice(PREFIX.length);
});

const storedDocument = Effect.gen(function* () {
  const wire = yield* controlPlane("getConfig", (stub) => stub.getConfig());
  const text = wire.document ?? "{}";

  return { version: wire.version, text, document: JSON.parse(text) as JsonObject };
});

const decodeConfig = (text: string) =>
  decodeStoredConfig(text).pipe(Effect.mapError(() => replyError(500, "invalid_config")));

const readPath = (rest: string) => {
  const parts = parseConfigPath(rest);

  return parts === undefined ? Effect.fail(replyError(400, "invalid_path")) : Effect.succeed(parts);
};

const okReply = jsonReply(200, { status: "ok", "config-version": 8 });

/** Stores `text`; `conflict` is reported to the caller so read-modify-write loops can retry. */
const store = (text: string, expectedVersion: number | undefined) =>
  controlPlane("putConfig", (stub) => stub.putConfig(text, expectedVersion)).pipe(
    Effect.flatMap((result) => {
      if (result.ok) {
        // Go config files often carry keys that do nothing on Workers; say so instead of silently ignoring them.
        const { notApplied } = result;

        return notApplied.length === 0
          ? Effect.succeed("saved" as const)
          : Effect.logWarning("config keys not applied on Workers (see MIGRATION.md)").pipe(
              Effect.annotateLogs({ keys: notApplied.join(", ") }),
              Effect.as("saved" as const),
            );
      }

      if (result.error === "conflict") return Effect.succeed("conflict" as const);

      return Effect.fail(replyError(422, "invalid_config", { message: result.message }));
    }),
  );

const conflict = replyError(409, "conflict", { message: "config changed concurrently, retry" });

/** Read-modify-write of the document (`edit` returns a reply to abort, or the new document). */
const modify = (edit: (document: JsonObject) => JsonObject | Reply) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const current = yield* storedDocument;
      const edited = edit(current.document);

      if (edited instanceof Reply) return yield* edited;
      const outcome = yield* store(JSON.stringify(stripAuthIndexes(edited)), current.version);

      if (outcome === "saved") return okReply;
    }

    return yield* conflict;
  });

const getConfig = (yaml: boolean) =>
  Effect.gen(function* () {
    const rest = yaml ? "" : yield* pathRemainder;
    const parts = yield* readPath(rest);
    const current = yield* storedDocument;

    if (yaml) {
      const config = yield* decodeConfig(current.text);

      return HttpServerResponse.text(stringifyConfigYaml(config), {
        contentType: "application/yaml; charset=utf-8",
      });
    }

    const config = yield* decodeConfig(current.text);
    const document = injectAuthIndexes(current.document, config);
    const value = getAtPath(document, parts);

    if (value === undefined) return yield* replyError(404, "not_found");

    return jsonReply(200, value);
  });

/** Parses a JSON request body (`invalid_json` when the text is not valid JSON). */
const jsonValue = Effect.gen(function* () {
  const text = yield* bodyText;

  return yield* Effect.try({
    try: () => JSON.parse(text) as Json,
    catch: () => replyError(400, "invalid_json"),
  });
});

const writeConfig = (mode: "put" | "patch", yaml: boolean) =>
  Effect.gen(function* () {
    if (yaml) {
      const text = yield* bodyText;
      // Validate before storing so a malformed document answers the same way as a bad JSON write.
      const parsed = yield* Effect.result(parseConfigYaml(text));

      if (parsed._tag === "Failure")
        return yield* replyError(422, "invalid_config", { message: parsed.failure.message });
      const outcome = yield* store(text, undefined);

      return outcome === "saved" ? okReply : yield* conflict;
    }

    const parts = yield* readPath(yield* pathRemainder);
    const value = yield* jsonValue;

    if (parts.length === 0 && !isJsonObject(value))
      return yield* replyError(400, "config_must_be_object");

    if (parts.length === 0 && mode === "put") {
      const outcome = yield* store(
        JSON.stringify(stripAuthIndexes(value as JsonObject)),
        undefined,
      );

      return outcome === "saved" ? okReply : yield* conflict;
    }

    return yield* modify((document) => {
      const written = writeAtPath(document, parts, value, mode);

      return written === "invalid_path" ? replyError(400, "invalid_path") : written;
    });
  });

const deleteConfig = Effect.gen(function* () {
  const parts = yield* readPath(yield* pathRemainder);

  if (parts.length === 0) return yield* replyError(400, "cannot_delete_config");

  return yield* modify((document) => deleteAtPath(document, parts) ?? replyError(404, "not_found"));
});

const routes = (
  path: `/${string}`,
  yaml: boolean,
  methods: ReadonlyArray<"GET" | "PUT" | "PATCH" | "DELETE">,
) =>
  methods.map((method) => {
    const handler =
      method === "GET"
        ? getConfig(yaml)
        : method === "PUT"
          ? writeConfig("put", yaml)
          : method === "PATCH"
            ? writeConfig("patch", yaml)
            : deleteConfig;

    return HttpRouter.route(method, path, handled(handler));
  });

// A `/*` route also answers its bare prefix (`/config`), so one route per method family covers whole-document and
// path-addressed access.
export const configRoutes = [
  ...routes(`${PREFIX}.yaml`, true, ["GET", "PUT"]),
  ...routes(`${PREFIX}/*`, false, ["GET", "PUT", "PATCH", "DELETE"]),
];
