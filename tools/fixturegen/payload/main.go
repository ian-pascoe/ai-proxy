// Command payload emits golden fixtures for the TypeScript payload rules engine (src/config/payload).
//
// Every case is executed with the real helps.ApplyPayloadConfigWithTrackedPathsForExecutor so the TypeScript
// tests can verify behavioural parity. Run from the repository root:
//
//	go run ./tools/fixturegen/payload
package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sort"

	"github.com/router-for-me/CLIProxyAPI/v8/internal/config"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/runtime/executor/helps"
)

type request struct {
	Model          string              `json:"model"`
	RequestedModel string              `json:"requestedModel,omitempty"`
	Protocol       string              `json:"protocol"`
	FromProtocol   string              `json:"fromProtocol,omitempty"`
	Root           string              `json:"root,omitempty"`
	RequestPath    string              `json:"requestPath,omitempty"`
	Headers        map[string][]string `json:"headers,omitempty"`
	TrackedPaths   []string            `json:"trackedPaths,omitempty"`
}

type fixtureCase struct {
	Name     string          `json:"name"`
	Config   json.RawMessage `json:"config"`
	Request  request         `json:"request"`
	Payload  json.RawMessage `json:"payload"`
	Original json.RawMessage `json:"original,omitempty"`
	Out      json.RawMessage `json:"out"`
	Touched  []string        `json:"touched"`
}

// spec is the authored input of a case; configuration text uses the v8 `requests.payload` / `multimedia` shape
// of the TypeScript config and the legacy `payload` / `disable-image-generation` shape of the Go config.
type spec struct {
	name     string
	payload  string // rule configuration: JSON of the PayloadConfig
	disable  string // JSON of disable-image-generation ("" = unset)
	req      request
	body     string
	original string
}

const (
	chatBody = `{"model":"gpt-5","temperature":0.5,"max_tokens":100,"stream":true,"metadata":{"a":1},"tools":[{"type":"function","name":"f1","strict":true},{"type":"image_generation"},{"type":"function","name":"f2"}],"messages":[{"role":"system","content":"s"},{"role":"user","content":"u1"},{"role":"assistant","content":"a"},{"role":"user","content":"u2"}],"nothing":null}`
	reqBody  = `{"request":{"contents":[{"role":"user","parts":[{"text":"a"}]},{"role":"user","parts":[{"text":"b"}]}],"generationConfig":{"temperature":1},"tools":[{"type":"image_generation"},{"type":"function"}],"tool_choice":{"type":"tool","name":"image_generation"}},"model":"x"}`
)

func models(entries ...string) string {
	out := "["
	for i, e := range entries {
		if i > 0 {
			out += ","
		}
		out += e
	}
	return out + "]"
}

func rule(modelsJSON, paramsJSON string) string {
	return `{"models":` + modelsJSON + `,"params":` + paramsJSON + `}`
}

