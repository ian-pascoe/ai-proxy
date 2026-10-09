// Command applypatch emits golden fixtures for the TypeScript Responses apply_patch bridge
// (workers/src/translator/common/apply-patch-responses.ts and workers/src/executor/helps/apply-patch-responses.ts).
//
// The real Go helps.NewApplyPatchResponsesState / helps.NormalizeApplyPatchResponsesRequest run over scripted event
// sequences (function-call streams, folded xAI dispatchers, sparse terminals, identity conflicts, SSE lines, EOF
// handling) and over request normalisation cases; every output event and error message is recorded. Run from the
// repository root:
//
//	go run ./workers/tools/fixturegen/applypatch
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"

	"github.com/router-for-me/CLIProxyAPI/v8/internal/runtime/executor/helps"
	sdktranslator "github.com/router-for-me/CLIProxyAPI/v8/sdk/translator"
)

type op struct {
	Op    string `json:"op"`
	Input string `json:"input,omitempty"`
	// Name and Namespace are used by the dispatcher registration op.
	Name      string `json:"name,omitempty"`
	Namespace string `json:"namespace,omitempty"`
}

type scenario struct {
	Name         string      `json:"name"`
	Source       string      `json:"source"`
	Original     string      `json:"original"`
	Declarations string      `json:"declarations,omitempty"`
	Dispatchers  [][2]string `json:"dispatchers,omitempty"`
	Ops          []op        `json:"ops"`
}

type step struct {
	Out []string `json:"out"`
	Err string   `json:"err,omitempty"`
}

type scenarioResult struct {
	scenario
	Active bool   `json:"active"`
	Steps  []step `json:"steps"`
}

type normalizeCase struct {
	Name     string `json:"name"`
	Body     string `json:"body"`
	Original string `json:"original,omitempty"`
	Output   string `json:"output,omitempty"`
	Err      string `json:"err,omitempty"`
}

func format(name string) sdktranslator.Format { return sdktranslator.FromString(name) }

