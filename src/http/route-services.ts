// Capturing the services of a route layer for its per-request handlers. New in the Workers port.
import { Context, Effect, Scope } from "effect";

/**
 * The services `R` of the current (route layer) context, to be provided to request handlers with `Effect.provide`.
 *
 * `Effect.context` returns the *whole* context, which during layer construction includes the layer's own `Scope`
 * (alive as long as the isolate's web handler). Providing that to a handler would replace the request scope, so
 * request-scoped resources (streamed response bodies, upstream responses, attempt finalisers) would be attached to the
 * isolate and never released, also not when the client disconnects. The `Scope` is therefore dropped.
 */
export const routeServices = <R>(): Effect.Effect<
  Context.Context<Exclude<R, Scope.Scope>>,
  never,
  R
> => Effect.map(Effect.context<R>(), Context.omit(Scope.Scope));