var specs = []spec{
	{name: "default sets missing and skips present", payload: `{"default":[` + rule(models(`{"name":"gpt-*"}`), `{"top_p":0.9,"temperature":1,"nested.deep.value":"x","arr.2":true}`) + `]}`, req: request{Model: "gpt-5", Protocol: "openai"}, body: chatBody},
	{name: "default checks the original payload", payload: `{"default":[` + rule(models(`{"name":"*"}`), `{"present":"user default","missing":"user default"}`) + `]}`, req: request{Model: "m", Protocol: "openai"}, body: `{"present":"built-in","missing":"built-in2","other":1}`, original: `{"present":"caller"}`},
	{name: "default first write wins across rules", payload: `{"default":[` + rule(models(`{"name":"*"}`), `{"x.y":"first"}`) + `,` + rule(models(`{"name":"*"}`), `{"x.y":"second"}`) + `]}`, req: request{Model: "m", Protocol: "openai"}, body: `{}`},
	{name: "default with root", payload: `{"default":[` + rule(models(`{"name":"gemini-*"}`), `{"generationConfig.topP":0.8,"generationConfig.temperature":2,"newField":1}`) + `]}`, req: request{Model: "gemini-3", Protocol: "antigravity", Root: "request"}, body: reqBody},
	{name: "default with leading dot path and root", payload: `{"default":[` + rule(models(`{"name":"*"}`), `{".a.b":1}`) + `]}`, req: request{Model: "m", Protocol: "x", Root: "request"}, body: `{"request":{}}`},
	{name: "default query path first match", payload: `{"default":[` + rule(models(`{"name":"*"}`), `{"tools.#(type==\"function\").strict":false}`) + `]}`, req: request{Model: "m", Protocol: "openai"}, body: chatBody, original: `{"tools":[{"type":"function","name":"f1","strict":true},{"type":"function","name":"f2"}]}`},
	{name: "default query path all matches", payload: `{"default":[` + rule(models(`{"name":"*"}`), `{"messages.#(role==\"user\")#.cache":true}`) + `]}`, req: request{Model: "m", Protocol: "openai"}, body: chatBody},
	{name: "default query no match", payload: `{"default":[` + rule(models(`{"name":"*"}`), `{"messages.#(role==\"nobody\")#.cache":true,"tools.#(name==\"zzz\").x":1}`) + `]}`, req: request{Model: "m", Protocol: "openai"}, body: chatBody},
	{name: "default-raw strings are raw json", payload: `{"default-raw":[` + rule(models(`{"name":"*"}`), `{"a":"{\"k\":[1,2,{\"z\":null}]}","b":"true","c":"\"str\"","d":{"obj":1},"e":12,"f":null}`) + `]}`, req: request{Model: "m", Protocol: "openai"}, body: `{"keep":1}`},
	{name: "default-raw skips present", payload: `{"default-raw":[` + rule(models(`{"name":"*"}`), `{"keep":"2","new":"3"}`) + `]}`, req: request{Model: "m", Protocol: "openai"}, body: `{"keep":1}`, original: `{"keep":1}`},
	{name: "override replaces and creates", payload: `{"override":[` + rule(models(`{"name":"gpt-*"}`), `{"temperature":0.1,"stream":false,"metadata":{"b":2},"model":"forced","nothing":"now","brand.new":[1,2],"messages.0.content":"changed"}`) + `]}`, req: request{Model: "gpt-5", Protocol: "openai"}, body: chatBody},
	{name: "override null and equal values", payload: `{"override":[` + rule(models(`{"name":"*"}`), `{"nothing":null,"temperature":0.5,"stream":true,"metadata":{"a":1}}`) + `]}`, req: request{Model: "m", Protocol: "openai", TrackedPaths: []string{"temperature", "metadata"}}, body: chatBody},
	{name: "override last write wins", payload: `{"override":[` + rule(models(`{"name":"*"}`), `{"x":"first"}`) + `,` + rule(models(`{"name":"*"}`), `{"x":"second"}`) + `]}`, req: request{Model: "m", Protocol: "openai"}, body: `{"x":0}`},
	{name: "override query all matches", payload: `{"override":[` + rule(models(`{"name":"*"}`), `{"messages.#(role==\"user\")#.content":"redacted","tools.#(type==\"function\")#.strict":false}`) + `]}`, req: request{Model: "m", Protocol: "openai"}, body: chatBody},
	{name: "override query first match", payload: `{"override":[` + rule(models(`{"name":"*"}`), `{"messages.#(role==\"user\").content":"first user"}`) + `]}`, req: request{Model: "m", Protocol: "openai"}, body: chatBody},
	{name: "override query with and/or", payload: `{"override":[` + rule(models(`{"name":"*"}`), `{"tools.#(type==\"function\" && name==\"f2\").x":1,"messages.#(role==\"system\" || role==\"assistant\")#.tag":"t"}`) + `]}`, req: request{Model: "m", Protocol: "openai"}, body: chatBody},
	{name: "override query with numeric comparison and pattern", payload: `{"override":[` + rule(models(`{"name":"*"}`), `{"items.#(n>1)#.big":true,"items.#(s%\"a*\").starts":true}`) + `]}`, req: request{Model: "m", Protocol: "openai"}, body: `{"items":[{"n":1,"s":"abc"},{"n":2,"s":"bcd"},{"n":3,"s":"axe"}]}`},
	{name: "override-raw", payload: `{"override-raw":[` + rule(models(`{"name":"*"}`), `{"tools":"[{\"type\":\"function\",\"name\":\"only\"}]","tool_choice":"{\"type\":\"auto\"}","max_tokens":"7","fresh":"\"x\""}`) + `]}`, req: request{Model: "m", Protocol: "openai"}, body: chatBody},
	{name: "override-raw equal value is applied", payload: `{"override-raw":[` + rule(models(`{"name":"*"}`), `{"metadata":"{\"a\":1}"}`) + `]}`, req: request{Model: "m", Protocol: "openai", TrackedPaths: []string{"metadata"}}, body: chatBody},
	{name: "filter removes paths", payload: `{"filter":[{"models":` + models(`{"name":"*"}`) + `,"params":["temperature","metadata.a","messages.0","nope","tools.1"]}]}`, req: request{Model: "m", Protocol: "openai"}, body: chatBody},
	{name: "filter query all matches deletes in reverse", payload: `{"filter":[{"models":` + models(`{"name":"*"}`) + `,"params":["tools.#(type==\"image_generation\")#","messages.#(role==\"user\")#"]}]}`, req: request{Model: "m", Protocol: "openai"}, body: chatBody},
	{name: "filter query first match", payload: `{"filter":[{"models":` + models(`{"name":"*"}`) + `,"params":["messages.#(role==\"user\")","tools.#(type==\"nothing\")"]}]}`, req: request{Model: "m", Protocol: "openai"}, body: chatBody},
	{name: "filter with root", payload: `{"filter":[{"models":` + models(`{"name":"*"}`) + `,"params":["contents.0","generationConfig"]}]}`, req: request{Model: "gemini", Protocol: "antigravity", Root: "request"}, body: reqBody},
	{name: "filter nested field of query match", payload: `{"filter":[{"models":` + models(`{"name":"*"}`) + `,"params":["tools.#(type==\"function\")#.strict"]}]}`, req: request{Model: "m", Protocol: "openai"}, body: chatBody},
	{name: "model name wildcards", payload: `{"override":[` + rule(models(`{"name":"gemini-*-pro"}`), `{"hit1":1}`) + `,` + rule(models(`{"name":"*-5"}`), `{"hit2":1}`) + `,` + rule(models(`{"name":"claude-*"}`), `{"hit3":1}`) + `,` + rule(models(`{"name":"gpt-5"}`), `{"hit4":1}`) + `,` + rule(models(`{"name":"g*t-?"}`), `{"hit5":1}`) + `]}`, req: request{Model: "gpt-5", Protocol: "openai"}, body: `{}`},
	{name: "model name wildcard gemini", payload: `{"override":[` + rule(models(`{"name":"gemini-*-pro"}`), `{"hit1":1}`) + `,` + rule(models(`{"name":"*-pro"}`), `{"hit2":1}`) + `,` + rule(models(`{"name":"*flash*"}`), `{"hit3":1}`) + `]}`, req: request{Model: "gemini-2.5-pro", Protocol: "gemini"}, body: `{}`},
	{name: "requested model aliases and suffix", payload: `{"override":[` + rule(models(`{"name":"my-alias"}`), `{"alias":1}`) + `,` + rule(models(`{"name":"my-alias(high)"}`), `{"withSuffix":1}`) + `,` + rule(models(`{"name":"upstream"}`), `{"upstream":1}`) + `]}`, req: request{Model: "upstream", RequestedModel: "my-alias(high)", Protocol: "openai"}, body: `{}`},
	{name: "requested model only", payload: `{"override":[` + rule(models(`{"name":"only-requested"}`), `{"hit":1}`) + `]}`, req: request{Model: "", RequestedModel: "only-requested", Protocol: "openai"}, body: `{}`},
	{name: "no model nothing applied", payload: `{"override":[` + rule(models(`{"name":"*"}`), `{"hit":1}`) + `]}`, req: request{Model: "", Protocol: "openai"}, body: `{}`},
	{name: "protocol filter", payload: `{"override":[` + rule(models(`{"name":"*","protocol":"claude"}`), `{"claude":1}`) + `,` + rule(models(`{"name":"*","protocol":"OPENAI"}`), `{"openai":1}`) + `,` + rule(models(`{"name":"*","protocol":"gemini"}`), `{"gemini":1}`) + `]}`, req: request{Model: "m", Protocol: "openai"}, body: `{}`},
	{name: "protocol empty runtime ignores rule protocol", payload: `{"override":[` + rule(models(`{"name":"*","protocol":"claude"}`), `{"claude":1}`) + `]}`, req: request{Model: "m", Protocol: ""}, body: `{}`},
	{name: "from-protocol aliases", payload: `{"override":[` + rule(models(`{"name":"*","from-protocol":"openai-response"}`), `{"a":1}`) + `,` + rule(models(`{"name":"*","from-protocol":"responses"}`), `{"b":1}`) + `,` + rule(models(`{"name":"*","from-protocol":"claude"}`), `{"c":1}`) + `,` + rule(models(`{"name":"*","from-protocol":"RESPONSE"}`), `{"d":1}`) + `]}`, req: request{Model: "m", Protocol: "codex", FromProtocol: "openai-responses"}, body: `{}`},
	{name: "from-protocol rule with empty runtime from", payload: `{"override":[` + rule(models(`{"name":"*","from-protocol":"claude"}`), `{"c":1}`) + `,` + rule(models(`{"name":"*"}`), `{"any":1}`) + `]}`, req: request{Model: "m", Protocol: "codex"}, body: `{}`},
	{name: "headers wildcard all must match", payload: `{"override":[` + rule(models(`{"name":"*","headers":{"X-Client-Tier":"tenant-*-region-*"}}`), `{"tier":1}`) + `,` + rule(models(`{"name":"*","headers":{"x-client-tier":"tenant-*","X-Other":"*"}}`), `{"both":1}`) + `,` + rule(models(`{"name":"*","headers":{"user-agent":"codex_*"}}`), `{"ua":1}`) + `]}`, req: request{Model: "m", Protocol: "openai", Headers: map[string][]string{"X-Client-Tier": {"tenant-alpha-region-us"}, "User-Agent": {"Mozilla", "codex_cli_rs/0.1"}}}, body: `{}`},
	{name: "headers missing never match", payload: `{"override":[` + rule(models(`{"name":"*","headers":{"X-Missing":"*"}}`), `{"hit":1}`) + `]}`, req: request{Model: "m", Protocol: "openai"}, body: `{}`},
	{name: "match conditions", payload: `{"override":[` + rule(models(`{"name":"*","match":[{"max_tokens":100}]}`), `{"m1":1}`) + `,` + rule(models(`{"name":"*","match":[{"max_tokens":100.0}]}`), `{"m2":1}`) + `,` + rule(models(`{"name":"*","match":[{"max_tokens":101}]}`), `{"m3":1}`) + `,` + rule(models(`{"name":"*","match":[{"metadata":{"a":1}}]}`), `{"m4":1}`) + `,` + rule(models(`{"name":"*","match":[{"stream":true,"temperature":0.5}]}`), `{"m5":1}`) + `,` + rule(models(`{"name":"*","match":[{"stream":true,"temperature":0.6}]}`), `{"m6":1}`) + `,` + rule(models(`{"name":"*","match":[{"messages.#(role==\"user\")#.content":["u1","u2"]}]}`), `{"m7":1}`) + `,` + rule(models(`{"name":"*","match":[{"nothing":null}]}`), `{"m8":1}`) + `]}`, req: request{Model: "m", Protocol: "openai"}, body: chatBody},
	{name: "match with string numeric mismatch", payload: `{"override":[` + rule(models(`{"name":"*","match":[{"max_tokens":"100"}]}`), `{"m1":1}`) + `,` + rule(models(`{"name":"*","match":[{"model":"gpt-5"}]}`), `{"m2":1}`) + `]}`, req: request{Model: "m", Protocol: "openai"}, body: chatBody},
	{name: "not-match conditions", payload: `{"override":[` + rule(models(`{"name":"*","not-match":[{"max_tokens":100}]}`), `{"n1":1}`) + `,` + rule(models(`{"name":"*","not-match":[{"max_tokens":5}]}`), `{"n2":1}`) + `,` + rule(models(`{"name":"*","not-match":[{"missing.path":5}]}`), `{"n3":1}`) + `]}`, req: request{Model: "m", Protocol: "openai"}, body: chatBody},
	{name: "exist and not-exist conditions", payload: `{"override":[` + rule(models(`{"name":"*","exist":["temperature","tools.#(type==\"image_generation\")"]}`), `{"e1":1}`) + `,` + rule(models(`{"name":"*","exist":["nothing"]}`), `{"e2":1}`) + `,` + rule(models(`{"name":"*","not-exist":["nothing"]}`), `{"e3":1}`) + `,` + rule(models(`{"name":"*","not-exist":["thinking","metadata.zzz"]}`), `{"e4":1}`) + `,` + rule(models(`{"name":"*","not-exist":["temperature"]}`), `{"e5":1}`) + `,` + rule(models(`{"name":"*","exist":["tools.#(type==\"nope\")"]}`), `{"e6":1}`) + `]}`, req: request{Model: "m", Protocol: "openai"}, body: chatBody},
	{name: "conditions see earlier rules", payload: `{"default":[` + rule(models(`{"name":"*","not-exist":["added"]}`), `{"added":1}`) + `],"override":[` + rule(models(`{"name":"*","exist":["added"]}`), `{"sawAdded":true}`) + `,` + rule(models(`{"name":"*","match":[{"sawAdded":true}]}`), `{"sawSaw":true}`) + `],"filter":[{"models":` + models(`{"name":"*","match":[{"sawSaw":true}]}`) + `,"params":["added"]}]}`, req: request{Model: "m", Protocol: "openai"}, body: `{}`},
	{name: "conditions with root", payload: `{"override":[` + rule(models(`{"name":"*","match":[{"generationConfig.temperature":1}],"exist":["contents.0.role"]}`), `{"generationConfig.temperature":0.2}`) + `]}`, req: request{Model: "m", Protocol: "antigravity", Root: "request"}, body: reqBody},
	{name: "model entries are OR", payload: `{"override":[` + rule(models(`{"name":"nope"}`, `{"name":"gpt-*","protocol":"claude"}`, `{"name":"gpt-*","protocol":"openai"}`), `{"hit":1}`) + `]}`, req: request{Model: "gpt-5", Protocol: "openai"}, body: `{}`},
	{name: "entry without name is skipped", payload: `{"override":[` + rule(models(`{"protocol":"openai"}`, `{"name":"  "}`), `{"hit":1}`) + `]}`, req: request{Model: "gpt-5", Protocol: "openai"}, body: `{}`},
	{name: "tracked paths", payload: `{"override":[` + rule(models(`{"name":"*"}`), `{"diagnostics.user":true,"other":1,"contextual":2}`) + `],"filter":[{"models":` + models(`{"name":"*"}`) + `,"params":["context_management.inner"]}]}`, req: request{Model: "m", Protocol: "claude", TrackedPaths: []string{"diagnostics", "context_management", "contextual.deep", "untouched"}}, body: `{"context_management":{"inner":1}}`},
	{name: "tracked default paths", payload: `{"default":[` + rule(models(`{"name":"*"}`), `{"diagnostics.user":true}`) + `]}`, req: request{Model: "m", Protocol: "claude", TrackedPaths: []string{"diagnostics"}}, body: `{"a":1}`},
	{name: "final body conditions and tracking", payload: `{"override":[` + rule(models(`{"name":"*","match":[{"max_tokens":100}]}`), `{"unexpected":true}`) + `,` + rule(models(`{"name":"*","match":[{"max_tokens":300}]}`), `{"diagnostics.user":true}`) + `],"filter":[{"models":` + models(`{"name":"*","match":[{"max_tokens":300}]}`) + `,"params":["context_management","messages.0"]}]}`, req: request{Model: "model", Protocol: "claude", FromProtocol: "claude", TrackedPaths: []string{"diagnostics", "context_management"}}, body: `{"max_tokens":300,"context_management":{"builtin":true},"messages":[{},{},{}]}`, original: `{"max_tokens":100,"messages":[{},{}]}`},
	{name: "escaped and special keys", payload: `{"override":[` + rule(models(`{"name":"*"}`), `{"a\\.b":1,"x.y\\.z":2,"weird key":3}`) + `]}`, req: request{Model: "m", Protocol: "openai"}, body: `{"a.b":0}`},
	{name: "append and numeric creation", payload: `{"override":[` + rule(models(`{"name":"*"}`), `{"list.-1":"tail","padded.3":1,"messages.-1":{"role":"user","content":"new"}}`) + `]}`, req: request{Model: "m", Protocol: "openai"}, body: `{"list":["a"],"messages":[]}`},
	{name: "scalar replaced by container", payload: `{"override":[` + rule(models(`{"name":"*"}`), `{"a.b":1,"s.0":1}`) + `]}`, req: request{Model: "m", Protocol: "openai"}, body: `{"a":"str","s":"x"}`},
	{name: "invalid set path is skipped", payload: `{"override":[` + rule(models(`{"name":"*"}`), `{"list.name":1,"ok":1}`) + `]}`, req: request{Model: "m", Protocol: "openai"}, body: `{"list":[1]}`},

	{name: "disable image generation all", payload: `{}`, disable: `true`, req: request{Model: "gpt-5", Protocol: "openai-response"}, body: `{"tools":[{"type":"image_generation"},{"type":"function","name":"f1"}],"tool_choice":{"type":"image_generation"}}`},
	{name: "disable image generation all tool_choice string", payload: `{}`, disable: `true`, req: request{Model: "gpt-5", Protocol: "openai-response"}, body: `{"tools":[{"type":"image_generation"}],"tool_choice":"image_generation"}`},
	{name: "disable image generation all tool_choice by name", payload: `{}`, disable: `true`, req: request{Model: "gpt-5", Protocol: "openai-response"}, body: `{"tools":[{"type":"function","name":"keep"}],"tool_choice":{"type":"tool","name":"image_generation"}}`},
	{name: "disable image generation keeps other tool_choice", payload: `{}`, disable: `true`, req: request{Model: "gpt-5", Protocol: "openai-response"}, body: `{"tools":[{"type":"function","name":"keep"}],"tool_choice":{"type":"function","name":"keep"}}`},
	{name: "disable image generation with root", payload: `{}`, disable: `true`, req: request{Model: "gpt-5.4", Protocol: "antigravity", Root: "request"}, body: reqBody},
	{name: "disable image generation chat strips non-images", payload: `{}`, disable: `"chat"`, req: request{Model: "gpt-5", Protocol: "openai-response", RequestPath: "/v1/responses"}, body: `{"tools":[{"type":"image_generation"},{"type":"function"}],"tool_choice":{"type":"image_generation"}}`},
	{name: "disable image generation chat keeps images endpoint", payload: `{}`, disable: `"chat"`, req: request{Model: "gpt-5", Protocol: "openai-response", RequestPath: "/v1/images/generations"}, body: `{"tools":[{"type":"image_generation"},{"type":"function"}],"tool_choice":{"type":"image_generation"}}`},
	{name: "disable image generation chat keeps prefixed images endpoint", payload: `{}`, disable: `"chat"`, req: request{Model: "gpt-5", Protocol: "openai-response", RequestPath: "/openai/v1/images/edits"}, body: `{"tools":[{"type":"image_generation"}]}`},
	{name: "disable image generation passthrough", payload: `{}`, disable: `"passthrough"`, req: request{Model: "gpt-5", Protocol: "openai-response", RequestPath: "/v1/responses"}, body: `{"tools":[{"type":"image_generation"},{"type":"function"}],"tool_choice":{"type":"image_generation"}}`},
	{name: "disable image generation override can restore", payload: `{"override-raw":[` + rule(models(`{"name":"gpt-5.4","protocol":"openai-response"}`), `{"tools":"[{\"type\":\"image_generation\"},{\"type\":\"function\",\"name\":\"f1\"}]","tool_choice":"{\"type\":\"image_generation\"}"}`) + `]}`, disable: `true`, req: request{Model: "gpt-5.4", Protocol: "openai-response"}, body: `{"tools":[{"type":"image_generation"},{"type":"function","name":"f1"}],"tool_choice":{"type":"image_generation"}}`},
	{name: "disable image generation without model still strips", payload: `{"override":[` + rule(models(`{"name":"*"}`), `{"x":1}`) + `]}`, disable: `true`, req: request{Model: "", Protocol: "openai"}, body: `{"tools":[{"type":"image_generation"}]}`},
}

