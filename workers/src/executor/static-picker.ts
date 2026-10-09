/**
 * Config-only {@link CredentialPicker}: round-robin over the API keys configured in `api-keys.openai-compatibility`.
 *
 * Stand-in until the ControlPlane Durable Object implements selection (cooldowns, quota, affinity, weights). Cursors
 * live per isolate; `report` only logs failures. Only the highest-priority available credentials are used, as in Go.
 */
import { Effect, Layer } from "effect"
import { ConfigReader } from "../config/reader.ts"
import { configCredentials } from "./config-credentials.ts"
import { ExecutionError } from "./errors.ts"
import { CredentialPicker, type PickRequest, type PickResult } from "./picker.ts"
import { parseSuffix } from "./suffix.ts"

const servesModel = (models: ReadonlySet<string>, model: string): boolean => {
  if (models.has(model)) return true
  const base = parseSuffix(model).modelName
  return models.has(base) || models.has(base.toLowerCase())
}

export const makeStaticCredentialPicker = Effect.fnUntraced(function* () {
  const reader = yield* ConfigReader
  const cursors = new Map<string, number>()
  let leases = 0

  const pick = (request: PickRequest) =>
    Effect.gen(function* () {
      if (request.providers.length === 0) {
        return yield* new ExecutionError({ status: 500, code: "provider_not_found", message: "no provider supplied" })
      }
      const { config } = yield* reader.get.pipe(
        Effect.mapError((cause) => new ExecutionError({ status: 503, message: "config unavailable", cause }))
      )
      const providers = new Set(request.providers.map((provider) => provider.toLowerCase()))
      const excluded = new Set(request.excludedIds ?? [])
      const model = request.selectionModel ?? request.model
      const candidates = configCredentials(config).filter(
        (entry) =>
          providers.has(entry.credential.provider) &&
          !excluded.has(entry.credential.id) &&
          (request.pinnedId === undefined || entry.credential.id === request.pinnedId) &&
          servesModel(entry.models, model)
      )
      if (candidates.length === 0) {
        return yield* new ExecutionError({ status: 503, code: "auth_not_found", message: "no auth available" })
      }
      const top = Math.max(...candidates.map((entry) => entry.priority))
      const pool = candidates.filter((entry) => entry.priority === top)
      const cursorKey = `${[...providers].toSorted().join(",")}\u0000${model}`
      const cursor = cursors.get(cursorKey) ?? 0
      cursors.set(cursorKey, (cursor + 1) % 2_147_483_647)
      const chosen = pool[cursor % pool.length]
      if (chosen === undefined) {
        return yield* new ExecutionError({ status: 503, code: "auth_not_found", message: "no auth available" })
      }
      leases += 1
      return { credential: chosen.credential, leaseId: `static:${chosen.credential.id}:${leases}` } satisfies PickResult
    })

  return CredentialPicker.of({
    pick,
    report: (leaseId, result) =>
      result.ok
        ? Effect.void
        : Effect.logDebug(`static credential picker: attempt failed (lease ${leaseId}, status ${result.status})`)
  })
})

/** Requires `ConfigReader`. */
export const StaticCredentialPickerLayer = Layer.effect(CredentialPicker, makeStaticCredentialPicker())
