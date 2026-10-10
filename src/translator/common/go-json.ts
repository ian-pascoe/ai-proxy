/**
 * Go `encoding/json` ordering helpers. The Go translators often insert `gjson.Result.Value()` (a
 * `map[string]any`) through `sjson.SetBytes`, which marshals with object keys sorted alphabetically. The fixtures keep
 * key order, so those call sites use {@link sortKeysDeep} to reproduce the same order.
 */
import { isJsonArray, isJsonObject, type Json, type JsonObject } from "../../json/index.ts"
import { setOwn } from "../../json/value.ts"

/** Deep copy with every object's keys sorted (Go `json.Marshal` of a `map[string]any`). */
export const sortKeysDeep = (value: Json): Json => {
  if (isJsonArray(value)) return value.map(sortKeysDeep)

  if (isJsonObject(value)) {
    const out: JsonObject = {}

    for (const key of Object.keys(value).toSorted()) setOwn(out, key, sortKeysDeep(value[key] as Json))

    return out
  }

  return value
}
