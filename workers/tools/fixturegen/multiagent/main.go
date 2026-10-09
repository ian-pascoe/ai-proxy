// Command multiagent emits golden fixtures for the TypeScript Codex multi-agent v2 / orphan-delegation rewriting
// (workers/src/executor/helps/codex-multi-agent-v2.ts).
//
// The real internal/client/codex/optimize-multi-agent-v2 functions run over a corpus of Responses requests (agent
// messages, collaboration namespace tools, additional_tools, orphan delegation outputs) under every combination of
// client identity, config flags and compat mode. The spawn_agent model list comes from a real registry.ModelRegistry
// with several providers registered; the available models and the lookups it used are recorded so the TypeScript test
// can feed them to the port. Run from the repository root:
//
//	go run ./workers/tools/fixturegen/multiagent
package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"net/http"
	"os"
	"sort"

	multiagentv2 "github.com/router-for-me/CLIProxyAPI/v8/internal/client/codex/optimize-multi-agent-v2"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/config"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/registry"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/runtime/executor/helps"
)

type lookup struct {
	Description string   `json:"description,omitempty"`
	Levels      []string `json:"levels,omitempty"`
}

type combo struct {
	UserAgent string `json:"userAgent"`
	Subagent  string `json:"subagent"`
	Optimize  bool   `json:"optimize"`
	Orphan    bool   `json:"orphan"`
	Compat    bool   `json:"compat"`
}

// result references outputs by hash into the shared blob table ("" = unchanged input) to keep the fixture small.
type result struct {
	Case       string `json:"case"`
	Combo      combo  `json:"combo"`
	Orphan     string `json:"orphan"`
	Input      string `json:"input"`
	Prepare    string `json:"prepare"`
	Prepared   bool   `json:"prepared"`
	Optimize   string `json:"optimize"`
	Optimized  bool   `json:"optimized"`
	ForAuth    string `json:"forAuth"`
	ForAuthOpt bool   `json:"forAuthOptimized"`
	Conflict   bool   `json:"conflict"`
}

type restoreResult struct {
	Case     string `json:"case"`
	Input    string `json:"input"`
	Restored string `json:"restored"`
}

var blobs = map[string]json.RawMessage{}

// ref stores an output once and returns its hash; an output equal to the input is "".
func ref(input, output []byte) string {
	if string(input) == string(output) {
		return ""
	}
	sum := sha256.Sum256(output)
	key := hex.EncodeToString(sum[:8])
	blobs[key] = json.RawMessage(output)
	return key
}

func mustJSON(v any) json.RawMessage {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return b
}

const spawnDescription = "Spawns an agent to work on a task.\n\nThe agent inherits the parent configuration."

func spawnTool(description string) map[string]any {
	return map[string]any{
		"type": "function", "name": "spawn_agent", "description": description,
		"parameters": map[string]any{"type": "object", "properties": map[string]any{
			"message": map[string]any{"type": "string", "encrypted": true},
			"model":   map[string]any{"type": "string"},
		}},
	}
}

func messageTool(name string) map[string]any {
	return map[string]any{
		"type": "function", "name": name, "description": name,
		"parameters": map[string]any{"type": "object", "properties": map[string]any{
			"message": map[string]any{"type": "string", "encrypted": true},
		}},
	}
}

func collaborationNamespace(name string) map[string]any {
	return map[string]any{"type": "namespace", "name": name, "tools": []any{spawnTool(spawnDescription), messageTool("send_message"), messageTool("followup_task"), messageTool("wait_agent")}}
}

