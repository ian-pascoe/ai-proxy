# Connecting clients

All examples use `https://proxy.example.com` as the Worker's hostname and an Access **service token** (see
[ACCESS.md](ACCESS.md)). Export the token once; never commit it:

```bash
export CF_ACCESS_CLIENT_ID='<id>.access'
export CF_ACCESS_CLIENT_SECRET='<secret>'
```

The proxy ignores the provider API key a client sends (Access is the only authentication), but most clients insist on one, so
use a dummy value. List the model ids you can use with `GET /v1/models`.

## curl

```bash
H=(-H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET")
curl "${H[@]}" https://proxy.example.com/v1/models

# OpenAI chat completions
curl "${H[@]}" https://proxy.example.com/v1/chat/completions -H 'content-type: application/json' \
  -d '{"model":"gpt-5","messages":[{"role":"user","content":"hi"}]}'

# Anthropic messages
curl "${H[@]}" https://proxy.example.com/v1/messages -H 'content-type: application/json' -H 'anthropic-version: 2023-06-01' \
  -d '{"model":"claude-sonnet-4-5","max_tokens":256,"messages":[{"role":"user","content":"hi"}]}'

# Gemini
curl "${H[@]}" 'https://proxy.example.com/v1beta/models/gemini-2.5-pro:generateContent' -H 'content-type: application/json' \
  -d '{"contents":[{"role":"user","parts":[{"text":"hi"}]}]}'
```

Replace the model ids with ones from `/v1/models`. A redirect (302) to `cloudflareaccess.com` means the headers did not match a
Service Auth policy.

## Claude Code

Claude Code reads these environment variables (see the
[environment variable reference](https://code.claude.com/docs/en/env-vars)):

```bash
export ANTHROPIC_BASE_URL=https://proxy.example.com
export ANTHROPIC_AUTH_TOKEN=dummy        # sent as "Authorization: Bearer dummy"; ignored by the proxy
export ANTHROPIC_CUSTOM_HEADERS=$'CF-Access-Client-Id: '"$CF_ACCESS_CLIENT_ID"$'\nCF-Access-Client-Secret: '"$CF_ACCESS_CLIENT_SECRET"
claude
```

`ANTHROPIC_CUSTOM_HEADERS` takes `Name: Value` pairs separated by newlines. Set `ANTHROPIC_API_KEY=dummy` instead of
`ANTHROPIC_AUTH_TOKEN` if you prefer the `x-api-key` header; an API key already logged in with `claude login` can interfere, so
log out or use a clean `CLAUDE_CONFIG_DIR`. Pick a model served by your credentials with `ANTHROPIC_MODEL` (and
`ANTHROPIC_DEFAULT_SONNET_MODEL` etc.); the proxy also accepts non-Claude models, translated to the Claude Code protocol.

Persistent alternative, `~/.claude/settings.json`:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://proxy.example.com",
    "ANTHROPIC_AUTH_TOKEN": "dummy",
    "ANTHROPIC_CUSTOM_HEADERS": "CF-Access-Client-Id: <id>.access\nCF-Access-Client-Secret: <secret>"
  }
}
```

Single-header mode (see [ACCESS.md](ACCESS.md#5-optional-single-header-service-token)) with `read_service_tokens_from_header` set to
`x-api-key` allows `ANTHROPIC_API_KEY='{"cf-access-client-id":"…","cf-access-client-secret":"…"}'` with no custom headers. This
relies on Claude Code not rejecting that key format; if it does, use the two-header form.

## Codex CLI

The built-in ChatGPT provider has no setting for extra headers, so define a custom provider in `~/.codex/config.toml`
(see the [config reference](https://developers.openai.com/codex/config-reference)):

```toml
model_provider = "cliproxy"
model = "gpt-5-codex"            # any model id from /v1/models

[model_providers.cliproxy]
name = "CLIProxy Workers"
base_url = "https://proxy.example.com/v1"
wire_api = "responses"           # the only supported value
# Header name -> environment variable holding its value (keeps the secret out of the file):
env_http_headers = { "CF-Access-Client-Id" = "CF_ACCESS_CLIENT_ID", "CF-Access-Client-Secret" = "CF_ACCESS_CLIENT_SECRET" }
# supports_websockets = true     # optional: Responses over WebSocket (see the CPU-limit caveat in the README)
```

Run `codex` with the two variables exported. Static values can use `http_headers = { "CF-Access-Client-Id" = "…" }`, but then the
secret lives in the file. A provider without `env_key` sends no bearer token, which is fine: the proxy does not need one. Codex
sends `/v1/responses` (HTTP/SSE, or the WebSocket upgrade on the same path) and `/v1/responses/compact`.

The Worker also serves the ChatGPT-backend paths `/backend-api/codex/responses`, `/responses/compact` and `/alpha/search` for tools
that hard-code them. Codex's `chatgpt_base_url` only overrides the ChatGPT _login_ flow and cannot carry the Access headers, so
prefer the custom provider above.

## OpenAI SDKs

```python
import os
from openai import OpenAI

client = OpenAI(
    base_url="https://proxy.example.com/v1",
    api_key="dummy",
    default_headers={
        "CF-Access-Client-Id": os.environ["CF_ACCESS_CLIENT_ID"],
        "CF-Access-Client-Secret": os.environ["CF_ACCESS_CLIENT_SECRET"],
    },
)
print(client.chat.completions.create(model="gpt-5", messages=[{"role": "user", "content": "hi"}]))
```

```ts
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "https://proxy.example.com/v1",
  apiKey: "dummy",
  defaultHeaders: {
    "CF-Access-Client-Id": process.env.CF_ACCESS_CLIENT_ID!,
    "CF-Access-Client-Secret": process.env.CF_ACCESS_CLIENT_SECRET!,
  },
});
```

## Anthropic SDKs

The SDK appends `/v1/messages` itself: the base URL has **no** `/v1`.

```python
from anthropic import Anthropic

client = Anthropic(
    base_url="https://proxy.example.com",
    api_key="dummy",
    default_headers={"CF-Access-Client-Id": "...", "CF-Access-Client-Secret": "..."},
)
```

```ts
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  baseURL: "https://proxy.example.com",
  apiKey: "dummy",
  defaultHeaders: {
    "CF-Access-Client-Id": "...",
    "CF-Access-Client-Secret": "...",
  },
});
```

With single-header mode on `x-api-key`, pass the JSON string as `api_key`/`apiKey` and drop the extra headers.

## Gemini SDKs (`google-genai`)

The base URL is the host; the SDK adds `/v1beta`.

```python
from google import genai
from google.genai import types

client = genai.Client(
    api_key="dummy",
    http_options=types.HttpOptions(
        base_url="https://proxy.example.com",
        headers={"CF-Access-Client-Id": "...", "CF-Access-Client-Secret": "..."},
    ),
)
```

```ts
import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({
  apiKey: "dummy",
  httpOptions: {
    baseUrl: "https://proxy.example.com",
    headers: { "CF-Access-Client-Id": "...", "CF-Access-Client-Secret": "..." },
  },
});
```

## Browser users

Anyone allowed by an Access Allow policy can open `https://proxy.example.com/management.html` and (if listed in
`ACCESS_ADMIN_EMAILS`) manage credentials. They do not need a service token.
