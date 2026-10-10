// Command credentials emits golden fixtures for the TypeScript credential synthesis (src/credentials).
//
// Config cases run through the real config parser and ConfigSynthesizer (stable IDs, attributes, metadata); file
// cases run through the real file synthesizer. Run from the repository root:
//
//	go run ./tools/fixturegen/credentials
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/router-for-me/CLIProxyAPI/v8/internal/config"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/watcher/synthesizer"
	coreauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
)

type authOut struct {
	ID         string            `json:"id"`
	Provider   string            `json:"provider"`
	Label      string            `json:"label"`
	Prefix     string            `json:"prefix"`
	ProxyURL   string            `json:"proxyUrl"`
	Disabled   bool              `json:"disabled"`
	Attributes map[string]string `json:"attributes"`
	Metadata   map[string]any    `json:"metadata,omitempty"`
}

type configCase struct {
	Name  string    `json:"name"`
	YAML  string    `json:"yaml"`
	Auths []authOut `json:"auths"`
}

type fileCase struct {
	Name    string    `json:"name"`
	Config  string    `json:"config,omitempty"`
	File    string    `json:"file"`
	Content string    `json:"content"`
	Error   string    `json:"error,omitempty"`
	Auths   []authOut `json:"auths"`
}

type fixtures struct {
	Config []configCase `json:"config"`
	Files  []fileCase   `json:"files"`
}

func convert(auths []*coreauth.Auth) []authOut {
	out := make([]authOut, 0, len(auths))
	for _, a := range auths {
		out = append(out, authOut{
			ID:         a.ID,
			Provider:   a.Provider,
			Label:      a.Label,
			Prefix:     a.Prefix,
			ProxyURL:   a.ProxyURL,
			Disabled:   a.Disabled,
			Attributes: a.Attributes,
			Metadata:   a.Metadata,
		})
	}
	return out
}

var configSpecs = []struct{ name, yaml string }{
	{"gemini keys: headers, prefix, proxy, priority, weight, exclusions", `
gemini-api-key:
  - api-key: " gk-1 "
    prefix: /team-a/
    base-url: https://generativelanguage.googleapis.com
    proxy-url: socks5://proxy:1080
    priority: 5
    weight: 3
    headers: { X-B: two, X-A: one }
    excluded-models: [Gemini-2.5-Pro, "gemini-*-preview"]
    models:
      - { name: gemini-2.5-flash, alias: fast }
  - api-key: gk-2
    weight: 0
  - api-key: ""
    base-url: https://only-base.example.com
  - api-key: ""
`},
	{"interactions keys", `
interactions-api-key:
  - api-key: ik-1
    base-url: https://interactions.example.com
    priority: -2
`},
	{"claude keys: cooling, retry, scoped errors, fingerprint", `
claude-api-key:
  - api-key: ck-1
    base-url: https://api.anthropic.com
    disable-cooling: true
    request-retry: 2
    fingerprint-profile: " Claude-CLI "
    rebuild-mid-system-message: true
    request-scoped-errors:
      - { status: 400, match: ["bad thing"], action: stop }
    models:
      - { name: claude-sonnet-4-5, alias: sonnet, force-mapping: true }
  - api-key: ck-2
    request-retry: -1
    disable-cooling: false
`},
	{"codex, xai and meta keys", `
codex-api-key:
  - api-key: cx-1
    base-url: https://codex.example.com/v1
    websockets: true
    alpha-search: true
    disable-codex-cloaking: false
    priority: 1
xai-api-key:
  - api-key: xk-1
    base-url: https://api.x.ai/v1
    websockets: true
    excluded-models: [grok-3]
meta-api-key:
  - api-key: mk-1
    websockets: true
`},
	{"openai-compatibility: entries, key-less, disabled, headers", `
openai-compatibility:
  - name: OpenRouter
    base-url: https://openrouter.ai/api/v1
    prefix: or
    priority: 3
    headers: { HTTP-Referer: https://example.com }
    disable-cooling: true
    request-retry: 1
    api-key-entries:
      - { api-key: or-1, weight: 4 }
      - { api-key: or-2, proxy-url: http://p:8080 }
      - { api-key: or-1, weight: 4 }
    models:
      - { name: gpt-4o, alias: gpt }
  - name: Local
    base-url: http://localhost:11434/v1
  - name: Off
    disabled: true
    base-url: https://off.example.com
    api-key-entries: [{ api-key: off-1 }]
`},
	{"vertex api keys", `
vertex-api-key:
  - api-key: vk-1
    base-url: https://vertex.example.com
    prefix: vx
    interactions: true
    priority: 7
    weight: 2
    excluded-models: [imagen-*]
    headers: { X-Goog: a }
  - api-key: vk-2
    base-url: https://vertex.example.com
`},
}

