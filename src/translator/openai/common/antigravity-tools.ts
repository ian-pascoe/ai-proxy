/**
 * Go source: internal/translator/common/antigravity_tools.go.
 *
 * Antigravity agents ship intrinsic sandbox tools (read_file / write_file / execute_code); client tools that
 * re-declare those names are renamed with `external_` on the way upstream and renamed back on every response path.
 */
export const EXTERNAL_TOOL_PREFIX = "external_"

const COLLIDING = new Set(["read_file", "write_file", "execute_code"])

const intrinsicBase = (name: string): boolean => {
  let base = name

  while (base.startsWith(EXTERNAL_TOOL_PREFIX)) base = base.slice(EXTERNAL_TOOL_PREFIX.length)

  return COLLIDING.has(base)
}

export const antigravityToolNameToUpstream = (name: string): string =>
  intrinsicBase(name) ? EXTERNAL_TOOL_PREFIX + name : name

export const antigravityUpstreamToolNameToClient = (name: string): string => {
  if (name.startsWith(EXTERNAL_TOOL_PREFIX)) {
    const base = name.slice(EXTERNAL_TOOL_PREFIX.length)

    if (intrinsicBase(base)) return base
  }

  return name
}
