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
import { ControlPlanePickerLayer } from "../executor/control-plane-picker.ts"
import { CredentialRefresher } from "../executor/helps/credential-refresh.ts"
import { ModelRegistryLive } from "../registry/live.ts"
import { ExecutorRegistry } from "../executor/registry.ts"
import { Thinking } from "../executor/thinking.ts"
import { UsageSink } from "../usage/sink.ts"
import { ModelCapabilities } from "./model-capabilities.ts"
import { ModelProviders } from "./model-providers.ts"
import { AlphaSearchRoutes } from "./codex/alpha-search.ts"
import { ImagesRoutes } from "./openai/images.ts"
import { OpenAIRoutes } from "./openai/routes.ts"
import { ResponsesRoutes } from "./responses/routes.ts"

export interface ProxyLayerOptions {
  readonly configReader?: Layer.Layer<ConfigReader>
  /** Defaults to the ControlPlane Durable Object picker (`StaticCredentialPickerLayer` is for tests). */
  readonly credentialPicker?: Layer.Layer<CredentialPicker, never, ConfigReader>
  /** Defaults to the model registry (`ModelProviders.configLayer` serves tests without one). */
  readonly modelProviders?: Layer.Layer<ModelProviders, never, ConfigReader>
  /** Defaults to the model registry snapshot (`ModelCapabilities.configLayer` serves tests without one). */
  readonly modelCapabilities?: Layer.Layer<ModelCapabilities, never, ConfigReader>
  /** Defaults to the ControlPlane (`CredentialRefresher.none` for tests with API keys only). */
  readonly credentialRefresher?: Layer.Layer<CredentialRefresher>
  readonly httpClient?: Layer.Layer<HttpClient.HttpClient>
  readonly usageSink?: Layer.Layer<UsageSink>
  readonly thinking?: Layer.Layer<Thinking>
}

/** All proxy route layers (provider slices add theirs here). */
export const ProxyRoutes = Layer.mergeAll(OpenAIRoutes, ResponsesRoutes, ImagesRoutes, AlphaSearchRoutes)

/**
 * Proxy routes with their services provided. Handlers still read `AccessPrincipal`: wrap the result with
 * `withAccess(...)` (tests use `makeWithAccess` with a fake JWKS).
 */
export const makeProxyRoutes = (options: ProxyLayerOptions = {}) => {
  const config = options.configReader ?? ConfigReader.layerControlPlane()
  const services = Layer.mergeAll(
    options.credentialPicker ?? ControlPlanePickerLayer,
    options.modelCapabilities ?? ModelCapabilities.registryLayer.pipe(Layer.provide(ModelRegistryLive)),
    options.modelProviders ?? ModelProviders.registryLayer.pipe(Layer.provide(ModelRegistryLive)),
    options.credentialRefresher ?? CredentialRefresher.controlPlane,
    ExecutorRegistry.layer,
    options.usageSink ?? UsageSink.noop,
    options.httpClient ?? FetchHttpClient.layer,
    options.thinking ?? Thinking.live
  ).pipe(Layer.provideMerge(config))
  return ProxyRoutes.pipe(Layer.provide(services))
}

/** Production proxy layer (Access-gated, ControlPlane config, global `fetch`). */
export const ProxyLayer = withAccess(makeProxyRoutes())