func errText(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

func lines(events [][]byte) []string {
	out := make([]string, 0, len(events))
	for _, e := range events {
		out = append(out, string(e))
	}
	return out
}

func run(s scenario) scenarioResult {
	decl := s.Declarations
	if decl == "" {
		decl = s.Original
	}
	state := helps.NewApplyPatchResponsesState(format(s.Source), []byte(s.Original), []byte(decl))
	for _, d := range s.Dispatchers {
		state.AddDispatcher(d[0], d[1])
	}
	result := scenarioResult{scenario: s, Active: state.Active()}
	for _, o := range s.Ops {
		var st step
		switch o.Op {
		case "remember":
			state.RememberDispatcherEvent([]byte(o.Input))
		case "rememberArgs":
			state.RememberDispatcherArguments([]byte(o.Input))
		case "transform":
			events, err := state.Transform([]byte(o.Input))
			st = step{lines(events), errText(err)}
		case "rememberTransform":
			state.RememberDispatcherEvent([]byte(o.Input))
			events, err := state.Transform([]byte(o.Input))
			st = step{lines(events), errText(err)}
		case "stream":
			events, err := state.Stream([]byte(o.Input))
			st = step{lines(events), errText(err)}
		case "finish":
			st = step{nil, errText(state.Finish())}
		case "bridgeFinish":
			st = step{nil, errText(state.Bridge.Finish())}
		case "finishStream":
			events, err := state.FinishStream()
			st = step{lines(events), errText(err)}
		case "nonStream":
			out, err := state.Bridge.TransformNonStream([]byte(o.Input))
			st = step{lines([][]byte{out}), errText(err)}
			if out == nil {
				st.Out = nil
			}
		default:
			panic("unknown op " + o.Op)
		}
		result.Steps = append(result.Steps, st)
	}
	return result
}

func j(format string, args ...any) string { return fmt.Sprintf(format, args...) }

const (
	patchTools    = `{"tools":[{"type":"custom","name":"apply_patch"}]}`
	nsTools       = `{"tools":[{"type":"namespace","name":"n","tools":[{"type":"custom","name":"apply_patch"}]}]}`
	nsLookupTools = `{"tools":[{"type":"namespace","name":"n","tools":[{"type":"custom","name":"apply_patch"},{"type":"function","name":"lookup"}]}]}`
	patchArgs     = `{\"input\":\"*** Begin Patch\\n*** End Patch\"}`
	wrapperPatchP = `{\"name\":\"apply_patch\",\"arguments\":{\"input\":\"p\"}}`
)

func fcAdded(index int, id, call, name, ns string) string {
	extra := ""
	if ns != "" {
		extra = j(`,"namespace":%q`, ns)
	}
	return j(`{"type":"response.output_item.added","output_index":%d,"sequence_number":%d,"item":{"type":"function_call","id":%q,"call_id":%q,"name":%q,"arguments":""%s}}`, index, index+1, id, call, name, extra)
}

func fcDelta(id string, index int, delta string) string {
	return j(`{"type":"response.function_call_arguments.delta","item_id":%q,"output_index":%d,"delta":%q}`, id, index, delta)
}

func fcArgsDone(id string, index int, args string) string {
	return j(`{"type":"response.function_call_arguments.done","item_id":%q,"output_index":%d,"arguments":%q}`, id, index, args)
}

func fcItemDone(index int, id, call, name, ns, args string) string {
	extra := ""
	if ns != "" {
		extra = j(`,"namespace":%q`, ns)
	}
	return j(`{"type":"response.output_item.done","output_index":%d,"item":{"type":"function_call","id":%q,"call_id":%q,"name":%q,"arguments":%q,"status":"completed"%s}}`, index, id, call, name, args, extra)
}

func completed(outputs ...string) string {
	out := ""
	for i, o := range outputs {
		if i > 0 {
			out += ","
		}
		out += o
	}
	return j(`{"type":"response.completed","sequence_number":50,"response":{"id":"resp_1","status":"completed","output":[%s],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}`, out)
}

func fcOutput(id, call, name, ns, args string) string {
	extra := ""
	if ns != "" {
		extra = j(`,"namespace":%q`, ns)
	}
	return j(`{"type":"function_call","id":%q,"call_id":%q,"name":%q,"arguments":%q,"status":"completed"%s}`, id, call, name, args, extra)
}

func tr(in string) op { return op{Op: "transform", Input: in} }
func rt(in string) op { return op{Op: "rememberTransform", Input: in} }
func st(in string) op { return op{Op: "stream", Input: in} }

func scenarios() []scenario {
	created := `{"type":"response.created","sequence_number":0,"response":{"id":"resp_1","status":"in_progress"}}`
	args := `{"input":"*** Begin Patch\n*** Add File: a.txt\n+hi\n*** End Patch"}`
	var out []scenario
	add := func(s scenario) { out = append(out, s) }

	add(scenario{Name: "stream-deltas", Source: "openai-response", Original: patchTools, Ops: []op{
		tr(created),
		tr(fcAdded(0, "fc_1", "call_1", "apply_patch", "")),
		tr(fcDelta("fc_1", 0, `{"input":"*** Begin Patch\n*** Add `)),
		tr(fcDelta("fc_1", 0, `File: a.txt\n+hi\n*** End Patch"}`)),
		tr(fcArgsDone("fc_1", 0, args)),
		tr(fcItemDone(0, "fc_1", "call_1", "apply_patch", "", args)),
		tr(completed(fcOutput("fc_1", "call_1", "apply_patch", "", args))),
		{Op: "finish"},
	}})
	add(scenario{Name: "item-done-only", Source: "codex", Original: patchTools, Ops: []op{
		tr(fcAdded(0, "fc_1", "call_1", "apply_patch", "")),
		tr(fcItemDone(0, "fc_1", "call_1", "apply_patch", "", args)),
		tr(completed(fcOutput("fc_1", "call_1", "apply_patch", "", args))),
	}})
	add(scenario{Name: "terminal-only", Source: "openai-response", Original: patchTools, Ops: []op{
		tr(created),
		tr(completed(`{"type":"message","id":"m1","content":[]}`, fcOutput("fc_1", "call_1", "apply_patch", "", args))),
	}})
	add(scenario{Name: "terminal-incomplete", Source: "openai-response", Original: patchTools, Ops: []op{
		tr(strings("response.incomplete", fcOutput("fc_1", "call_1", "apply_patch", "", args))),
	}})
	add(scenario{Name: "late-name", Source: "openai-response", Original: patchTools, Ops: []op{
		tr(`{"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"fc_1","arguments":""}}`),
		tr(`{"type":"response.function_call_arguments.delta","item_id":"fc_1","output_index":0,"name":"apply_patch","call_id":"call_1","delta":"{\"input\":\"p"}`),
		tr(fcItemDone(0, "fc_1", "call_1", "apply_patch", "", `{"input":"p"}`)),
		tr(completed(fcOutput("fc_1", "call_1", "apply_patch", "", `{"input":"p"}`))),
	}})
	add(scenario{Name: "conflicting-call-id", Source: "openai-response", Original: patchTools, Ops: []op{
		tr(fcAdded(0, "fc_1", "call_1", "apply_patch", "")),
		tr(fcItemDone(0, "fc_1", "call_2", "apply_patch", "", `{"input":"p"}`)),
		tr(completed()),
	}})
	add(scenario{Name: "conflicting-index", Source: "openai-response", Original: patchTools, Ops: []op{
		tr(fcAdded(0, "fc_1", "call_1", "apply_patch", "")),
		tr(fcDelta("fc_1", 3, `{"input":"p"}`)),
	}})
	add(scenario{Name: "invalid-arguments", Source: "openai-response", Original: patchTools, Ops: []op{
		tr(fcAdded(0, "fc_1", "call_1", "apply_patch", "")),
		tr(fcDelta("fc_1", 0, `{"patch":"p"}`)),
		tr(completed()),
	}})
	add(scenario{Name: "extra-field", Source: "openai-response", Original: patchTools, Ops: []op{
		tr(fcAdded(0, "fc_1", "call_1", "apply_patch", "")),
		tr(fcItemDone(0, "fc_1", "call_1", "apply_patch", "", `{"input":"p","x":1}`)),
	}})
	add(scenario{Name: "snapshot-conflicts-with-stream", Source: "openai-response", Original: patchTools, Ops: []op{
		tr(fcAdded(0, "fc_1", "call_1", "apply_patch", "")),
		tr(fcDelta("fc_1", 0, `{"input":"abc`)),
		tr(fcArgsDone("fc_1", 0, `{"input":"xyz"}`)),
	}})
	add(scenario{Name: "conflicting-snapshots", Source: "openai-response", Original: patchTools, Ops: []op{
		tr(fcAdded(0, "fc_1", "call_1", "apply_patch", "")),
		tr(fcArgsDone("fc_1", 0, `{"input":"a"}`)),
		tr(fcItemDone(0, "fc_1", "call_1", "apply_patch", "", `{"input":"b"}`)),
	}})
	add(scenario{Name: "delta-after-completion", Source: "openai-response", Original: patchTools, Ops: []op{
		tr(fcAdded(0, "fc_1", "call_1", "apply_patch", "")),
		tr(fcArgsDone("fc_1", 0, `{"input":"a"}`)),
		tr(fcDelta("fc_1", 0, `x`)),
	}})
	add(scenario{Name: "incomplete-arguments-at-completion", Source: "openai-response", Original: patchTools, Ops: []op{
		tr(fcAdded(0, "fc_1", "call_1", "apply_patch", "")),
		tr(fcDelta("fc_1", 0, `{"input":"abc`)),
		{Op: "finish"},
		tr(completed(fcOutput("fc_1", "call_1", "apply_patch", "", `{"input":"abc"}`))),
		{Op: "finish"},
	}})
	add(scenario{Name: "ordinary-function-passthrough", Source: "openai-response", Original: `{"tools":[{"type":"custom","name":"apply_patch"},{"type":"function","name":"lookup"}]}`, Ops: []op{
		tr(fcAdded(0, "fc_1", "call_1", "lookup", "")),
		tr(fcDelta("fc_1", 0, `{"q":1}`)),
		tr(fcItemDone(0, "fc_1", "call_1", "lookup", "", `{"q":1}`)),
		tr(completed(fcOutput("fc_1", "call_1", "lookup", "", `{"q":1}`))),
		{Op: "finish"},
	}})
	add(scenario{Name: "native-custom-passthrough", Source: "codex", Original: patchTools, Ops: []op{
		tr(`{"type":"response.output_item.added","output_index":0,"item":{"type":"custom_tool_call","id":"a","name":"apply_patch","input":""}}`),
		tr(`{"type":"response.custom_tool_call_input.delta","item_id":"a","output_index":0,"delta":"raw"}`),
		tr(`{"type":"response.output_item.done","output_index":0,"item":{"type":"custom_tool_call","id":"a","call_id":"c","name":"apply_patch","input":"raw"}}`),
		tr(completed(`{"type":"custom_tool_call","id":"a","call_id":"c","name":"apply_patch","input":"raw"}`)),
	}})
	add(scenario{Name: "inactive-bridge", Source: "codex", Original: `{"tools":[{"type":"function","name":"apply_patch"}]}`, Ops: []op{
		tr(fcAdded(0, "fc_1", "call_1", "apply_patch", "")),
		tr(completed(fcOutput("fc_1", "call_1", "apply_patch", "", `ordinary`))),
		{Op: "finishStream"},
		st("data: [DONE]"),
	}})
	add(scenario{Name: "chat-function-preference", Source: "openai", Original: `{"tools":[{"type":"custom","name":"apply_patch"},{"type":"function","function":{"name":"apply_patch"}}]}`,
		Declarations: `{"tools":[{"type":"custom","name":"apply_patch"},{"type":"function","name":"apply_patch"}]}`, Ops: []op{
			tr(`{"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","name":"apply_patch","arguments":"ordinary"}}`),
		}})
	add(scenario{Name: "namespace-child-restored", Source: "openai-response", Original: nsLookupTools, Ops: []op{
		tr(fcAdded(0, "fc_1", "call_1", "n__apply_patch", "")),
		tr(fcDelta("fc_1", 0, `{"input":"p"}`)),
		tr(fcItemDone(0, "fc_1", "call_1", "n__apply_patch", "", `{"input":"p"}`)),
		tr(completed(fcOutput("fc_1", "call_1", "n__apply_patch", "", `{"input":"p"}`))),
		tr(fcAdded(1, "fc_2", "call_2", "n__lookup", "")),
		tr(fcItemDone(1, "fc_2", "call_2", "n__lookup", "", `{"q":1}`)),
	}})
	add(scenario{Name: "two-calls-resequenced", Source: "openai-response", Original: patchTools, Ops: []op{
		tr(created),
		tr(fcAdded(0, "fc_1", "call_1", "apply_patch", "")),
		tr(fcDelta("fc_1", 0, `{"input":"a"}`)),
		tr(fcItemDone(0, "fc_1", "call_1", "apply_patch", "", `{"input":"a"}`)),
		tr(fcAdded(1, "fc_2", "call_2", "apply_patch", "")),
		tr(fcItemDone(1, "fc_2", "call_2", "apply_patch", "", `{"input":"b"}`)),
		tr(completed(fcOutput("fc_1", "call_1", "apply_patch", "", `{"input":"a"}`), fcOutput("fc_2", "call_2", "apply_patch", "", `{"input":"b"}`))),
	}})
	add(scenario{Name: "response-failed", Source: "openai-response", Original: patchTools, Ops: []op{
		tr(fcAdded(0, "fc_1", "call_1", "apply_patch", "")),
		tr(`{"type":"response.failed","response":{"id":"resp_1","error":{"code":"x"}}}`),
		tr(fcDelta("fc_1", 0, `x`)),
		{Op: "finish"},
	}})
	add(scenario{Name: "unicode-and-escapes", Source: "openai-response", Original: patchTools, Ops: []op{
		tr(fcAdded(0, "fc_1", "call_1", "apply_patch", "")),
		tr(fcDelta("fc_1", 0, `{"input":"\u00e9\ud83d`)),
		tr(fcDelta("fc_1", 0, `\ude00 <&> \"q\" \\ \n"}`)),
		tr(fcItemDone(0, "fc_1", "call_1", "apply_patch", "", `{"input":"é😀 <&> \"q\" \\ \n"}`)),
		tr(completed(fcOutput("fc_1", "call_1", "apply_patch", "", `{"input":"é😀 <&> \"q\" \\ \n"}`))),
	}})

	// SSE line handling.
	add(scenario{Name: "sse-native-bytes", Source: "codex", Original: patchTools, Ops: []op{
		st("event: response.output_item.done"),
		st(`data:   { "type":"response.output_item.done", "output_index":0, "item":{"type":"custom_tool_call","id":"a","name":"apply_patch","input":"raw"}}  `),
		st(""),
		st("event: response.completed"),
		st(`data:  { "type":"response.completed", "sequence_number":8,"response":{"output":[{"type":"custom_tool_call","id":"a","name":"apply_patch","input":"raw"}]}} `),
	}})
	add(scenario{Name: "sse-converted", Source: "openai-response", Original: patchTools, Ops: []op{
		st("event: response.created"), st("data: " + created), st(""),
		st("event: response.output_item.added"), st("data: " + fcAdded(0, "fc_1", "call_1", "apply_patch", "")), st(""),
		st("event: response.function_call_arguments.delta"), st("data: " + fcDelta("fc_1", 0, `{"input":"abc"}`)), st(""),
		st("event: response.function_call_arguments.done"), st("data: " + fcArgsDone("fc_1", 0, `{"input":"abc"}`)), st(""),
		st("event: response.output_item.done"), st("data: " + fcItemDone(0, "fc_1", "call_1", "apply_patch", "", `{"input":"abc"}`)), st(""),
		st("event: response.completed"), st("data: " + completed(fcOutput("fc_1", "call_1", "apply_patch", "", `{"input":"abc"}`))), st(""),
		st("data: [DONE]"),
		{Op: "finishStream"},
	}})
	add(scenario{Name: "sse-failure-and-comments", Source: "openai-response", Original: patchTools, Ops: []op{
		st(": keepalive"),
		st("event: response.output_item.added"), st("data: " + fcAdded(0, "fc_1", "call_1", "apply_patch", "")),
		st("event: response.function_call_arguments.delta"), st("data: " + fcDelta("fc_1", 0, `{"bad":1}`)),
		st("data: " + fcDelta("fc_1", 0, `more`)),
		{Op: "finishStream"},
	}})
	add(scenario{Name: "sse-premature-done", Source: "openai-response", Original: patchTools, Ops: []op{
		st("event: response.output_item.added"), st("data: " + fcAdded(0, "fc_1", "call_1", "apply_patch", "")),
		st("data: [DONE]"),
		st("data: " + created),
		{Op: "finishStream"},
	}})
	add(scenario{Name: "sse-eof-without-terminal", Source: "codex", Original: patchTools, Ops: []op{
		tr(fcAdded(0, "fc_1", "call_1", "apply_patch", "")),
		tr(fcItemDone(0, "fc_1", "call_1", "apply_patch", "", `{"input":"p"}`)),
		{Op: "finishStream"},
		{Op: "finishStream"},
	}})
	add(scenario{Name: "sse-invalid-json", Source: "openai-response", Original: patchTools, Ops: []op{
		st("event: x"), st("data: not json"), st("data: [1,2]"), st("id: 5"),
	}})

	// Non-stream bridge.
	add(scenario{Name: "nonstream-bare", Source: "openai-response", Original: patchTools, Ops: []op{
		{Op: "nonStream", Input: j(`{"id":"resp_1","object":"response","output":[%s]}`, fcOutput("fc_1", "call_1", "apply_patch", "", args))},
		{Op: "bridgeFinish"},
	}})
	add(scenario{Name: "nonstream-envelope", Source: "openai-response", Original: nsLookupTools, Ops: []op{
		{Op: "nonStream", Input: completed(fcOutput("fc_1", "call_1", "n__apply_patch", "", args), fcOutput("fc_2", "call_2", "n__lookup", "", `{"q":1}`))},
	}})
	add(scenario{Name: "nonstream-invalid", Source: "openai-response", Original: patchTools, Ops: []op{
		{Op: "nonStream", Input: j(`{"output":[%s]}`, fcOutput("fc_1", "call_1", "apply_patch", "", `{"nope":1}`))},
		{Op: "bridgeFinish"},
	}})
	add(scenario{Name: "nonstream-conflict", Source: "openai-response", Original: patchTools, Ops: []op{
		{Op: "nonStream", Input: j(`{"output":[%s,%s]}`, fcOutput("fc_1", "call_1", "apply_patch", "", `{"input":"a"}`), fcOutput("fc_1", "call_2", "apply_patch", "", `{"input":"a"}`))},
	}})

	// Dispatchers (xAI folded namespaces).
	for _, key := range []string{`"output_index":0`, `"call_id":"c"`, `"item_id":"a"`} {
		for _, terminalOnly := range []bool{false, true} {
			item := `{"type":"function_call","id":"a","call_id":"c","name":"apply_patch","namespace":"n","arguments":"{\"input\":\"p\"}"}`
			final := `{"type":"response.output_item.done","output_index":0,"item":` + item + `}`
			if terminalOnly {
				final = `{"type":"response.completed","response":{"output":[` + item + `]}}`
			}
			add(scenario{Name: fmt.Sprintf("dispatcher-key-%s-%v", key, terminalOnly), Source: "openai-response", Original: nsLookupTools, Dispatchers: [][2]string{{"n", "n"}}, Ops: []op{
				tr(`{"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"a","call_id":"c","name":"n","namespace":"n","arguments":""}}`),
				tr(`{"type":"response.function_call_arguments.delta",` + key + `,"delta":"{\"name\":\"apply_patch\",\"arguments\":{\"input\":\"p\"}}"}`),
				tr(final),
				{Op: "bridgeFinish"},
				{Op: "finish"},
			}})
		}
	}
	for _, lateName := range []string{"n", "apply_patch"} {
		add(scenario{Name: "dispatcher-omitted-arguments-" + lateName, Source: "openai-response", Original: nsTools, Dispatchers: [][2]string{{"n", "n"}}, Ops: []op{
			tr(`{"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"a","call_id":"c","name":"n","arguments":""}}`),
			tr(`{"type":"response.function_call_arguments.delta","output_index":0,"item_id":"a","delta":"{\"name\":\"apply_patch\",\"arguments\":{\"input\":\"p\"}}"}`),
			tr(j(`{"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","id":"a","call_id":"c","name":%q,"namespace":"n"}}`, lateName)),
		}})
	}
	add(scenario{Name: "dispatcher-closed-response", Source: "openai-response", Original: nsTools, Dispatchers: [][2]string{{"n", "n"}}, Ops: []op{
		tr(`{"type":"response.completed","response":{"output":[{"type":"function_call","id":"a","call_id":"c","namespace":"n","name":"apply_patch","arguments":"{\"input\":\"p\"}"}]}}`),
		tr(`{"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"a","call_id":"changed","name":"n","arguments":""}}`),
		{Op: "finish"},
	}})
	add(scenario{Name: "dispatcher-ordinary-progress", Source: "openai-response", Original: nsLookupTools, Dispatchers: [][2]string{{"n", "n"}}, Ops: []op{
		rt(`{"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"a","name":"lookup","namespace":"n","arguments":""}}`),
		rt(`{"type":"response.function_call_arguments.delta","item_id":"a","delta":"{\"x\":1}"}`),
		rt(`{"type":"response.function_call_arguments.done","item_id":"a","arguments":"{\"x\":1}"}`),
		rt(`{"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","id":"a","call_id":"c","name":"lookup","namespace":"n","arguments":"{\"x\":1}"}}`),
	}})
	for _, closeAt := range []string{"response", "sentinel", "upstream_failure", "local_failure"} {
		ops := []op{
			rt(`{"type":"response.output_item.added","output_index":2,"item":{"type":"function_call","id":"a"}}`),
			rt(`{"type":"response.function_call_arguments.done","item_id":"a","arguments":"{\"name\":\"apply_patch\",\"arguments\":{\"input\":\"p\"}}"}`),
			tr(`{"type":"response.output_item.done","output_index":2,"item":{"type":"function_call","id":"a","call_id":"c","name":"n"}}`),
			{Op: "bridgeFinish"},
			{Op: "finish"},
		}
		switch closeAt {
		case "response":
			ops = append(ops, tr(`{"type":"response.completed","response":{"output":[{"type":"function_call","id":"a","call_id":"c","name":"n"}]}}`))
		case "sentinel":
			ops = append(ops, st("data: [DONE]"))
		case "upstream_failure":
			ops = append(ops, tr(`{"type":"response.failed","response":{"output":[]}}`))
		case "local_failure":
			ops = append(ops, tr(`{"type":"response.output_item.done","output_index":3,"item":{"type":"function_call","id":"a","name":"n"}}`))
		}
		ops = append(ops, tr(`{"type":"response.output_item.done","output_index":2,"item":{"type":"function_call","id":"a","name":"n"}}`))
		add(scenario{Name: "dispatcher-lifecycle-" + closeAt, Source: "openai-response", Original: nsTools, Dispatchers: [][2]string{{"n", "n"}}, Ops: ops})
	}
	add(scenario{Name: "dispatcher-late-child-namespace", Source: "openai-response", Original: nsTools, Dispatchers: [][2]string{{"n", "n"}}, Ops: []op{
		rt(`{"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"a","name":"n","arguments":""}}`),
		rt(`{"type":"response.function_call_arguments.done","item_id":"a","arguments":"{\"name\":\"apply_patch\",\"arguments\":{\"input\":\"p\"}}"}`),
		rt(`{"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","id":"a","call_id":"c","name":"apply_patch"}}`),
	}})
	add(scenario{Name: "dispatcher-terminal-source-identity", Source: "openai-response", Original: nsTools, Dispatchers: [][2]string{{"n", "n"}}, Ops: []op{
		rt(`{"type":"response.output_item.added","output_index":1,"item":{"type":"function_call","id":"a","name":"n","arguments":""}}`),
		rt(`{"type":"response.function_call_arguments.done","item_id":"a","arguments":"{\"name\":\"apply_patch\",\"arguments\":{\"input\":\"p\"}}"}`),
		rt(`{"type":"response.output_item.done","output_index":1,"item":{"type":"function_call","id":"a","call_id":"c","name":"n"}}`),
		{Op: "remember", Input: `{"type":"response.completed","response":{"output":[{"type":"message","id":"removed"},{"type":"function_call","id":"a","call_id":"c","name":"n","namespace":"other"}]}}`},
		tr(`{"type":"response.completed","response":{"output":[{"type":"function_call","id":"a","call_id":"c","name":"n","namespace":"n"}]}}`),
	}})
	add(scenario{Name: "dispatcher-index-only-terminal", Source: "openai-response", Original: nsTools, Dispatchers: [][2]string{{"n", "n"}}, Ops: []op{
		rt(`{"type":"response.output_item.added","output_index":0,"item":{"type":"function_call"}}`),
		rt(`{"type":"response.function_call_arguments.done","output_index":0,"arguments":"{\"name\":\"apply_patch\",\"arguments\":{\"input\":\"p\"}}"}`),
		rt(`{"type":"response.function_call_arguments.done","output_index":0,"item_id":"a","call_id":"c","arguments":"{\"name\":\"apply_patch\",\"arguments\":{\"input\":\"p\"}}"}`),
		rt(`{"type":"response.completed","response":{"output":[{"type":"function_call","name":"n"}]}}`),
	}})
	add(scenario{Name: "dispatcher-completed-ordinary-delta", Source: "openai-response", Original: nsLookupTools, Dispatchers: [][2]string{{"n", "n"}}, Ops: []op{
		rt(`{"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"a","name":"n"}}`),
		rt(`{"type":"response.function_call_arguments.done","item_id":"a","arguments":"{\"name\":\"lookup\",\"arguments\":{\"x\":1}}"}`),
		rt(`{"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","id":"a","call_id":"c","name":"n"}}`),
		rt(`{"type":"response.function_call_arguments.delta","item_id":"a","delta":"ordinary"}`),
	}})
	add(scenario{Name: "dispatcher-ordinary-child-arguments", Source: "openai-response", Original: nsLookupTools, Dispatchers: [][2]string{{"n", "n"}}, Ops: []op{
		tr(`{"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"a","name":"n","arguments":""}}`),
		rt(`{"type":"response.function_call_arguments.done","item_id":"a","arguments":"{\"name\":\"lookup\",\"arguments\":{\"name\":\"apply_patch\",\"arguments\":{\"input\":\"not patch\"}}}"}`),
		tr(`{"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","id":"a","call_id":"late","name":"n","namespace":"n"}}`),
	}})
	add(scenario{Name: "dispatcher-conflicting-child", Source: "openai-response", Original: nsLookupTools, Dispatchers: [][2]string{{"n", "n"}}, Ops: []op{
		tr(`{"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"a","name":"n","arguments":""}}`),
		tr(`{"type":"response.function_call_arguments.delta","item_id":"a","delta":"{\"name\":\"apply_patch\",\"arguments\":{\"input\":\"p\"}}"}`),
		tr(`{"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","id":"a","call_id":"late","name":"lookup","namespace":"n"}}`),
	}})
	add(scenario{Name: "dispatcher-conflicting-namespace", Source: "openai-response", Original: nsTools, Dispatchers: [][2]string{{"n", "n"}}, Ops: []op{
		tr(`{"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"a","name":"n","namespace":"n","arguments":""}}`),
		tr(`{"type":"response.function_call_arguments.delta","item_id":"a","delta":"{\"name\":\"apply_patch\",\"arguments\":{\"input\":\"p\"}}"}`),
		tr(`{"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","id":"a","call_id":"c","name":"n","namespace":"zzz","arguments":"{\"name\":\"apply_patch\",\"arguments\":{\"input\":\"p\"}}"}}`),
	}})
	add(scenario{Name: "dispatcher-snapshots-all-matched", Source: "openai-response", Original: nsTools, Dispatchers: [][2]string{{"n", "n"}}, Ops: []op{
		tr(`{"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"i0","call_id":"c0","name":"n","arguments":""}}`),
		tr(`{"type":"response.output_item.added","output_index":1,"item":{"type":"function_call","id":"i1","call_id":"c1","name":"n","arguments":""}}`),
		tr(`{"type":"response.output_item.added","output_index":2,"item":{"type":"function_call","id":"i2","call_id":"c2","name":"n","arguments":""}}`),
		{Op: "rememberArgs", Input: `{"type":"response.function_call_arguments.done","output_index":0,"item_id":"i1","call_id":"c2","arguments":"{\"name\":\"apply_patch\",\"arguments\":{\"input\":\"p\"}}"}`},
		tr(`{"type":"response.function_call_arguments.done","output_index":0,"item_id":"i1","call_id":"c2","arguments":"{\"input\":\"p\"}"}`),
		tr(`{"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","id":"i0","call_id":"c0","name":"n"}}`),
	}})
	add(scenario{Name: "dispatcher-sse", Source: "openai-response", Original: nsTools, Dispatchers: [][2]string{{"n", "n"}}, Ops: []op{
		st("event: response.output_item.added"),
		st(`data: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"a","call_id":"c","name":"n","arguments":""}}`),
		st("event: response.function_call_arguments.done"),
		st(`data: {"type":"response.function_call_arguments.done","item_id":"a","output_index":0,"arguments":"{\"name\":\"apply_patch\",\"arguments\":{\"input\":\"p\"}}"}`),
		st("event: response.output_item.done"),
		st(`data: {"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","id":"a","call_id":"c","name":"n","namespace":"n"}}`),
		st("event: response.completed"),
		st("data: " + completed(`{"type":"function_call","id":"a","call_id":"c","name":"n","namespace":"n"}`)),
		st("data: [DONE]"),
	}})
	add(scenario{Name: "dispatcher-eof", Source: "openai-response", Original: nsTools, Dispatchers: [][2]string{{"n", "n"}}, Ops: []op{
		rt(`{"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"a","name":"n","namespace":"n","arguments":""}}`),
		{Op: "finishStream"},
	}})
	return out
}

func strings(kind, output string) string {
	return fmt.Sprintf(`{"type":%q,"response":{"id":"resp_1","status":"incomplete","output":[%s]}}`, kind, output)
}

func normalizeCases() []normalizeCase {
	cases := []normalizeCase{
		{Name: "top-level", Body: `{"model":"m","tools":[{"type":"custom","name":"apply_patch","description":"Freeform. This is a FREEFORM tool, so do not wrap the patch in JSON.","format":{"type":"grammar","syntax":"lark","definition":"start: x\n*** Environment ID: y"}},{"type":"function","name":"other"}]}`},
		{Name: "duplicate-winners", Body: `{"tools":[{"type":"function","name":"apply_patch","parameters":{"type":"object"}},{"type":"custom","name":"apply_patch"}]}`},
		{Name: "custom-first-duplicate", Body: `{"tools":[{"type":"custom","name":"apply_patch"},{"type":"function","name":"apply_patch","parameters":{"type":"object"}}]}`},
		{Name: "namespace", Body: `{"tools":[{"type":"namespace","name":"n","tools":[{"type":"custom","name":"apply_patch"},{"type":"function","name":"lookup"}]},{"type":"namespace","name":"m","children":[{"type":"custom","name":"apply_patch"}]}]}`},
		{Name: "additional-tools", Body: `{"input":[{"type":"additional_tools","tools":[{"type":"custom","name":"apply_patch"}]},{"type":"message","role":"user","content":"x"}],"tools":[{"type":"custom","name":"apply_patch"}]}`},
		{Name: "history", Body: `{"input":[{"type":"custom_tool_call","call_id":"c1","name":"apply_patch","input":"*** Begin Patch\n<&>\n*** End Patch"},{"type":"custom_tool_call_output","call_id":"c1","output":"ok"},{"type":"custom_tool_call","call_id":"c2","name":"other","input":"x"},{"type":"custom_tool_call_output","call_id":"c2","output":"ok"}]}`},
		{Name: "history-non-string", Body: `{"input":[{"type":"custom_tool_call","call_id":"c1","name":"apply_patch","input":{"a":1}}]}`},
		{Name: "tool-choice", Body: `{"tools":[{"type":"custom","name":"apply_patch"}],"tool_choice":{"type":"custom","name":"apply_patch"}}`},
		{Name: "tool-choice-allowed", Body: `{"tools":[{"type":"namespace","name":"n","tools":[{"type":"custom","name":"apply_patch"}]}],"tool_choice":{"type":"allowed_tools","mode":"auto","tools":[{"type":"custom","name":"apply_patch","namespace":"n"},{"type":"function","name":"x"}]}}`},
		{Name: "no-patch", Body: `{"tools":[{"type":"custom","name":"other","format":{"type":"text"}}],"tool_choice":"auto"}`},
		{Name: "chat-preference", Body: `{"tools":[{"type":"custom","name":"apply_patch"},{"type":"function","name":"apply_patch","parameters":{"type":"object","properties":{"x":{"type":"integer"}}}}]}`,
			Original: `{"tools":[{"type":"custom","name":"apply_patch"},{"type":"function","function":{"name":"apply_patch","parameters":{"type":"object","properties":{"x":{"type":"integer"}}}}}]}`},
		{Name: "original-without-functions", Body: `{"tools":[{"type":"custom","name":"apply_patch"}]}`, Original: `{"tools":[{"type":"custom","name":"apply_patch"}]}`},
	}
	for i := range cases {
		var out []byte
		var err error
		if cases[i].Original != "" {
			out, err = helps.NormalizeApplyPatchResponsesRequest([]byte(cases[i].Body), []byte(cases[i].Original))
		} else {
			out, err = helps.NormalizeApplyPatchResponsesRequest([]byte(cases[i].Body))
		}
		cases[i].Output = string(out)
		cases[i].Err = errText(err)
		if err != nil {
			cases[i].Output = ""
		}
	}
	return cases
}

func main() {
	outPath := flag.String("out", "workers/test/fixtures/applypatch.json", "output file")
	flag.Parse()
	var results []scenarioResult
	for _, s := range scenarios() {
		results = append(results, run(s))
	}
	doc := map[string]any{"scenarios": results, "normalize": normalizeCases()}
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
	fmt.Printf("wrote %s (%d scenarios)\n", *outPath, len(results))
}
