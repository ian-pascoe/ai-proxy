/**
 * `auth_index`: the stable credential handle the control panel passes around.
 *
 * Go source: sdk/cliproxy/auth/types.go (`EnsureIndex`, `stableAuthIndex`): first 8 bytes of a SHA-256 as 16 hex
 * characters. The Go seed is path/API-key based; on Workers every credential has a stable `id` (auth file name or the
 * content-addressed config id), so the seed is `id:<id>` (the Go fallback rule).
 */
import { createHash } from "node:crypto"

export const authIndexOf = (credentialId: string): string =>
  createHash("sha256").update(`id:${credentialId}`).digest("hex").slice(0, 16)
