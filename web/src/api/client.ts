// The typed management API client (generated from the shared contract) and the atoms the pages read. Calls go to the
// panel's own origin; Cloudflare Access authenticates them with the session cookie, so no credentials live here.
import { Clock, Duration, Effect } from "effect";
import { FetchHttpClient } from "effect/http";
import { Atom, AtomHttpApi } from "effect/reactivity";
import { ManagementApi } from "#contract/api.ts";

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

/** Every credential with its state (`GET /credentials`). */
export const credentialsAtom = ManagementClient.query("credentials", "list", {
  reactivityKeys: ["credentials"],
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

/** The current time, ticking every 30 seconds while something reads it ("resets in" countdowns). */
export const nowAtom = Atom.make((get) => {
  const timer = setInterval(() => get.setSelf(Date.now()), 30_000);
  get.addFinalizer(() => clearInterval(timer));

  return Date.now();
});