func buildConfig(s spec) (json.RawMessage, *config.Config) {
	text := `{"payload":` + s.payload
	if s.disable != "" {
		text += `,"disable-image-generation":` + s.disable
	}
	text += `}`
	cfg := &config.Config{}
	if err := json.Unmarshal([]byte(text), cfg); err != nil {
		panic(fmt.Sprintf("%s: %v", s.name, err))
	}
	// Output in the TypeScript (v8) shape.
	v8 := `{"requests":{"payload":` + s.payload + `}`
	if s.disable != "" {
		v8 += `,"multimedia":{"disable-image-generation":` + s.disable + `}`
	}
	v8 += `}`
	return json.RawMessage(v8), cfg
}

func canonicalJSON(data []byte) []byte {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		panic(err)
	}
	out, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	return out
}

func main() {
	outPath := flag.String("out", "test/fixtures/payload-rules.json", "output file")
	flag.Parse()

	cases := make([]fixtureCase, 0, len(specs))
	for _, s := range specs {
		v8, cfg := buildConfig(s)
		headers := http.Header{}
		for k, vs := range s.req.Headers {
			for _, v := range vs {
				headers.Add(k, v)
			}
		}
		var original []byte
		if s.original != "" {
			original = []byte(s.original)
		}
		out, touched := helps.ApplyPayloadConfigWithTrackedPathsForExecutor(cfg, "", s.req.Model, s.req.Protocol, s.req.FromProtocol, s.req.Root, []byte(s.body), original, s.req.RequestedModel, s.req.RequestPath, headers, s.req.TrackedPaths...)
		if !json.Valid(out) {
			panic(fmt.Sprintf("%s: invalid JSON output %s", s.name, out))
		}
		// Go map iteration order is random, so rules with several params may emit keys in any order.
		// Re-encode with sorted keys to keep the fixture stable; the tests compare structurally.
		out = canonicalJSON(out)
		names := make([]string, 0, len(touched))
		for name, ok := range touched {
			if ok {
				names = append(names, name)
			}
		}
		sort.Strings(names)
		c := fixtureCase{Name: s.name, Config: v8, Request: s.req, Payload: json.RawMessage(s.body), Out: json.RawMessage(out), Touched: names}
		if s.original != "" {
			c.Original = json.RawMessage(s.original)
		}
		cases = append(cases, c)
	}

	data, err := json.MarshalIndent(cases, "", " ")
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
	fmt.Printf("wrote %d payload cases to %s\n", len(cases), *outPath)
}
