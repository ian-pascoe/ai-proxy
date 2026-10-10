// The ways to connect an account (src/management/oauth-routes.ts, src/oauth/service.ts): sign-in flows that end
// with a pasted address (the provider only redirects to localhost), sign-in flows with a device code, the Vertex
// service-account import and auth-file upload. Pure: no DOM, tested in test/web-connect.test.ts.
import type { OAuthProvider } from "#contract/oauth.ts";

export type ConnectMethod =
  | {
      readonly kind: "sign-in";
      readonly provider: OAuthProvider;
      /** "paste": the operator pastes the address the provider redirected to; "code": a device code. */
      readonly flow: "paste" | "code";
      /** Codex offers both: a device code instead of the pasted address. */
      readonly codeAlternative?: boolean;
    }
  | { readonly kind: "vertex" }
  | { readonly kind: "file" };

export interface ConnectOption {
  readonly id: string;
  readonly name: string;
  /** One sentence: what the operator does. */
  readonly how: string;
  readonly method: ConnectMethod;
}

export const CONNECT_OPTIONS: ReadonlyArray<ConnectOption> = [
  {
    id: "claude",
    name: "Claude",
    how: "Sign in at claude.ai, then paste the address your browser lands on.",
    method: { kind: "sign-in", provider: "claude", flow: "paste" },
  },
  {
    id: "codex",
    name: "Codex",
    how: "Sign in with your ChatGPT account, then paste the address or enter a code.",
    method: { kind: "sign-in", provider: "codex", flow: "paste", codeAlternative: true },
  },
  {
    id: "xai",
    name: "xAI",
    how: "Enter a code on x.ai.",
    method: { kind: "sign-in", provider: "xai", flow: "code" },
  },
  {
    id: "antigravity",
    name: "Antigravity",
    how: "Sign in with Google, then paste the address your browser lands on.",
    method: { kind: "sign-in", provider: "antigravity", flow: "paste" },
  },
  {
    id: "devin",
    name: "Devin",
    how: "Sign in at app.devin.ai, then paste the address your browser lands on.",
    method: { kind: "sign-in", provider: "devin", flow: "paste" },
  },
  {
    id: "meta",
    name: "Meta",
    how: "Enter a code on meta.com.",
    method: { kind: "sign-in", provider: "meta", flow: "code" },
  },
  {
    id: "kimi",
    name: "Kimi (kimi.com)",
    how: "Enter a code on kimi.com.",
    method: { kind: "sign-in", provider: "kimi", flow: "code" },
  },
  {
    id: "kimi-ai",
    name: "Kimi (kimi.ai)",
    how: "Enter a code on kimi.ai.",
    method: { kind: "sign-in", provider: "kimi-ai", flow: "code" },
  },
  {
    id: "vertex",
    name: "Vertex AI",
    how: "Import a Google Cloud service-account key.",
    method: { kind: "vertex" },
  },
  {
    id: "file",
    name: "Auth file",
    how: "Upload credential files saved by CLIProxyAPI.",
    method: { kind: "file" },
  },
];

/** The host a sign-in link goes to ("claude.ai"), shown on its button so the operator knows where they land. */
export const linkHost = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

export type PastedAddress =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly problem: string };

/**
 * Checks the address the operator pasted: a whole URL whose query carries the provider's answer (`code`, or `error`
 * when they declined). Nothing is sent until it is.
 */
export const readPastedAddress = (raw: string): PastedAddress => {
  const text = raw.trim();

  if (text === "") return { ok: false, problem: "Paste the address from your browser first." };

  let url: URL;

  try {
    url = new URL(text);
  } catch {
    return {
      ok: false,
      problem:
        "That is not a whole address. Copy everything in the address bar, starting with http.",
    };
  }

  if (!url.searchParams.has("code") && !url.searchParams.has("error")) {
    return {
      ok: false,
      problem:
        "This address has no sign-in answer in it. Paste the address of the page the provider sent you to after you approved.",
    };
  }

  return { ok: true, url: text };
};

/** Auth files are JSON; larger than this is not a credential. */
export const MAX_AUTH_FILE_BYTES = 10 * 1024 * 1024;

/** A file's name as an auth-file name: its base name, which must end in `.json`. */
export const authFileName = (fileName: string): string | undefined => {
  const base = fileName.split(/[\\/]/).at(-1) ?? "";

  return /\.json$/i.test(base) && base.length > 5 ? base : undefined;
};
