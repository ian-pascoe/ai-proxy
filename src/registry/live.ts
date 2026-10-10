import { Layer } from "effect";
import { ConfigReader } from "../config/reader.ts";
import { CatalogStore } from "./catalog-store.ts";
import { ModelRoutes } from "./routes.ts";
import { ModelRegistry } from "./service.ts";

/** `ModelRegistry` wired to the ControlPlane config reader and the KV-backed catalog store. */
export const ModelRegistryLive = ModelRegistry.layer.pipe(
  Layer.provide(Layer.mergeAll(ConfigReader.layerControlPlane(), CatalogStore.layer)),
);

/** The listing routes with their services; wrap with `withAccess(...)` when merging into the app. */
export const ModelRoutesLive = ModelRoutes.pipe(Layer.provide(ModelRegistryLive));
