import { DurableObject } from "cloudflare:workers"
import { ConfigStore, type ConfigSnapshotWire, type PutConfigResult } from "../config/store.ts"

/**
 * Singleton Durable Object (`CONTROL_PLANE.getByName("global")`): the single writer for config, credentials,
 * cooldown state and refresh scheduling (see docs/workers-port/ARCHITECTURE.md).
 *
 * Currently implements the config part only; credential state is added by later slices. Methods are exposed to the
 * Worker through JS RPC and exchange plain data only.
 */
export class ControlPlane extends DurableObject<Env> {
  readonly #config: ConfigStore

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.#config = new ConfigStore(ctx.storage.sql)
  }

  /**
   * Current config document. Pass the version already cached by the caller to get a cheap `unchanged: true`
   * answer instead of the full document.
   */
  getConfig(sinceVersion?: number): ConfigSnapshotWire {
    return this.#config.get(sinceVersion)
  }

  /**
   * Replaces the config with `text` (YAML or JSON). Returns a structured result instead of throwing so validation
   * and version-conflict errors survive the RPC boundary. `expectedVersion` enables optimistic concurrency.
   */
  putConfig(text: string, expectedVersion?: number): PutConfigResult {
    return this.#config.put(text, expectedVersion)
  }
}
