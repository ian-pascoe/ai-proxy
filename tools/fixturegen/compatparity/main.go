// Command compatparity emits golden fixtures for the TypeScript OpenAI-compatible parity helpers
// (src/executor/helps/openai-compat-tool-results.ts): the real Go helps.NormalizeOpenAIToolResultsTextOnly and
// helps.ShouldNormalizeOpenAIToolResultsForModel run over scripted payloads and model configurations. Run from the
// repository root:
//
//	go run ./tools/fixturegen/compatparity
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/google/uuid"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/config"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/runtime/executor/helps"
	cliproxyexecutor "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/executor"
)

type normalizeCase struct {
	Name   string `json:"name"`
	Input  string `json:"input"`
	Output string `json:"output"`
}

type modelCase struct {
	Name      string                            `json:"name"`
	Models    []config.OpenAICompatibilityModel `json:"models"`
	Upstream  string                            `json:"upstream"`
	Requested string                            `json:"requested"`
	Normalize bool                              `json:"normalize"`
}

func normalizeCases() []normalizeCase {
	cases := []normalizeCase{
		{Name: "array content flattened", Input: `{"messages":[{"role":"user","content":"hi"},{"role":"tool","tool_call_id":"c1","content":[{"type":"text","text":"a"},{"type":"text","text":"b"}]}]}`},
		{Name: "image part marker", Input: `{"messages":[{"role":"tool","tool_call_id":"c1","content":[{"type":"text","text":"a"},{"type":"image_url","image_url":{"url":"data:image/png;base64,AA"}}]}]}`},
		{Name: "object and scalar content", Input: `{"messages":[{"role":"tool","content":{"text":"obj"}},{"role":"tool","content":{"foo":1}},{"role":"tool","content":null},{"role":"tool","content":7},{"role":"tool","content":["x",2,{"k":"v"}]}]}`},
		{Name: "placeholder and relay message", Input: `{"messages":[{"role":"assistant","tool_calls":[{"id":"c1"}]},{"role":"tool","tool_call_id":"c1","content":"[Tool returned image content; the images follow in the next user message.]"},{"role":"user","content":[{"type":"text","text":"Images returned by the preceding tool call(s):"},{"type":"image_url","image_url":{"url":"u"}}]},{"role":"assistant","content":"done"}]}`},
		{Name: "relay without placeholder appends marker", Input: `{"messages":[{"role":"tool","tool_call_id":"c1","content":"result text"},{"role":"user","content":[{"type":"text","text":"Images returned by the preceding tool call(s):"},{"type":"image_url","image_url":{"url":"u"}},{"type":"text","text":"keep me"}]}]}`},
		{Name: "relay after empty tool content", Input: `{"messages":[{"role":"tool","tool_call_id":"c1","content":""},{"role":"user","content":[{"type":"text","text":"Images returned by the preceding tool call(s):"},{"type":"input_image","image_url":"u"}]}]}`},
		{Name: "plain user images untouched", Input: `{"messages":[{"role":"user","content":[{"type":"text","text":"look"},{"type":"image_url","image_url":{"url":"u"}}]}]}`},
		{Name: "flag reset by other roles", Input: `{"messages":[{"role":"tool","content":"[Tool returned image content; the images follow in the next user message.]"},{"role":"assistant","content":"x"},{"role":"tool","content":"t2"},{"role":"user","content":[{"type":"text","text":"Images returned by the preceding tool call(s):"},{"type":"image","source":{}}]}]}`},
		{Name: "no messages", Input: `{"model":"m"}`},
	}
	for i := range cases {
		cases[i].Output = string(helps.NormalizeOpenAIToolResultsTextOnly([]byte(cases[i].Input)))
	}
	return cases
}