var fileSpecs = []struct{ name, config, file, content string }{
	{"claude oauth file", "", "claude-1a2b3c4d-me@x.com.json",
		`{"type":"Claude","email":"me@x.com","access_token":"at","refresh_token":"rt","expired":"2030-01-01T00:00:00Z","prefix":" /team/ ","priority":" 7 ","weight":"3","headers":{" X-A ":" 1 ","X-Empty":" ","X-N":2},"note":" hi ","excluded-models":["Claude-Opus-*"," "],"model-aliases":[{"name":"claude-sonnet-4-5","alias":"sonnet","force-mapping":true},{"name":"x","alias":"X"},{"name":"X","alias":"x"},{"name":"same","alias":"SAME"}],"fingerprint-profile":" Claude-CLI ","proxy-url":"http://p:1"}`},
	{"codex file with plan from id_token", "", "codex-abc-me@x.com-plus.json",
		`{"type":"codex","email":"me@x.com","id_token":"eyJhbGciOiJub25lIn0.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9wbGFuX3R5cGUiOiJ0ZWFtIn19.sig","access_token":"a","refresh_token":"r","disabled":true}`},
	{"codex file defaults to free plan", "", "codex-free.json",
		`{"type":"codex","id_token":"not-a-jwt","access_token":"a"}`},
	{"kimi domains", "", "kimi-1.json", `{"type":"kimi-ai","access_token":"a","refresh_token":"r"}`},
	{"kimi com with base url", "", "kimi-2.json", `{"type":"kimi","domain":"Kimi.AI","base_url":" https://custom.example/coding "}`},
	{"global exclusions and per-file", `
oauth-excluded-models:
  antigravity: [Gemini-3-*, other]
`, "antigravity-me.json", `{"type":"antigravity","email":"me@x.com","access_token":"a","excluded_models":["Own-Model"],"weight":0}`},
	{"invalid weight is rejected", "", "bad-weight.json", `{"type":"claude","weight":1.5}`},
	{"weight above the maximum is rejected", "", "too-heavy.json", `{"type":"claude","weight":1000001}`},
	{"legacy gemini type is ignored", "", "gemini-old.json", `{"type":"gemini","access_token":"a"}`},
	{"missing type is ignored", "", "untyped.json", `{"access_token":"a"}`},
	{"invalid priority is ignored", "", "prio.json", `{"type":"xai","priority":"high"}`},
	{"vertex file", "", "vertex-p.json", `{"type":"vertex","project_id":"p","service_account":{"client_email":"sa@p.iam"},"prefix":"vx"}`},
}

func main() {
	outPath := flag.String("out", "test/fixtures/credentials.json", "output file")
	flag.Parse()

	now := time.Unix(1_800_000_000, 0)
	var result fixtures

	for _, spec := range configSpecs {
		cfg, err := config.ParseConfigBytes([]byte(spec.yaml))
		if err != nil {
			fmt.Fprintf(os.Stderr, "case %q: %v\n", spec.name, err)
			os.Exit(1)
		}
		ctx := &synthesizer.SynthesisContext{Config: cfg, Now: now, IDGenerator: synthesizer.NewStableIDGenerator()}
		auths, err := synthesizer.NewConfigSynthesizer().Synthesize(ctx)
		if err != nil {
			fmt.Fprintf(os.Stderr, "case %q: %v\n", spec.name, err)
			os.Exit(1)
		}
		result.Config = append(result.Config, configCase{Name: spec.name, YAML: spec.yaml, Auths: convert(auths)})
	}

	for _, spec := range fileSpecs {
		cfgYAML := spec.config
		if cfgYAML == "" {
			cfgYAML = "debug: false\n"
		}
		cfg, err := config.ParseConfigBytes([]byte(cfgYAML))
		if err != nil {
			fmt.Fprintf(os.Stderr, "case %q: %v\n", spec.name, err)
			os.Exit(1)
		}
		ctx := &synthesizer.SynthesisContext{Config: cfg, AuthDir: "/auths", Now: now, IDGenerator: synthesizer.NewStableIDGenerator()}
		auths, errSynth := synthesizer.SynthesizeAuthFile(ctx, filepath.Join("/auths", spec.file), []byte(spec.content))
		item := fileCase{Name: spec.name, Config: spec.config, File: spec.file, Content: spec.content, Auths: convert(auths)}
		if errSynth != nil {
			item.Error = errSynth.Error()
		}
		result.Files = append(result.Files, item)
	}

	data, err := json.MarshalIndent(result, "", "  ")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if err = os.MkdirAll(filepath.Dir(*outPath), 0o755); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if err = os.WriteFile(*outPath, append(data, '\n'), 0o644); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	fmt.Printf("wrote %s (%d config cases, %d file cases)\n", *outPath, len(result.Config), len(result.Files))
}
