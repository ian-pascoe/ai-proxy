// Command devin emits golden fixtures for the TypeScript Devin executor (workers/src/executor/devin).
//
// The scenarios run the real Go DevinExecutor against an httptest Connect-RPC server: the request bytes it sends
// (BuildDevinGetChatMessageRequest + payload rules), the Interactions events/aggregate it produces from canned
// response frames, and the helper outputs (model UID resolution, trailer error mapping, frame parsing) become the
// fixtures. Random identifiers are normalised. Run from the repository root:
//
//	go run ./workers/tools/fixturegen/devin
package main

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/router-for-me/CLIProxyAPI/v8/internal/config"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/runtime/executor"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/runtime/executor/helps"
	_ "github.com/router-for-me/CLIProxyAPI/v8/internal/translator"
	cliproxyauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	cliproxyexecutor "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/executor"
	sdktranslator "github.com/router-for-me/CLIProxyAPI/v8/sdk/translator"
	"google.golang.org/protobuf/encoding/protowire"
)

// ---- protobuf builder for canned response frames -------------------------------------------------------------

type msg struct{ b []byte }

func (m *msg) str(n protowire.Number, s string) *msg {
	m.b = protowire.AppendTag(m.b, n, protowire.BytesType)
	m.b = protowire.AppendString(m.b, s)
	return m
}

func (m *msg) bytes(n protowire.Number, v []byte) *msg {
	m.b = protowire.AppendTag(m.b, n, protowire.BytesType)
	m.b = protowire.AppendBytes(m.b, v)
	return m
}

func (m *msg) varint(n protowire.Number, v uint64) *msg {
	m.b = protowire.AppendTag(m.b, n, protowire.VarintType)
	m.b = protowire.AppendVarint(m.b, v)
	return m
}

func (m *msg) f64(n protowire.Number, v float64) *msg {
	m.b = protowire.AppendTag(m.b, n, protowire.Fixed64Type)
	m.b = protowire.AppendFixed64(m.b, math.Float64bits(v))
	return m
}

func (m *msg) f32(n protowire.Number, v float32) *msg {
	m.b = protowire.AppendTag(m.b, n, protowire.Fixed32Type)
	m.b = protowire.AppendFixed32(m.b, math.Float32bits(v))
	return m
}

func newMsg() *msg { return &msg{} }

func toolCallDelta(id, name, args string) []byte {
	m := newMsg()
	if id != "" {
		m.str(1, id)
	}
	if name != "" {
		m.str(2, name)
	}
	if args != "" {
		m.str(3, args)
	}
	return m.b
}

func usageField(prompt, completion, cached uint64, model string) []byte {
	return newMsg().varint(2, prompt).varint(3, completion).varint(5, cached).
		bytes(8, newMsg().str(1, "x-request-id").str(2, "req-123").b).str(9, model).b
}

func dimensionGroup(input, output, cached float32) []byte {
	metric := func(key string, v float32) []byte {
		return newMsg().str(5, key).bytes(4, newMsg().f32(2, v).b).b
	}
	return newMsg().str(1, "Token Usage").bytes(2, metric("input_tokens", input)).
		bytes(2, metric("output_tokens", output)).bytes(2, metric("cached_input_tokens", cached)).b
}

// ---- Connect framing ---------------------------------------------------------------------------------------------

type frameSpec struct {
	Flag int    `json:"flag"`
	Hex  string `json:"hex"`
}

func plain(payload []byte) frameSpec { return frameSpec{Flag: 0, Hex: hex.EncodeToString(payload)} }

func trailer(js string) frameSpec { return frameSpec{Flag: 2, Hex: hex.EncodeToString([]byte(js))} }

func gzipped(payload []byte) frameSpec {
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	_, _ = zw.Write(payload)
	_ = zw.Close()
	return frameSpec{Flag: 1, Hex: hex.EncodeToString(buf.Bytes())}
}