func modelCases() []modelCase {
	text := []string{"text"}
	both := []string{"Text", " image "}
	cases := []modelCase{
		{Name: "text only by name", Models: []config.OpenAICompatibilityModel{{Name: "m", InputModalities: text}}, Upstream: "m", Requested: "m"},
		{Name: "text and image", Models: []config.OpenAICompatibilityModel{{Name: "m", InputModalities: both}}, Upstream: "m", Requested: "m"},
		{Name: "no modalities", Models: []config.OpenAICompatibilityModel{{Name: "m"}}, Upstream: "m", Requested: "m"},
		{Name: "alias text only", Models: []config.OpenAICompatibilityModel{{Name: "up", Alias: "al", InputModalities: text}}, Upstream: "zzz", Requested: "al(high)"},
		{Name: "alias mixed", Models: []config.OpenAICompatibilityModel{{Name: "a", Alias: "al", InputModalities: text}, {Name: "b", Alias: "AL", InputModalities: both}}, Upstream: "zzz", Requested: "al"},
		{Name: "name wins over alias", Models: []config.OpenAICompatibilityModel{{Name: "x", Alias: "m", InputModalities: both}, {Name: "m", InputModalities: text}}, Upstream: "M", Requested: "x"},
		{Name: "unmatched", Models: []config.OpenAICompatibilityModel{{Name: "m", InputModalities: text}}, Upstream: "other", Requested: "other"},
		{Name: "suffix stripped", Models: []config.OpenAICompatibilityModel{{Name: "m", InputModalities: text}}, Upstream: "m(8192)", Requested: ""},
	}
	for i := range cases {
		compat := &config.OpenAICompatibility{Models: cases[i].Models}
		cases[i].Normalize = helps.ShouldNormalizeOpenAIToolResultsForModel(compat, cases[i].Upstream, cases[i].Requested)
	}
	return cases
}

type cacheKeyCase struct {
	Provider  string `json:"provider"`
	Model     string `json:"model"`
	From      string `json:"from"`
	Derived   string `json:"derived,omitempty"`
	Execution string `json:"execution,omitempty"`
	Key       string `json:"key"`
}

// promptCacheKeys mirrors OpenAICompatExecutor.applyPromptCacheKey's derived branch over the real
// helps.ProviderSessionUUID.
func promptCacheKeys() []cacheKeyCase {
	cases := []cacheKeyCase{
		{Provider: "openai-compatible-mock", Model: "Upstream-Model", From: "openai", Derived: "sess-1"},
		{Provider: "openai-compatible-mock", Model: "upstream-model", From: "openai-response", Derived: "sess-1"},
		{Provider: "openai-compatible-other", Model: "m", From: "gemini", Derived: "  d-2  "},
		{Provider: "openai-compatible-mock", Model: "m", From: "openai", Execution: "ws-1", Derived: "ignored"},
	}
	for i := range cases {
		meta := map[string]any{}
		if cases[i].Derived != "" {
			meta[cliproxyexecutor.DerivedSessionIDMetadataKey] = cases[i].Derived
		}
		if cases[i].Execution != "" {
			meta[cliproxyexecutor.ExecutionSessionMetadataKey] = cases[i].Execution
		}
		session := helps.ProviderSessionUUID(cases[i].Provider, meta)
		parts := []string{"cli-proxy-api:openai-compat:prompt-cache", lower(cases[i].Provider), lower(cases[i].Model), lower(cases[i].From), session}
		joined := ""
		for j, part := range parts {
			if j > 0 {
				joined += "\x00"
			}
			joined += part
		}
		cases[i].Key = uuid.NewSHA1(uuid.NameSpaceOID, []byte(joined)).String()
	}
	return cases
}

func lower(value string) string { return strings.ToLower(strings.TrimSpace(value)) }

func main() {
	outPath := flag.String("out", "test/fixtures/compat-parity.json", "output file")
	flag.Parse()
	doc := map[string]any{"normalize": normalizeCases(), "models": modelCases(), "promptCacheKeys": promptCacheKeys()}
	data, err := json.MarshalIndent(doc, "", " ")
	if err != nil {
		panic(err)
	}
	if err := os.MkdirAll(filepath.Dir(*outPath), 0o755); err != nil {
		panic(err)
	}
	if err := os.WriteFile(*outPath, append(data, '\n'), 0o644); err != nil {
		panic(err)
	}
	fmt.Printf("wrote %s\n", *outPath)
}
