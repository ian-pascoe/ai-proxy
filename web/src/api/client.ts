// The typed management API client (generated from the shared contract) and the atoms the pages read. Calls go to the
// panel's own origin; Cloudflare Access authenticates them with the session cookie, so no credentials live here.
import { Clock, Duration, Effect } from "effect";
import { FetchHttpClient } from "effect/http";
import { Atom, AtomHttpApi } from "effect/reactivity";
import { ManagementApi } from "#contract/api.ts";
import { HISTORY_SPAN_MS } from "../lib/history.ts";

export class ManagementClient extends AtomHttpApi.Service<ManagementClient>()(
  "cliproxy/ManagementClient",
  {
    api: ManagementApi,
    httpClient: FetchHttpClient.layer,
    baseUrl: window.location.origin,
  },
) {}

/** How long a page's data stays cached after its last reader unmounts (switching pages does not refetch). */
const KEEP = Duration.minutes(5);

/** Every query that reads credentials refetches after a mutation tagged with this key. */
export const CREDENTIALS = ["credentials"] as const;

/** Every credential with its state (`GET /credentials`). */
export const credentialsAtom = ManagementClient.query("credentials", "list", {
  reactivityKeys: CREDENTIALS,
  timeToLive: KEEP,
});

const DAY_MS = 24 * 60 * 60 * 1000;

/** Usage of the last 24 hours by model; the window is recomputed on every refresh. */
export const usageLastDayAtom = ManagementClient.runtime
  .atom(
    Effect.gen(function* () {
      const client = yield* ManagementClient;
      const now = yield* Clock.currentTimeMillis;

      return yield* client.usage.summary({ query: { group_by: "model", since: now - DAY_MS } });
    }),
  )
  .pipe(Atom.setIdleTTL(KEEP));

/** One account's hourly usage over the history span (credential id), for its window history. */
export const accountSeriesAtom = Atom.family((authId: string) =>
  ManagementClient.runtime
    .atom(
      Effect.gen(function* () {
        const client = yield* ManagementClient;
        const now = yield* Clock.currentTimeMillis;
        const since = now - HISTORY_SPAN_MS;

        const series = yield* client.usage.series({
          query: { since, bucket: "hour", group_by: "auth", auth_id: authId },
        });

        return {
          since,
          points: series.series.find((entry) => entry.key === authId)?.points ?? [],
        };
      }),
    )
    .pipe(Atom.setIdleTTL(KEEP)),
);

/** The models one account can serve (credential name), read when the operator opens the list. */
export const accountModelsAtom = Atom.family((name: string) =>
  ManagementClient.query("credentials", "models", {
    query: { name },
    timeToLive: KEEP,
  }),
);

// Mutations: call with `reactivityKeys: CREDENTIALS` so the credential list refetches afterwards.
export const setDisabledAtom = ManagementClient.mutation("credentials", "setDisabled");

export const patchFieldsAtom = ManagementClient.mutation("credentials", "patchFields");

export const refreshAtom = ManagementClient.mutation("credentials", "refresh");

export const resetCooldownAtom = ManagementClient.mutation("credentials", "resetCooldown");

export const removeAtom = ManagementClient.mutation("credentials", "remove");

export const uploadAtom = ManagementClient.mutation("credentials", "upload");

export const checkQuotaAtom = ManagementClient.mutation("credentials", "checkQuota");

export const oauthStartAtom = ManagementClient.mutation("oauth", "start");

export const oauthStatusAtom = ManagementClient.mutation("oauth", "status");

export const oauthCancelAtom = ManagementClient.mutation("oauth", "cancel");

export const oauthCallbackAtom = ManagementClient.mutation("oauth", "callback");

/** The current time, ticking every 30 seconds while something reads it ("resets in" countdowns). */
export const nowAtom = Atom.make((get) => {
  const timer = setInterval(() => get.setSelf(Date.now()), 30_000);
  get.addFinalizer(() => clearInterval(timer));

  return Date.now();
});