func envelope(f frameSpec) []byte {
	payload, _ := hex.DecodeString(f.Hex)
	out := make([]byte, 5, 5+len(payload))
	out[0] = byte(f.Flag)
	binary.BigEndian.PutUint32(out[1:5], uint32(len(payload)))
	return append(out, payload...)
}

// ---- scenarios ---------------------------------------------------------------------------------------------------

type scenario struct {
	Name       string      `json:"name"`
	Model      string      `json:"model"`
	Payload    string      `json:"payload"`
	ConfigYAML string      `json:"configYaml,omitempty"`
	Frames     []frameSpec `json:"frames"`
	// Turns > 1 repeats the streaming call without resetting the session counter.
	Turns int `json:"turns,omitempty"`
}

type captured struct {
	BodyHex    string              `json:"bodyHex"`
	Headers    map[string][]string `json:"headers"`
	UserAgents []string            `json:"userAgents"`
}

type outcome struct {
	Payload string   `json:"payload,omitempty"`
	Chunks  []string `json:"chunks,omitempty"`
	Status  int      `json:"status,omitempty"`
	Error   string   `json:"error,omitempty"`
}

type result struct {
	scenario
	Requests  []captured `json:"requests"`
	Stream    outcome    `json:"stream"`
	NonStream outcome    `json:"nonStream"`
}

var idPattern = regexp.MustCompile(`interaction_[0-9a-f-]{12}`)

func normalize(s string) string { return idPattern.ReplaceAllString(s, "interaction_ID") }

type statusCoder interface{ StatusCode() int }

func errOutcome(err error) outcome {
	out := outcome{Error: err.Error()}
	if sc, ok := err.(statusCoder); ok {
		out.Status = sc.StatusCode()
	}
	return out
}

func sessionOf(payload string) string {
	var p struct {
		SessionID string `json:"session_id"`
	}
	_ = json.Unmarshal([]byte(payload), &p)
	return p.SessionID
}

func run(sc scenario) result {
	res := result{scenario: sc}
	var requests []captured
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		headers := map[string][]string{}
		for _, name := range []string{"Authorization", "Content-Type", "Connect-Protocol-Version", "Accept"} {
			headers[name] = r.Header.Values(name)
		}
		headers["Sentry-Trace-Present"] = []string{fmt.Sprint(r.Header.Get("Sentry-Trace") != "")}
		requests = append(requests, captured{BodyHex: hex.EncodeToString(body[5:]), Headers: headers, UserAgents: r.Header["User-Agent"]})
		w.Header().Set("Content-Type", "application/connect+proto")
		for _, f := range sc.Frames {
			_, _ = w.Write(envelope(f))
		}
	}))
	defer server.Close()

	cfg := &config.Config{}
	if sc.ConfigYAML != "" {
		parsed, err := config.ParseConfigBytes([]byte(sc.ConfigYAML))
		if err != nil {
			fmt.Fprintf(os.Stderr, "scenario %q config: %v\n", sc.Name, err)
			os.Exit(1)
		}
		cfg = parsed
	}
	exec := executor.NewDevinExecutor(cfg)
	auth := &cliproxyauth.Auth{
		ID:       "devin-1",
		Provider: "devin",
		Attributes: map[string]string{
			"api_key":     "devin-session-token$test",
			"base_url":    server.URL,
			"device_seed": "seed-1",
		},
	}
	session := sessionOf(sc.Payload)
	opts := func(stream bool) cliproxyexecutor.Options {
		return cliproxyexecutor.Options{Stream: stream, SourceFormat: sdktranslator.FormatInteractions, Headers: http.Header{}}
	}
	request := cliproxyexecutor.Request{Model: sc.Model, Payload: []byte(sc.Payload)}

	turns := sc.Turns
	if turns < 1 {
		turns = 1
	}
	for i := 0; i < turns; i++ {
		if i == 0 {
			helps.ResetDevinSessionTurnIndex(session)
		}
		stream, err := exec.ExecuteStream(context.Background(), auth, request, opts(true))
		if err != nil {
			res.Stream = errOutcome(err)
			continue
		}
		var chunks []string
		var streamErr error
		for chunk := range stream.Chunks {
			if chunk.Err != nil {
				streamErr = chunk.Err
				break
			}
			chunks = append(chunks, normalize(string(chunk.Payload)))
		}
		res.Stream = outcome{Chunks: chunks}
		if streamErr != nil {
			res.Stream = errOutcome(streamErr)
			res.Stream.Chunks = chunks
		}
	}
	if turns == 1 {
		helps.ResetDevinSessionTurnIndex(session)
		resp, err := exec.Execute(context.Background(), auth, request, opts(false))
		if err != nil {
			res.NonStream = errOutcome(err)
		} else {
			res.NonStream = outcome{Payload: normalize(string(resp.Payload))}
		}
	}
	res.Requests = requests
	return res
}

