// Service-account fixtures for the Vertex JWT-bearer flow: a freshly generated RSA key in several PEM spellings.
import type { JsonObject } from "../../src/json/index.ts";

const b64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));

const wrapPem = (kind: string, der: Uint8Array, lineLength = 64): string => {
  const body = b64(der);
  const lines =
    lineLength === 0 ? [body] : (body.match(new RegExp(`.{1,${lineLength}}`, "g")) ?? []);

  return `-----BEGIN ${kind}-----\n${lines.join("\n")}\n-----END ${kind}-----\n`;
};

/** Reads one DER TLV at `offset`: `[tag, contentStart, contentEnd]`. */
const readTlv = (bytes: Uint8Array, offset: number): [number, number, number] => {
  const tag = bytes[offset] as number;
  let length = bytes[offset + 1] as number;
  let start = offset + 2;

  if (length & 0x80) {
    const count = length & 0x7f;
    length = 0;

    for (let i = 0; i < count; i++) length = length * 256 + (bytes[start + i] as number);
    start += count;
  }

  return [tag, start, start + length];
};

/** PKCS#8 PrivateKeyInfo -> inner PKCS#1 RSAPrivateKey (the OCTET STRING). */
export const pkcs8ToPkcs1 = (pkcs8: Uint8Array): Uint8Array => {
  const [, seqStart] = readTlv(pkcs8, 0);
  const [, , versionEnd] = readTlv(pkcs8, seqStart);
  const [, , algEnd] = readTlv(pkcs8, versionEnd);
  const [, octetStart, octetEnd] = readTlv(pkcs8, algEnd);

  return pkcs8.slice(octetStart, octetEnd);
};

export interface TestServiceAccount {
  readonly publicKey: CryptoKey;
  readonly pkcs8: Uint8Array;
  readonly pkcs1: Uint8Array;
  /** Service-account JSON with the key in the requested PEM spelling. */
  readonly account: (privateKey: string, extra?: JsonObject) => JsonObject;
  readonly pem: { pkcs8: string; pkcs1: string };
}

export const makeServiceAccount = async (): Promise<TestServiceAccount> => {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;

  const pkcs8 = new Uint8Array(
    (await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer,
  );
  const pkcs1 = pkcs8ToPkcs1(pkcs8);

  return {
    publicKey: pair.publicKey,
    pkcs8,
    pkcs1,
    pem: { pkcs8: wrapPem("PRIVATE KEY", pkcs8), pkcs1: wrapPem("RSA PRIVATE KEY", pkcs1) },
    account: (privateKey, extra = {}) => ({
      type: "service_account",
      project_id: "proj-1",
      private_key_id: "kid-1",
      private_key: privateKey,
      client_email: "sa@proj-1.iam.gserviceaccount.com",
      token_uri: "https://oauth2.googleapis.com/token",
      ...extra,
    }),
  };
};

export { wrapPem };

const decodeSegment = (segment: string): unknown => {
  const padded = segment
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(segment.length / 4) * 4, "=");

  return JSON.parse(atob(padded));
};

/** Splits a JWT and verifies its RS256 signature against `publicKey`. */
export const verifyJwt = async (
  token: string,
  publicKey: CryptoKey,
): Promise<{
  header: Record<string, unknown>;
  claims: Record<string, unknown>;
  valid: boolean;
}> => {
  const [header, claims, signature] = token.split(".") as [string, string, string];

  const padded = signature
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(signature.length / 4) * 4, "=");

  const sig = Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));

  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    publicKey,
    sig,
    new TextEncoder().encode(`${header}.${claims}`),
  );

  return {
    header: decodeSegment(header) as Record<string, unknown>,
    claims: decodeSegment(claims) as Record<string, unknown>,
    valid,
  };
};