func corpus() map[string]any {
	staleModels := "Intro line.\n  " + "Available model overrides (optional; inherited parent model is preferred):\n  - `old`: stale.\n  - `older`: stale.\nSpawns an agent here.\nMore text."
	return map[string]any{
		"agent-messages": map[string]any{"model": "gpt-5.5", "input": []any{
			map[string]any{"type": "message", "role": "user", "content": []any{map[string]any{"type": "input_text", "text": "hi"}}},
			map[string]any{"type": "agent_message", "author": "root", "recipient": "child", "internal_chat_message_metadata_passthrough": map[string]any{"a": 1}, "content": []any{
				map[string]any{"type": "encrypted_content", "encrypted_content": "secret text <b>"},
				map[string]any{"type": "encrypted_content", "encrypted_content": 5},
				map[string]any{"type": "input_text", "text": "plain"},
			}},
			map[string]any{"type": "agent_message", "content": "text content"},
			map[string]any{"type": "agent_message", "role": "assistant", "content": []any{map[string]any{"type": "encrypted_content", "text": "kept", "encrypted_content": "abc"}}},
		}},
		"orphan-delegation": map[string]any{"model": "gpt-5.5", "input": []any{
			map[string]any{"type": "function_call", "call_id": "c1", "name": "create_thread", "namespace": "codex_app", "arguments": "{}"},
			map[string]any{"type": "function_call_output", "call_id": "c1", "name": "create_thread", "namespace": "codex_app", "output": "paired"},
			map[string]any{"type": "function_call_output", "call_id": "c1", "name": "create_thread", "namespace": "codex_app", "output": "second use is orphaned"},
			map[string]any{"type": "function_call_output", "call_id": "c2", "name": "send_message_to_thread", "namespace": "codex_app", "output": map[string]any{"ok": true, "n": 1}},
			map[string]any{"type": "function_call_output", "call_id": "c3", "name": "other", "namespace": "codex_app", "output": "not a delegation tool"},
			map[string]any{"type": "function_call_output", "name": "create_thread", "namespace": "codex_app"},
			map[string]any{"type": "function_call_output", "call_id": "c4", "name": "create_thread", "namespace": "elsewhere", "output": "wrong namespace"},
		}},
		"collaboration-tools": map[string]any{"model": "gpt-5.5", "tools": []any{
			spawnTool(staleModels),
			collaborationNamespace("collaboration"),
			map[string]any{"type": "function", "name": "shell", "parameters": map[string]any{}},
		}, "input": []any{
			map[string]any{"type": "additional_tools", "tools": []any{collaborationNamespace("collaboration"), spawnTool("no marker here")}},
			map[string]any{"type": "additional_tools", "tools": []any{map[string]any{"type": "namespace", "name": "other", "tools": []any{messageTool("send_message")}}}},
		}},
		"collaboration-conflict": map[string]any{"model": "gpt-5.5", "tools": []any{
			collaborationNamespace("collaboration"),
			map[string]any{"type": "namespace", "name": "collaboration-optimize", "tools": []any{}},
		}},
		"collaboration-conflict-additional": map[string]any{"model": "gpt-5.5", "tools": []any{collaborationNamespace("collaboration")}, "input": []any{
			map[string]any{"type": "additional_tools", "tools": []any{map[string]any{"type": "function", "name": "collaboration-optimize__x"}}},
		}},
		"no-tools": map[string]any{"model": "gpt-5.5", "input": "plain string input"},
		"empty":    map[string]any{},
	}
}

func restoreCorpus() map[string]string {
	return map[string]string{
		"stream-event": `{"type":"response.output_item.done","item":{"type":"function_call","namespace":"collaboration-optimize","name":"spawn_agent","arguments":"{\"namespace\":\"collaboration-optimize\"}","call_id":"c"}}`,
		"dot-name":     `{"type":"response.output_item.added","item":{"type":"function_call","name":"collaboration-optimize.spawn_agent","call_id":"c"}}`,
		"flat-name":    `{"item":{"type":"custom_tool_call","name":"collaboration-optimize__send_message","input":"collaboration-optimize.x"}}`,
		"namespace":    `{"response":{"output":[{"type":"namespace","name":"collaboration-optimize"},{"type":"message","name":"collaboration-optimize"}]}}`,
		"output-skip":  `{"output":[{"type":"function_call_output","output":{"namespace":"collaboration-optimize"}},{"type":"function_call","namespace":"collaboration-optimize","name":"x"}]}`,
		"html":         `{"text":"a<b>&c","item":{"type":"function_call","namespace":"collaboration-optimize","name":"x"}}`,
		"untouched":    `{"item":{"type":"function_call","namespace":"other","name":"x"}}`,
		"invalid":      `not json`,
		"empty":        ``,
		"big-number":   `{"n":12345,"f":1.5,"item":{"type":"function_call","namespace":"collaboration-optimize","name":"x"}}`,
	}
}