// ---- helper fixtures ---------------------------------------------------------------------------------------------

type modelUIDCase struct {
	Model  string `json:"model"`
	Level  string `json:"level"`
	Budget int    `json:"budget"`
	UID    string `json:"uid"`
}

type trailerCase struct {
	JSON    string `json:"json"`
	Status  int    `json:"status"`
	Message string `json:"message,omitempty"`
}

type frameCase struct {
	Name string `json:"name"`
	Hex  string `json:"hex"`
	// Decoded fields (Go ParseDevinFrame).
	Content    string           `json:"content"`
	Thinking   string           `json:"thinking"`
	Signature  string           `json:"signature"`
	SigType    string           `json:"signatureType"`
	OutputID   string           `json:"outputId"`
	MessageID  string           `json:"messageId"`
	Timestamp  uint64           `json:"timestamp"`
	StopReason uint64           `json:"stopReason"`
	ToolCalls  []map[string]any `json:"toolCalls"`
	Usage      map[string]any   `json:"usage,omitempty"`
	Unknown    []int            `json:"unknown"`
	Dimension  map[string]int64 `json:"dimension,omitempty"`
}

type promptCase struct {
	Name     string   `json:"name"`
	Words    []string `json:"words"`
	Input    string   `json:"input"`
	Expected string   `json:"expected"`
}

type fixtures struct {
	Scenarios    []result          `json:"scenarios"`
	ModelUIDs    []modelUIDCase    `json:"modelUids"`
	Trailers     []trailerCase     `json:"trailers"`
	Frames       []frameCase       `json:"frames"`
	Prompts      []promptCase      `json:"systemPrompts"`
	Envelope     []string          `json:"envelopes"`
	Fingerprints map[string]string `json:"fingerprints"`
}

func parseFrameCase(name string, payload []byte, groups bool) frameCase {
	f, err := helps.ParseDevinFrame(payload)
	if err != nil {
		fmt.Fprintf(os.Stderr, "frame %q: %v\n", name, err)
		os.Exit(1)
	}
	fc := frameCase{
		Name: name, Hex: hex.EncodeToString(payload), Content: f.ContentText, Thinking: f.ThinkingText,
		Signature: string(f.DeltaSignature), SigType: f.DeltaSignatureType, OutputID: f.OutputID, MessageID: f.MessageID,
		Timestamp: f.Timestamp, StopReason: f.StopReason, Unknown: f.UnknownFieldNumbers,
	}
	fc.ToolCalls = []map[string]any{}
	for _, tc := range f.ToolCallDeltas {
		fc.ToolCalls = append(fc.ToolCalls, map[string]any{
			"id": tc.ID, "name": tc.Name, "arguments": tc.Arguments, "invalidJsonStr": tc.InvalidJSONStr,
			"invalidJsonErr": tc.InvalidJSONErr, "isCustomToolCall": tc.IsCustomToolCall,
		})
	}
	if f.Usage != nil {
		fc.Usage = map[string]any{
			"promptTokens": f.Usage.PromptTokens, "completionTokens": f.Usage.CompletionTokens,
			"cachedTokens": f.Usage.CachedTokens, "cacheWriteTokens": f.Usage.CacheWriteTokens,
			"statusCode": f.Usage.StatusCode, "requestId": f.Usage.RequestID, "modelName": f.Usage.ModelName,
		}
	}
	if groups && len(f.ResponseDimensionGroups) > 0 {
		in, out, cached, ok := helps.ParseDevinResponseDimensionGroups(f.ResponseDimensionGroups...)
		if ok {
			fc.Dimension = map[string]int64{"input": in, "output": out, "cached": cached}
		}
	}
	return fc
}

