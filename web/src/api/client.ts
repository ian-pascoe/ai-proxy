// The typed management API client (generated from the shared contract) and the atoms the pages read. Calls go to the
// panel's own origin; Cloudflare Access authenticates them with the session cookie, so no credentials live here.
import { Clock, Duration, Effect } from "effect";
import { FetchHttpClient } from "effect/http";
import { Atom, AtomHttpApi } from "effect/reactivity";
import { ManagementApi } from "#contract/api.ts";
import { HISTORY_SPAN_MS } from "../lib/history.ts";
import {
  type Breakdown,
  filterQuery,
  mergePoints,
  type RangeId,
  rangeOf,
  rangeStart,
  type UsageFilters,
} from "../lib/usage.ts";

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

/**
 * Bumped by the shell's Refresh button: the usage atoms read it, so they refetch (keeping their figures while they
 * load) and recompute their time range.
 */
export const usageEpochAtom = Atom.make(0).pipe(Atom.keepAlive);

/** Usage of the last 24 hours by model; the window is recomputed on every refresh. */
export const usageLastDayAtom = ManagementClient.runtime
  .atom((get) =>
    Effect.gen(function* () {
      get(usageEpochAtom);
      const client = yield* ManagementClient;
      const now = yield* Clock.currentTimeMillis;

      return yield* client.usage.summary({ query: { group_by: "model", since: now - DAY_MS } });
    }),
  )
  .pipe(Atom.setIdleTTL(KEEP));

/** What the Usage page shows: a range and filters (atom family keys compare structurally). */
export interface UsageView {
  readonly range: RangeId;
  readonly filters: UsageFilters;
}

/** Totals and one breakdown over a range. */
export const usageSummaryAtom = Atom.family(
  (key: { readonly view: UsageView; readonly by: Breakdown["id"] }) =>
    ManagementClient.runtime
      .atom((get) =>
        Effect.gen(function* () {
          get(usageEpochAtom);
          const client = yield* ManagementClient;
          const now = yield* Clock.currentTimeMillis;

          return yield* client.usage.summary({
            query: {
              group_by: key.by,
              since: rangeStart(rangeOf(key.view.range), now),
              ...filterQuery(key.view.filters),
            },
          });
        }),
      )
      .pipe(Atom.setIdleTTL(KEEP)),
);

/** Hourly points over a range, every series summed, with the time they were read at (the chart's "now"). */
export const usageSeriesAtom = Atom.family((view: UsageView) =>
  ManagementClient.runtime
    .atom((get) =>
      Effect.gen(function* () {
        get(usageEpochAtom);
        const client = yield* ManagementClient;
        const now = yield* Clock.currentTimeMillis;
        const { model, provider, auth_id } = filterQuery(view.filters);

        // The series has no principal filter: the page shows no chart while a user filter is set.
        const series = yield* client.usage.series({
          query: {
            since: rangeStart(rangeOf(view.range), now),
            bucket: "hour",
            group_by: "provider",
            ...(model === undefined ? {} : { model }),
            ...(provider === undefined ? {} : { provider }),
            ...(auth_id === undefined ? {} : { auth_id }),
          },
        });

        return { now, points: mergePoints(series.series) };
      }),
    )
    .pipe(Atom.setIdleTTL(KEEP)),
);

/** Records per page of the request log. */
export const LOG_PAGE_SIZE = 50;

/** One page of the request log, newest first; `before` is the previous page's `next_before`. */
export const usageRecordsAtom = Atom.family(
  (key: {
    readonly view: UsageView;
    readonly failedOnly: boolean;
    readonly before: string | undefined;
  }) =>
    ManagementClient.runtime
      .atom((get) =>
        Effect.gen(function* () {
          get(usageEpochAtom);
          const client = yield* ManagementClient;
          const now = yield* Clock.currentTimeMillis;

          return yield* client.usage.records({
            query: {
              since: rangeStart(rangeOf(key.view.range), now),
              limit: LOG_PAGE_SIZE,
              ...filterQuery(key.view.filters),
              ...(key.failedOnly ? { failed: "true" as const } : {}),
              ...(key.before === undefined ? {} : { before: key.before }),
            },
          });
        }),
      )
      .pipe(Atom.setIdleTTL(KEEP)),
);

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

/** The API keys page refetches after a mutation tagged with this key. */
export const API_KEYS = ["api-keys"] as const;

/** Every configured API key group with its keys' state and the config version writes send back. */
export const apiKeysAtom = ManagementClient.query("apiKeys", "list", {
  reactivityKeys: API_KEYS,
  timeToLive: KEEP,
});

// Group writes: call with `reactivityKeys: API_KEYS`.
export const putKeyGroupAtom = ManagementClient.mutation("apiKeys", "putGroup");

export const deleteKeyGroupAtom = ManagementClient.mutation("apiKeys", "deleteGroup");

/**
 * One connection test per key (`auth_index`; call it with no argument). `mutation` atoms are shared per endpoint and
 * keep one call at a time, so keys tested together would read each other's answers.
 */
export const probeKeyAtom = Atom.family((authIndex: string) =>
  ManagementClient.runtime.fn(() =>
    Effect.gen(function* () {
      const client = yield* ManagementClient;

      return yield* client.apiKeys.probe({ payload: { auth_index: authIndex } });
    }),
  ),
);

// Mutations: call with `reactivityKeys: CREDENTIALS` so the credential list refetches afterwards (`API_KEYS` for a
// config API key).
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
