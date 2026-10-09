/**
 * Wiring of the proxy routes and their services.
 *
 * Services are built once per isolate (the web handler's layer scope); per-request bindings (`WorkerEnv`) and the
 * Access principal are provided per request. Tests swap the upstream transport, config source, usage sink or
 * credential picker through {@link makeProxyLayer}.
 */
import { Layer } from "effect"
import { FetchHttpClient, type HttpClient } from "effect/http"
import { withAccess } from "../access/layer.ts"
import { ConfigReader } from "../config/reader.ts"
import type { CredentialPicker } from "../executor/picker.ts"
import { ExecutorRegistry } from "../executor/registry.ts"
import { StaticCredentialPickerLayer } from "../executor/static-picker.ts"
import { Thinking } from "../executor/thinking.ts"
import { UsageSink } from "../usage/sink.ts"
import { ModelProviders } from "./model-providers.ts"
import { OpenAIRoutes } from "./openai/routes.ts"

export interface ProxyLayerOptions {
  readonly configReader?: Layer.Layer<ConfigReader>
  /** Defaults to the config-only static picker (until the ControlPlane picker lands). */
  readonly credentialPicker?: Layer.Layer<CredentialPicker, never, ConfigReader>
  readonly httpClient?: Layer.Layer<HttpClient.HttpClient>
  readonly usageSink?: Layer.Layer<UsageSink>
  readonly thinking?: Layer.Layer<Thinking>
}

/** All proxy route layers (provider slices add theirs here). */
export const ProxyRoutes = Layer.mergeAll(OpenAIRoutes)

/**
 * Proxy routes with their services provided. Handlers still read `AccessPrincipal`: wrap the result with
 * `withAccess(...)` (tests use `makeWithAccess` with a fake JWKS).
 */
export const makeProxyRoutes = (options: ProxyLayerOptions = {}) => {
  const config = options.configReader ?? ConfigReader.layerControlPlane()
  const services = Layer.mergeAll(
    options.credentialPicker ?? StaticCredentialPickerLayer,
    ModelProviders.configLayer,
    ExecutorRegistry.layer,
    options.usageSink ?? UsageSink.noop,
    options.httpClient ?? FetchHttpClient.layer,
    options.thinking ?? Thinking.noop
  ).pipe(Layer.provideMerge(config))
  return ProxyRoutes.pipe(Layer.provide(services))
}

/** Production proxy layer (Access-gated, ControlPlane config, global `fetch`). */
export const ProxyLayer = withAccess(makeProxyRoutes())
