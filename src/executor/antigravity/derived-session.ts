/**
 * `DerivedAntigravitySessionID`: the derived session identity as Antigravity's negative decimal session id.
 * Go source: internal/runtime/executor/helps/derived_session.go.
 */
import { createHash } from "node:crypto";

export const derivedAntigravitySessionId = (derivedId: string): string => {
  const id = derivedId.trim();

  if (id === "") return "";
  const sum = createHash("sha256")
    .update(`cli-proxy-api:antigravity:derived-session\0${id}`)
    .digest();

  return `-${(sum.readBigUInt64BE(0) & 0x7fffffffffffffffn).toString()}`;
};
