/**
 * sjson-compatible write access over parsed JSON values.
 *
 * Port of github.com/tidwall/sjson v1.2.5 `Set`, `SetRaw` and `Delete` for simple dot paths (keys, array indexes,
 * `-1` append, `\` escapes, `:` forced string keys). Behaviour mirrored from sjson:
 *  - missing parents are created: a numeric (or `-1`) next key creates an array, anything else an object;
 *  - setting index `n` beyond the end pads the array with `null`;
 *  - a scalar (or missing) value on the way is replaced by a new container;
 *  - a non-numeric key on an existing array is an error, except `-1` which appends;
 *  - deleting a missing path is a no-op; `-1` deletes the last array element.
 * Complex paths (`#`, `@`, `|`, `*`, `?`) throw {@link JsonPathError} (sjson fails for delete and silently
 * rewrites matches for set; the Go code base never relies on the latter).
 *
 * All functions mutate containers in place and return the root, which differs from the input only when it had
 * to be replaced (missing/scalar root). Values are inserted by reference: clone shared values first.
 */
import { isJsonArray, isJsonObject, type Json, setOwn, tryParseJson } from "./value.ts"
import { parseUint } from "./get.ts"

export class JsonPathError extends Error {
  override readonly name = "JsonPathError"
}

/** Upper bound for `null` padding when setting a far array index (sjson would allocate without limit). */
const MAX_ARRAY_PADDING = 1 << 20

interface SetPart {
  readonly part: string
  readonly force: boolean
}

const parseSetPath = (path: string): SetPart[] => {
  if (path === "") throw new JsonPathError("path cannot be empty")
  const parts: SetPart[] = []
  let rest = path

  for (;;) {
    let force = false

    if (rest[0] === ":") {
      force = true
      rest = rest.slice(1)
    }

    let part = ""
    let more = false
    let i = 0

    for (; i < rest.length; i++) {
      const c = rest[i] as string

      if (c === ".") {
        more = true
        break
      }

      if (c === "\\") {
        i++

        if (i < rest.length) part += rest[i]
        continue
      }

      if (c === "|" || c === "#" || c === "@" || c === "*" || c === "?") {
        throw new JsonPathError(`complex path "${path}" is not supported for set/delete`)
      }

      part += c
    }

    parts.push({ part, force })

    if (!more) return parts
    rest = rest.slice(i + 1)
  }
}

/** sjson `atoui`: digits only (an empty part counts as index 0), never for forced keys. */
const numericIndex = (part: SetPart): number | undefined => {
  if (part.force || !/^[0-9]*$/.test(part.part)) return undefined
  const n = part.part === "" ? 0 : Number(part.part)

  if (n > MAX_ARRAY_PADDING) throw new JsonPathError(`array index ${part.part} is too large`)

  return n
}

const isAppend = (part: SetPart): boolean => !part.force && part.part === "-1"

const build = (parts: readonly SetPart[], index: number, value: Json): Json => {
  const part = parts[index]

  if (part === undefined) return value
  const n = numericIndex(part)

  if (n !== undefined || isAppend(part)) {
    const array: Json[] = Array.from({ length: n ?? 0 }, () => null)
    array.push(build(parts, index + 1, value))

    return array
  }

  const object: Record<string, Json> = {}
  setOwn(object, part.part, build(parts, index + 1, value))

  return object
}

const setParts = (node: Json | undefined, parts: readonly SetPart[], index: number, value: Json): Json => {
  const part = parts[index] as SetPart
  const last = index === parts.length - 1

  if (isJsonArray(node)) {
    const n = parseUint(part.part)

    if (n !== undefined && n < node.length) {
      node[n] = last ? value : setParts(node[n], parts, index + 1, value)

      return node
    }
  } else if (isJsonObject(node) && Object.hasOwn(node, part.part)) {
    setOwn(node, part.part, last ? value : setParts(node[part.part], parts, index + 1, value))

    return node
  }

  const n = numericIndex(part)
  const container: Json = isJsonArray(node) || isJsonObject(node) ? node : n !== undefined ? [] : {}

  if (isJsonArray(container)) {
    if (n === undefined) {
      if (!isAppend(part)) throw new JsonPathError(`cannot set array element for non-numeric key '${part.part}'`)
      container.push(build(parts, index + 1, value))

      return container
    }

    while (container.length < n) container.push(null)
    container.push(build(parts, index + 1, value))

    return container
  }

  setOwn(container, part.part, build(parts, index + 1, value))

  return container
}

/** sjson.Set with a JSON value. Returns the (possibly new) root. */
export const set = (root: Json | undefined, path: string, value: Json): Json =>
  setParts(root, parseSetPath(path), 0, value)

/** sjson.SetRaw: `raw` is JSON text that is parsed and inserted. Throws when it is not valid JSON. */
export const setRaw = (root: Json | undefined, path: string, raw: string): Json => {
  const value = tryParseJson(raw)

  if (value === undefined) throw new JsonPathError("raw value is not valid JSON")

  return set(root, path, value)
}

const deleteParts = (node: Json | undefined, parts: readonly SetPart[], index: number): void => {
  const part = parts[index] as SetPart
  const last = index === parts.length - 1

  if (isJsonArray(node)) {
    let n = parseUint(part.part)

    if (isAppend(part) && node.length > 0) n = node.length - 1

    if (n === undefined || n >= node.length) return

    if (last) node.splice(n, 1)
    else deleteParts(node[n], parts, index + 1)
  } else if (isJsonObject(node) && Object.hasOwn(node, part.part)) {
    if (last) delete node[part.part]
    else deleteParts(node[part.part], parts, index + 1)
  }
}

/** sjson.Delete. A path that does not exist is a no-op. Returns the root. */
export const del = <T extends Json | undefined>(root: T, path: string): T => {
  deleteParts(root, parseSetPath(path), 0)

  return root
}
