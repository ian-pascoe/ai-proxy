import { ControlPlane } from "./credentials/control-plane.ts";
import { makeWebHandler } from "./http/app.ts";
import { requestContext } from "./platform/env.ts";
import { dispatchScheduled } from "./scheduled.ts";
import { SessionState } from "./session-state/durable-object.ts";

// The handler (and its router) is built once per isolate; `env`/`ctx` are provided per request.
const { handler } = makeWebHandler();

// `SessionState` holds the replay/continuity caches; the Responses WebSocket keeps its state in the Worker invocation
// that accepted the socket, not there (see docs/ARCHITECTURE.md).
export { ControlPlane, SessionState };

export default {
  fetch: (request, env, ctx) => handler(request, requestContext(env, ctx)),
  // Cron jobs (model catalog refresh, ...) are registered in `scheduledTasks` (src/scheduled.ts).
  scheduled: (controller, env, ctx) => dispatchScheduled(controller, env, ctx),
} satisfies ExportedHandler<Env>;
