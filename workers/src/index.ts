import { DurableObject } from "cloudflare:workers"
import { makeWebHandler } from "./http/app.ts"
import { requestContext } from "./platform/env.ts"

// The handler (and its router) is built once per isolate; `env`/`ctx` are provided per request.
const { handler } = makeWebHandler()

/** Stub: credential, config and cooldown state (see docs/workers-port/ARCHITECTURE.md). Filled in by later slices. */
export class ControlPlane extends DurableObject<Env> {}

/** Stub: per-session reasoning replay caches and Responses WebSocket state. Filled in by later slices. */
export class SessionState extends DurableObject<Env> {}

export default {
  fetch: (request, env, ctx) => handler(request, requestContext(env, ctx)),
  // Placeholder: model catalog refresh and credential refresh sweep.
  scheduled: async () => {}
} satisfies ExportedHandler<Env>
