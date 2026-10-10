/**
 * Custom upstream headers configured per credential (`header:<Name>` attributes).
 *
 * Go source: internal/util/header_helpers.go (ApplyCustomHeadersFromAttrs, extractCustomHeaders,
 * replaceCPASessionID). Values starting with `$` are copied from the client's request header of that name (omitted
 * when absent); `$CPA-SESSION-ID` expands to the session id (omitted when unknown). Custom headers override built-in
 * ones.
 */
import type { CredentialSnapshot } from "../picker.ts";

const SESSION_TOKEN = "$CPA-SESSION-ID";

const replaceSessionId = (value: string, sessionId: string): string => {
  let out = "";
  let start = 0;
  let i = 0;

  while (i <= value.length - SESSION_TOKEN.length) {
    if (
      value[i] === "$" &&
      value.slice(i, i + SESSION_TOKEN.length).toUpperCase() === SESSION_TOKEN
    ) {
      out += value.slice(start, i) + sessionId;
      i += SESSION_TOKEN.length;
      start = i;
    } else {
      i++;
    }
  }

  return start === 0 ? value : out + value.slice(start);
};

/** Resolved custom headers for a credential (name -> value). */
export const customHeaders = (
  credential: CredentialSnapshot,
  clientHeaders: Headers | undefined,
  sessionId: string | undefined,
): Array<readonly [string, string]> => {
  const out: Array<readonly [string, string]> = [];

  for (const [key, raw] of Object.entries(credential.attributes)) {
    if (!key.startsWith("header:")) continue;
    const name = key.slice("header:".length).trim();
    let value = raw.trim();

    if (name === "" || value === "") continue;

    if (value.startsWith("$") && value.slice(1).trim().toUpperCase() === "CPA-SESSION-ID") {
      if (sessionId === undefined || sessionId === "") continue;
      value = sessionId;
    } else if (value.toUpperCase().includes(SESSION_TOKEN)) {
      if (sessionId === undefined || sessionId === "") continue;
      value = replaceSessionId(value, sessionId);
    } else if (value.startsWith("$")) {
      const variable = value.slice(1).trim();
      const clientValue = variable === "" ? null : (clientHeaders?.get(variable) ?? null);

      if (clientValue === null || clientValue === "") continue;
      value = clientValue;
    }

    out.push([name, value]);
  }

  return out;
};

/** Applies {@link customHeaders} on top of `headers` (overriding built-in values). */
export const applyCustomHeaders = (
  headers: Record<string, string>,
  credential: CredentialSnapshot,
  clientHeaders: Headers | undefined,
  sessionId: string | undefined,
): Record<string, string> => {
  for (const [name, value] of customHeaders(credential, clientHeaders, sessionId)) {
    const lower = name.toLowerCase();

    for (const existing of Object.keys(headers)) {
      if (existing.toLowerCase() === lower) delete headers[existing];
    }

    headers[name] = value;
  }

  return headers;
};
