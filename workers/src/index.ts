import { DurableObject } from "cloudflare:workers"
import { ControlPlane } from "./credentials/control-plane.ts"
import { makeWebHandler } from "./http/app.ts"
import { requestContext } from "./platform/env.ts"

// The handler (and its router) is built once per isolate; `env`/`ctx` are provided per request.
const { handler } = makeWebHandler()

export { ControlPlane }

/** Stub: per-session reasoning replay caches and Responses WebSocket state. Filled in by later slices. */
export class SessionState extends DurableObject<Env> {}

export default {
  fetch: (request, env, ctx) => handler(request, requestContext(env, ctx)),
  // Placeholder: model catalog refresh and credential refresh sweep.
  scheduled: async () => {}
} satisfies ExportedHandler<Env>
