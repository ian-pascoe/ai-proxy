# Migrating from the Go server

The Workers port reads the Go `config.yaml` and the Go auth files (`*.json`), so migration is: deploy
([README](../../workers/README.md#deploy)), then import both through the management API.

## 0. Management access from a terminal

The management API needs an Access **admin**. For scripts, create a service token (see [ACCESS.md](ACCESS.md)) and add its Client ID
to `ACCESS_ADMIN_SERVICE_TOKENS`, then:

```bash
M=https://proxy.example.com/v8/management
H=(-H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET")
```

Alternatively use the panel (`/management.html`) as an admin user: it has config and auth-file upload pages.

## 1. Config

Remove what the Workers port ignores, then upload the file as-is:

```bash
curl "${H[@]}" -X PUT "$M/config.yaml" --data-binary @config.yaml     # {"status":"ok","config-version":8}
curl "${H[@]}" "$M/config.yaml"                                       # sparse export of what was stored
```

- Legacy top-level keys (`claude-api-key`, `codex-api-key`, `gemini-api-key`, `openai-compatibility`, `request-retry`, …) are
  migrated to the v8 layout on import; unknown or inapplicable keys are dropped. A malformed document answers 422
  `invalid_config` with a message; nothing is stored.
- **Secrets in `config.yaml`** (provider API keys) are stored in the `ControlPlane` Durable Object, not in your repo.
- Not applied on Workers: `host`/`port`/`tls`, `remote-management.*` (Access replaces it), `auth-dir`, `proxy-url`, `pprof`, logging to
  files, `wire-policy`/TLS fingerprint, plugins, Home, Postgres/git/object store settings.
- The client `api-keys:` list is **not enforced**: every client must now present an Access identity ([CLIENTS.md](CLIENTS.md)).
  Give each client its own service token instead of a shared key.
- `PATCH $M/config` and `/config/<path>` allow incremental edits; the panel's config editor uses them.

## 2. Auth files (OAuth credentials)

Upload every `*.json` file from the Go `auth-dir` (default `~/.cli-proxy-api`). The file name becomes the credential id:

```bash
curl "${H[@]}" -X POST "$M/credentials" $(for f in ~/.cli-proxy-api/*.json; do printf -- '-F file=@%s ' "$f"; done)
# or a single raw file:
curl "${H[@]}" -X POST "$M/credentials?name=claude-ab12cd34-me@example.com.json" \
  -H 'content-type: application/json' --data-binary @claude-ab12cd34-me@example.com.json
curl "${H[@]}" "$M/credentials"          # list (tokens are redacted)
```

Results: `200 {"status":"ok","uploaded":N,…}`, or `207` with a `failed` list when some files were rejected (`file must be .json`,
`invalid name`). Uploaded credentials are selectable immediately; expired access tokens are refreshed using the stored refresh
token. Vertex service-account files can be uploaded the same way. Disabled flags and per-file settings (`prefix`, `priority`,
`proxy_url` is ignored) are kept.

Caveats:

- Provider refresh tokens are single-use for some providers (Claude, Codex). If the Go server and the Worker both keep refreshing
  the same file, one of them will see `invalid_grant`. **Stop the Go server after importing**, or re-login in the Worker (below).
- Files are bound to the provider's egress IP behaviour only by the provider's own policy; see "Known limitations" in the README.

## 3. OAuth re-login via the panel

Logging in fresh avoids sharing refresh tokens. In the panel → _OAuth login_ (or `GET $M/oauth/auth-url?provider=<claude|codex|antigravity|devin|xai|meta|kimi|kimi-ai>`):

1. Open the returned authorization URL and sign in with the provider.
2. **Authorization-code providers (Claude, Codex, Antigravity, Devin)**: the provider redirects to `http://localhost:<port>/…callback?code=…&state=…`.
   That page will not load (nothing listens on your machine). Copy the **full redirected URL** from the address bar and paste it into the panel's
   callback field (API: `POST $M/oauth/callback` with `{"provider":"codex","redirect_url":"<url>"}`). The Worker exchanges the code
   itself; poll `GET $M/oauth/status?state=<state>` until `ok`. The window is 5 minutes.
3. **Device-code logins (Codex with `flow=device`, xAI, Meta, Kimi)**: show the code and URL, approve in the browser; the panel polls
   the status. No paste step.

The credential is stored under the same file-name scheme as Go (e.g. `claude-<hash>-<email>.json`); a re-login of the same account
replaces the tokens but keeps your per-file settings.

## 4. Switch clients

Point each tool at the Worker with Access headers ([CLIENTS.md](CLIENTS.md)); verify `GET /v1/models` lists the models you expect,
then retire the Go server. Model aliases, prefixes, `excluded-models`, payload rules and routing settings from `config.yaml` carry over.
Usage statistics are not migrated; new usage is recorded in D1 and shown in the panel.