func main() {
	outPath := flag.String("out", "workers/test/fixtures/devin.json", "output file")
	flag.Parse()

	text := func(s string) frameSpec { return plain(newMsg().str(3, s).b) }
	userHi := `{"session_id":"11111111-1111-4111-8111-111111111111","input":[{"type":"user_input","content":"hi"}],"generation_config":{"temperature":0.5,"max_output_tokens":256}}`
	richHistory := `{"session_id":"22222222-2222-4222-8222-222222222222","system_instruction":"You are Claude Code, Anthropic's CLI.\nKeep answers short.\nUse tools when needed.","generation_config":{"max_output_tokens":30000,"thinking_level":"high"},"input":[` +
		`{"type":"user_input","content":"list files"},` +
		`{"type":"thought","content":[{"type":"text","text":"I should call ls"}],"signature":"claude#EqQBCkYIAxgCKkBsealed"},` +
		`{"type":"model_output","content":[{"type":"text","text":"Let me look."}]},` +
		`{"type":"function_call","id":"call_1","name":"ls","arguments":{"path":"."}},` +
		`{"type":"function_result","call_id":"call_1","result":"a.txt\nb.txt"},` +
		`{"type":"function_result","call_id":"call_orphan","result":"stray"},` +
		`{"type":"user_input","content":[{"type":"text","text":"thanks"},{"type":"image","data":"aGVsbG8=","mime_type":"image/jpeg"}]}],` +
		`"tools":[{"name":"ls","description":"List. Takes a task_id parameter identifying the task","parameters":{"type":"object","properties":{"path":{"type":"string"}}}},{"name":"exec_command","description":"Runs a command returning output or a session ID for ongoing interaction","parameters":{"type":"object"}},{"name":"mcp__codex_app__automation_update","description":"skip me"}]}`
	overrideYAML := "payload:\n  override:\n    - models:\n        - name: \"swe-2*\"\n          protocol: devin\n      params:\n        completion_config.temperature: 0.25\n        system_prompt: OVERRIDDEN\n"
	toolFrames := []frameSpec{
		plain(newMsg().bytes(6, toolCallDelta("call_a", "Read", `{"pa`)).b),
		plain(newMsg().bytes(6, toolCallDelta("", "", `th":"x"}`)).b),
		plain(newMsg().bytes(6, toolCallDelta("call_b", "Bash", `{"command":"ls"}`)).b),
		text("done"),
		plain(newMsg().varint(5, 10).bytes(7, usageField(10, 5, 2, "gpt-x")).b),
		trailer("{}"),
	}

	scenarios := []scenario{
		{Name: "text-basic", Model: "swe-2", Payload: userHi, Frames: []frameSpec{
			plain(newMsg().str(1, "out_1").str(17, "msg_1").bytes(2, newMsg().varint(1, 1700000000).b).str(3, "Hel").b),
			text("lo"), plain(newMsg().varint(5, 2).bytes(7, usageField(20, 7, 4, "swe-2-high")).b), trailer("{}"),
		}},
		{Name: "history-tools-images", Model: "claude-opus-4-6", Payload: richHistory, Frames: []frameSpec{text("ok"), trailer("{}")}},
		{Name: "second-turn", Model: "swe-2", Payload: strings.Replace(userHi, "1111", "3333", -1), Turns: 2, Frames: []frameSpec{text("x"), trailer("{}")}},
		{Name: "payload-rules", Model: "swe-2", Payload: strings.Replace(userHi, "1111", "4444", -1), ConfigYAML: overrideYAML, Frames: []frameSpec{text("x"), trailer("{}")}},
		{Name: "thinking-signature", Model: "gemini-3-flash", Payload: strings.Replace(userHi, "1111", "5555", -1), Frames: []frameSpec{
			plain(newMsg().str(9, "Let me ").b),
			plain(newMsg().str(9, "think").bytes(10, []byte("sealed.v1.abc")).str(21, "sealed").b),
			text("Answer"), plain(newMsg().bytes(10, []byte("def")).b),
			plain(newMsg().varint(5, 4).bytes(28, dimensionGroup(30, 8, 6)).b), trailer("{}"),
		}},
		{Name: "tool-calls-then-text", Model: "swe-2", Payload: strings.Replace(userHi, "1111", "6666", -1), Frames: toolFrames},
		{Name: "utf8-split", Model: "swe-2", Payload: strings.Replace(userHi, "1111", "7777", -1), Frames: []frameSpec{
			plain(newMsg().str(3, "caf\xc3").b), plain(newMsg().str(3, "\xa9 \xe2\x82").b), plain(newMsg().str(3, "\xac!").b), trailer("{}"),
		}},
		{Name: "gzip-frame", Model: "swe-2", Payload: strings.Replace(userHi, "1111", "8888", -1), Frames: []frameSpec{
			gzipped(newMsg().str(3, "zipped").b), trailer("{}"),
		}},
		{Name: "content-filter", Model: "swe-2", Payload: strings.Replace(userHi, "1111", "9999", -1), Frames: []frameSpec{
			text("partial"), plain(newMsg().varint(5, 11).b), trailer("{}"),
		}},
		{Name: "trailer-quota", Model: "swe-2", Payload: strings.Replace(userHi, "1111", "aaaa", -1), Frames: []frameSpec{
			trailer(`{"error":{"code":"failed_precondition","message":"ACU quota exhausted"}}`),
		}},
		{Name: "trailer-after-text", Model: "swe-2", Payload: strings.Replace(userHi, "1111", "bbbb", -1), Frames: []frameSpec{
			text("part"), trailer(`{"error":{"code":"unavailable","message":"overloaded"}}`),
		}},
		{Name: "truncated", Model: "swe-2", Payload: strings.Replace(userHi, "1111", "cccc", -1), Frames: []frameSpec{text("cut")}},
	}

	result := fixtures{Fingerprints: map[string]string{
		"seed-1": helps.GenerateDevinDeviceFingerprint("seed-1"),
	}}
	for _, sc := range scenarios {
		result.Scenarios = append(result.Scenarios, run(sc))
	}

	for _, c := range []modelUIDCase{
		{Model: ""}, {Model: "swe-2"}, {Model: "devin/swe-2"}, {Model: "swe-2-low"}, {Model: "swe-2(medium)"},
		{Model: "swe-2", Level: "xhigh"}, {Model: "swe-2", Budget: 2000}, {Model: "swe-2", Budget: 20000},
		{Model: "claude-haiku-4-5"}, {Model: "gpt-4.1"}, {Model: "claude-sonnet-4-5"}, {Model: "claude-sonnet-4-5", Level: "high"},
		{Model: "gemini-3-flash"}, {Model: "gemini-3-flash", Level: "low"}, {Model: "model_gpt_5_2", Level: "xhigh"},
		{Model: "MODEL_GOOGLE_GEMINI_3_0_FLASH", Level: "minimal"}, {Model: "model_claude_4_5_opus", Level: "high"},
		{Model: "claude-opus-4-6"}, {Model: "claude-opus-4-6", Level: "high"}, {Model: "claude-opus-4-6-1m", Level: "auto"},
		{Model: "claude-sonnet-4-6-1m", Level: "none"}, {Model: "swe-1-7", Level: "medium"}, {Model: "swe-1-6", Level: "fast"},
		{Model: "glm-5-2", Level: "max"}, {Model: "glm-5-2-1m", Level: "none"}, {Model: "glm-5-2:max"},
		{Model: "gpt-5-5"}, {Model: "gpt-5.5", Level: "high"}, {Model: "grok-4-6"}, {Model: "deepseek-v4-flash", Level: "xhigh"},
		{Model: "unknown-model", Level: "high"}, {Model: "kimi-k2-6", Level: "off"},
	} {
		c.UID = helps.ResolveDevinChatModelUID(c.Model, c.Level, c.Budget)
		result.ModelUIDs = append(result.ModelUIDs, c)
	}

	for _, js := range []string{
		``, `{}`, `not json`, `{"error":null}`, `{"error":{"code":5,"message":"x"}}`,
		`{"error":{"code":"invalid_argument","message":"bad"}}`, `{"error":{"code":"invalid_argument","message":"Internal error encountered"}}`,
		`{"error":{"code":"internal","message":"boom"}}`, `{"error":{"code":"unauthenticated","message":"no"}}`,
		`{"error":{"code":"permission_denied","message":"nope"}}`, `{"error":{"code":"permission_denied","message":"High demand now"}}`,
		`{"error":{"code":"resource_exhausted","message":"slow down"}}`, `{"error":{"code":"unavailable","message":"later"}}`,
		`{"error":{"code":"canceled","message":"c"}}`, `{"error":{"code":"deadline_exceeded","message":"t"}}`,
		`{"error":{"code":"failed_precondition","message":"out of credits"}}`, `{"error":{"code":"failed_precondition","message":"bad state"}}`,
		`{"error":{"code":"WEIRD","message":"?"}}`,
	} {
		status, err := helps.ParseDevinTrailerError([]byte(js))
		tc := trailerCase{JSON: js, Status: status}
		if err != nil {
			tc.Message = err.Error()
		}
		result.Trailers = append(result.Trailers, tc)
	}

	result.Frames = append(result.Frames,
		parseFrameCase("text", newMsg().str(1, "o").str(3, "Hi ").str(3, "there").varint(4, 3).b, false),
		parseFrameCase("timestamp-varint", newMsg().varint(2, 1700000001).f64(12, 0.25).b, false),
		parseFrameCase("tool-call", newMsg().bytes(6, newMsg().str(1, "id1").str(2, "fn").str(4, "{bad").str(5, "err").varint(6, 1).b).b, false),
		parseFrameCase("usage", newMsg().bytes(7, usageField(11, 22, 33, "m")).varint(5, 3).b, false),
		parseFrameCase("signature", newMsg().bytes(10, []byte("ab")).bytes(10, []byte("cd")).str(21, "sealed").str(9, "think").b, false),
		parseFrameCase("unknown-fields", newMsg().str(40, "x").varint(41, 1).str(3, "t").b, false),
		parseFrameCase("dimension", newMsg().bytes(28, dimensionGroup(100, 50, 25)).b, true),
	)

	for _, c := range []promptCase{
		{Name: "attribution", Input: "x-anthropic-billing-header: cc_version=1\nYou are Claude Code, the CLI.\nKeep it.\nThis involves authorized security testing here\nFast mode for Claude Code is on\nlast"},
		{Name: "sensitive", Words: []string{"Secret", "x"}, Input: "my secret plan\nsecretive words are kept\nok line"},
		{Name: "crlf", Input: "a\r\nb\r\n"},
	} {
		c.Expected = helps.SanitizeDevinSystemPrompt(c.Input, helps.BuildSensitiveWordMatcher(c.Words))
		result.Prompts = append(result.Prompts, c)
	}
	for _, f := range []frameSpec{plain([]byte("abc")), trailer("{}")} {
		result.Envelope = append(result.Envelope, hex.EncodeToString(envelope(f)))
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
	fmt.Printf("wrote %s (%d scenarios)\n", *outPath, len(result.Scenarios))
}
