/**
 * `POST /v8/management/credentials/quota` (`checkQuota` in contract/credentials.ts): checks one auth file's
 * allowance at the provider's usage endpoint now and answers with the stored report.
 *
 * Workers addition, no Go counterpart: the upstream panel calls the usage endpoints from the browser through
 * `POST /requests/api-call` (see docs/ARCHITECTURE.md "Quota check"). Tokens never leave the server; an upstream
 * failure is a 200 whose report carries `error` (and keeps the last successful windows).
 */
import { Effect } from "effect";
import type { Json } from "../json/index.ts";
import { checkCredentialQuota } from "../quota/check.ts";
import { bodyObject, handled, jsonReply, replyError } from "./http.ts";

const text = (value: Json | undefined): string => (typeof value === "string" ? value.trim() : "");

const checkQuota = Effect.gen(function* () {
  const body = yield* bodyObject;
  const name = text(body.name);
  const authIndex = text(body.auth_index);

  if (name === "") return yield* replyError(400, "name is required");

  const result = yield* checkCredentialQuota({
    name,
    ...(authIndex === "" ? {} : { authIndex }),
  }).pipe(
    Effect.catchTag("QuotaControlPlaneError", (error) =>
      Effect.logError(`management ${error.operation} failed: ${error.message}`).pipe(
        Effect.andThen(Effect.fail(replyError(502, "control plane unavailable"))),
      ),
    ),
  );

  switch (result.kind) {
    case "checked":
      return jsonReply(200, { status: "ok", report: result.report });
    case "not_found":
      return yield* replyError(404, "auth file not found");
    case "unsupported":
      return yield* replyError(422, `quota check is not supported for ${result.provider}`);
  }
});

/** Needs an `HttpClient` (bound in `routes.ts`). */
export const quotaCheckHandler = handled(checkQuota);
