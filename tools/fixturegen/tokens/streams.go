package main

import (
	"context"

	"github.com/router-for-me/CLIProxyAPI/v8/internal/runtime/executor/helps"
	sdktranslator "github.com/router-for-me/CLIProxyAPI/v8/sdk/translator"
)

// passthroughFormat is an upstream format whose "translation" returns the input chunk unchanged, so scenarios can
// feed arbitrary Claude SSE chunks to the input token patcher.
const passthroughFormat = sdktranslator.Format("tokens-fixture-passthrough")

func streamScenarios() []streamCase {
	sdktranslator.Register(sdktranslator.FormatClaude, passthroughFormat, nil, sdktranslator.ResponseTransform{
		Stream: func(_ context.Context, _ string, _, _, rawJSON []byte, _ *any) [][]byte {
			return [][]byte{rawJSON}
		},
	})

	const claudeRequest = `{"model":"claude-sonnet-4","max_tokens":64,"stream":true,"system":"System text.","messages":[{"role":"user","content":"Hello, how are you today?"}],"tools":[{"name":"dig","description":"Dig a hole","input_schema":{"type":"object","properties":{"x":{"type":"number"}}}}]}`
	start := func(usage string) string {
		return "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"m\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[],\"model\":\"x\",\"usage\":" + usage + "}}\n\n"
	}
	delta := "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n"

	passthrough := []struct {
		name, original string
		chunks         []string
	}{
		{"zero input tokens", claudeRequest, []string{start(`{"input_tokens":0,"output_tokens":0}`), delta}},
		{"missing usage tokens", claudeRequest, []string{start(`{"output_tokens":0}`)}},
		{"missing usage object", claudeRequest, []string{"data: {\"type\":\"message_start\",\"message\":{\"id\":\"m\"}}\n\n"}},
		{"non-zero preserved", claudeRequest, []string{start(`{"input_tokens":73,"output_tokens":0}`)}},
		{"non-zero preserved with invalid request", `not valid json`, []string{start(`{"input_tokens":73}`)}},
		{"invalid request keeps zero", `not valid json`, []string{start(`{"input_tokens":0}`)}},
		{"empty request keeps zero", ``, []string{start(`{"input_tokens":0}`)}},
		{"empty counted request keeps zero", `{"messages":[]}`, []string{start(`{"input_tokens":0}`)}},
		{"combined chunk patched once", claudeRequest, []string{start(`{"input_tokens":0}`) + delta + start(`{"input_tokens":0}`)}},
		{"second message_start untouched", claudeRequest, []string{start(`{"input_tokens":0}`), start(`{"input_tokens":0}`)}},
		{"events before message_start", claudeRequest, []string{"event: ping\ndata: {\"type\":\"ping\"}\n\n", start(`{"input_tokens":0}`)}},
		{"crlf and padded data line", claudeRequest, []string{"event: message_start\r\ndata:  {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":0,\"output_tokens\":0}}}  \r\n\r\nevent: ping\r\ndata: {\"type\":\"ping\",\"value\":\"keep\"}\r\n\r\n"}},
		{"data without space and tab indent", claudeRequest, []string{"event: message_start\n\tdata:{\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":0}}}\n\n"}},
		{"non-json data lines", claudeRequest, []string{"data: not json\n\ndata: [DONE]\n\n", start(`{"input_tokens":0}`)}},
		{"no trailing newline", claudeRequest, []string{"data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":0}}}"}},
		{"other event type", claudeRequest, []string{"data: {\"type\":\"message_delta\",\"usage\":{\"input_tokens\":0}}\n\n"}},
	}

	var cases []streamCase
	for _, p := range passthrough {
		cases = append(cases, runStream(p.name, passthroughFormat, p.original, "", p.chunks))
	}

	const openAIRequest = `{"model":"gpt-4o","stream":true,"messages":[{"role":"system","content":"System text."},{"role":"user","content":"Hello, how are you today?"}]}`
	const codexRequest = `{"model":"gpt-5","stream":true,"instructions":"System text.","input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"Hello, how are you today?"}]}]}`
	const geminiRequest = `{"model":"gemini-2.5-pro","contents":[{"role":"user","parts":[{"text":"Hello, how are you today?"}]}]}`

	openaiLines := []string{
		`data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"gpt-4o","choices":[{"index":0,"delta":{"role":"assistant","content":"Hi"},"finish_reason":null}]}`,
		`data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"gpt-4o","choices":[{"index":0,"delta":{"content":" there"},"finish_reason":null}]}`,
		`data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"gpt-4o","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":11,"completion_tokens":3,"total_tokens":14}}`,
		`data: [DONE]`,
	}
	cases = append(cases, runStream("openai upstream", sdktranslator.FormatOpenAI, claudeRequest, openAIRequest, openaiLines))
	cases = append(cases, runStream("openai upstream without usage", sdktranslator.FormatOpenAI, claudeRequest, openAIRequest, append(append([]string{}, openaiLines[:2]...), `data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"gpt-4o","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}`, `data: [DONE]`)))

	codexLines := []string{
		`data: {"type":"response.created","response":{"id":"resp_1","model":"gpt-5","status":"in_progress"}}`,
		`data: {"type":"response.output_text.delta","item_id":"msg_1","output_index":0,"content_index":0,"delta":"Hi"}`,
		`data: {"type":"response.completed","response":{"id":"resp_1","model":"gpt-5","status":"completed","usage":{"input_tokens":9,"output_tokens":2,"total_tokens":11}}}`,
	}
	cases = append(cases, runStream("codex upstream", sdktranslator.FormatCodex, claudeRequest, codexRequest, codexLines))

	geminiLines := []string{
		`{"candidates":[{"content":{"role":"model","parts":[{"text":"Hi"}]}}],"modelVersion":"gemini-2.5-pro","responseId":"g1"}`,
		`{"candidates":[{"content":{"role":"model","parts":[{"text":" there"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":12,"candidatesTokenCount":3,"totalTokenCount":15},"modelVersion":"gemini-2.5-pro","responseId":"g1"}`,
		`[DONE]`,
	}
	cases = append(cases, runStream("gemini upstream", sdktranslator.FormatGemini, claudeRequest, geminiRequest, geminiLines))
	cases = append(cases, runStream("gemini upstream with usage in first chunk", sdktranslator.FormatGemini, claudeRequest, geminiRequest, []string{
		`{"candidates":[{"content":{"role":"model","parts":[{"text":"Hi"}]}}],"usageMetadata":{"promptTokenCount":12,"totalTokenCount":12},"modelVersion":"gemini-2.5-pro","responseId":"g1"}`,
		`[DONE]`,
	}))
	return cases
}

func runStream(name string, upstream sdktranslator.Format, original, translated string, lines []string) streamCase {
	c := streamCase{Name: name, Upstream: string(upstream), Original: original, Translated: translated, Model: "claude-sonnet-4"}
	state := helps.NewClaudeInputTokenState(sdktranslator.FormatClaude, upstream, sdktranslator.FormatClaude, []byte(original))
	var param any
	var translatedRaw []byte
	if translated != "" {
		translatedRaw = []byte(translated)
	}
	for _, line := range lines {
		chunks := helps.TranslateStreamWithClaudeInputTokens(context.Background(), upstream, sdktranslator.FormatClaude, c.Model,
			[]byte(original), translatedRaw, []byte(line), &param, state)
		step := streamStep{In: line, Out: []string{}}
		for _, chunk := range chunks {
			step.Out = append(step.Out, string(chunk))
		}
		c.Steps = append(c.Steps, step)
	}
	return c
}
