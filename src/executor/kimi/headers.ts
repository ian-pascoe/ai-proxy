/**
 * Kimi request headers.
 *
 * Go source: internal/runtime/executor/kimi_executor.go (`applyKimiHeaders`, `applyKimiHeadersWithAuth`,
 * `resolveKimiDeviceID`, `getKimiDeviceModel`). Workers have no hostname/filesystem: the device name/model are
 * constants and the device id is the login-time `metadata.device_id` (persisted with the credential in the
 * ControlPlane), falling back to a stable id derived from the credential id (never random per request).
 */
import { uuidV5Oid } from "../helps/uuid.ts"
import { applyCustomHeaders } from "../helps/custom-headers.ts"
import type { CredentialSnapshot } from "../picker.ts"

export const KIMI_VERSION = "cliproxy-workers"

const DEVICE_NAME = "cliproxy-workers"

const DEVICE_MODEL = "Cloudflare Workers"

/** `resolveKimiDeviceID`, then a stable per-credential fallback. */
export const kimiDeviceId = (credential: CredentialSnapshot): string => {
  const stored = credential.metadata["device_id"]

  if (typeof stored === "string" && stored.trim() !== "") return stored.trim()

  return uuidV5Oid(`cli-proxy-api:kimi:device:${credential.id}`)
}

export const kimiHeaders = (
  credential: CredentialSnapshot,
  token: string,
  stream: boolean,
  clientHeaders: Headers,
  sessionId: string | undefined
): Record<string, string> => {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${token}`,
    "user-agent": `CLIProxyAPI/${KIMI_VERSION}`,
    "x-msh-platform": "CLIProxyAPI",
    "x-msh-version": KIMI_VERSION,
    "x-msh-device-name": DEVICE_NAME,
    "x-msh-device-model": DEVICE_MODEL,
    "x-msh-device-id": kimiDeviceId(credential),
    accept: stream ? "text/event-stream" : "application/json"
  }

  return applyCustomHeaders(headers, credential, clientHeaders, sessionId)
}