func main() {
	out := flag.String("out", "workers/test/fixtures/multiagent.json", "output file")
	flag.Parse()

	reg := registry.GetGlobalRegistry()
	reg.RegisterClient("c-claude", "claude", registry.GetClaudeModels())
	reg.RegisterClient("c-codex", "codex", registry.GetCodexProModels())
	reg.RegisterClient("c-gemini", "gemini", registry.GetGeminiModels())
	reg.RegisterClient("c-kimi", "kimi", registry.GetKimiModels())
	reg.RegisterClient("c-custom", "alpha", []*registry.ModelInfo{
		{ID: "custom-a", Object: "model", Created: 1, OwnedBy: "x", Type: "x", DisplayName: "Zeta `model`", Description: "  A   custom\nmodel  "},
		{ID: "custom-b", Object: "model", Created: 2, OwnedBy: "x", Type: "x", Thinking: &registry.ThinkingSupport{Levels: []string{"low", "medium", "high", "bogus"}}},
		{ID: "custom-c", Object: "model", Created: 3, OwnedBy: "x", Type: "x", Description: "Ends with punctuation!", Thinking: &registry.ThinkingSupport{Levels: []string{"none"}}},
	})

	available := reg.GetAvailableModels("openai")
	type availableOut struct {
		ID          string `json:"id"`
		Description string `json:"description,omitempty"`
		DisplayName string `json:"displayName,omitempty"`
	}
	var availableList []availableOut
	lookups := map[string]lookup{}
	for _, model := range available {
		id, _ := model["id"].(string)
		description, _ := model["description"].(string)
		displayName, _ := model["display_name"].(string)
		availableList = append(availableList, availableOut{ID: id, Description: description, DisplayName: displayName})
		if info := registry.LookupModelInfo(id); info != nil {
			l := lookup{Description: info.Description}
			if info.Thinking != nil {
				l.Levels = info.Thinking.Levels
			}
			lookups[id] = l
		}
	}
	sort.Slice(availableList, func(i, j int) bool { return availableList[i].ID < availableList[j].ID })

	userAgents := []string{"codex-tui/0.150.0", "Codex Desktop/1.2", "codex_cli_rs", "curl/8", ""}
	subagents := []string{"", "collab_spawn", "COLLAB_SPAWN", "review"}
	var results []result
	names := make([]string, 0)
	cases := corpus()
	for name := range cases {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		raw := mustJSON(cases[name])
		for _, ua := range userAgents {
			for _, subagent := range subagents {
				for _, optimize := range []bool{false, true} {
					for _, orphan := range []bool{false, true} {
						for _, compat := range []bool{false, true} {
							if (ua == "codex_cli_rs" || ua == "") && (subagent == "COLLAB_SPAWN" || subagent == "review") {
								continue
							}
							cfg := &config.Config{}
							cfg.Client.Codex.OptimizeMultiAgentV2 = optimize
							cfg.Codex.OrphanDelegationCompatibility = orphan
							headers := http.Header{}
							if ua != "" {
								headers.Set("User-Agent", ua)
							}
							if subagent != "" {
								headers.Set("X-Openai-Subagent", subagent)
							}
							ctx := context.Background()
							r := result{Case: name, Combo: combo{UserAgent: ua, Subagent: subagent, Optimize: optimize, Orphan: orphan, Compat: compat}}
							r.Orphan = ref(raw, multiagentv2.RewriteCodexOrphanDelegationInputForConfig(ctx, headers, append([]byte(nil), raw...), cfg))
							r.Input = ref(raw, multiagentv2.RewriteCodexMultiAgentV2Input(ctx, headers, append([]byte(nil), raw...), cfg, compat))
							prepared, ok := multiagentv2.PrepareCodexMultiAgentV2Tools(ctx, headers, append([]byte(nil), raw...), optimize, false)
							r.Prepare, r.Prepared = ref(raw, prepared), ok
							optimized, opt := multiagentv2.OptimizeCodexMultiAgentV2Request(ctx, headers, append([]byte(nil), raw...), cfg)
							r.Optimize, r.Optimized = ref(raw, optimized), opt
							forAuth, optAuth := helps.OptimizeCodexMultiAgentV2RequestForAuth(ctx, headers, append([]byte(nil), raw...), cfg, nil, compat)
							r.ForAuth, r.ForAuthOpt = ref(raw, forAuth), optAuth
							r.Conflict = multiagentv2.HasCodexMultiAgentV2NamespaceConflict(raw)
							results = append(results, r)
						}
					}
				}
			}
		}
	}

	var restores []restoreResult
	rc := restoreCorpus()
	rnames := make([]string, 0)
	for name := range rc {
		rnames = append(rnames, name)
	}
	sort.Strings(rnames)
	for _, name := range rnames {
		restores = append(restores, restoreResult{Case: name, Input: rc[name], Restored: string(multiagentv2.RestoreCodexMultiAgentV2Response([]byte(rc[name]), true))})
	}

	encoded, err := json.Marshal(map[string]any{
		"cases":     cases,
		"results":   results,
		"blobs":     blobs,
		"restores":  restores,
		"available": availableList,
		"lookups":   lookups,
	})
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if err = os.WriteFile(*out, append(encoded, '\n'), 0o644); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	fmt.Printf("wrote %d results and %d restores to %s\n", len(results), len(restores), *out)
}
