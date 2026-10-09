package main

import "github.com/router-for-me/CLIProxyAPI/v8/internal/thinking"

var summaryFormats = []string{"openai", "openai-response", "codex", "claude", "gemini", "antigravity", "interactions", "unknown", "OpenAI", " claude "}

// summaryBodies is shared by every format: whichever fields the format does not read must be ignored.
var summaryBodies = []string{
	`{}`,
	`{"reasoning_effort":"high"}`,
	`{"reasoning_effort":"none"}`,
	`{"reasoning_effort":""}`,
	`{"reasoning_effort":null}`,
	`{"reasoning_effort":17}`,
	`{"reasoning_effort":"high","extra_body":{"google":{"thinking_config":{"include_thoughts":false}}}}`,
	`{"extra_body":{"google":{"thinking_config":{"includeThoughts":true}}}}`,
	`{"extra_body":{"extra_body":{"google":{"thinkingConfig":{"include_thoughts":true}}}}}`,
	`{"google":{"thinking_config":{"include_thoughts":false}}}`,
	`{"thinking":{"includeThoughts":true}}`,
	`{"reasoning":{"include_thoughts":false}}`,
	`{"reasoning_effort":"high","reasoning":{"exclude":true}}`,
	`{"reasoning":{"effort":"high","exclude":false}}`,
	`{"reasoning_effort":"high","include_reasoning":false}`,
	`{"include_reasoning":true}`,
	`{"include_reasoning":"false"}`,
	`{"reasoning":{"enabled":false}}`,
	`{"reasoning":{"enabled":true}}`,
	`{"reasoning":{"exclude":true},"include_reasoning":true}`,
	`{"reasoning":{"effort":"high"}}`,
	`{"reasoning":{"effort":"high","summary":"auto"}}`,
	`{"reasoning":{"summary":"concise"}}`,
	`{"reasoning":{"summary":"Detailed"}}`,
	`{"reasoning":{"summary":"none"}}`,
	`{"reasoning":{"summary":null}}`,
	`{"reasoning":{"summary":true}}`,
	`{"reasoning":{"summary":"weird"}}`,
	`{"reasoning":{"generate_summary":"detailed"}}`,
	`{"reasoning":{"generate_summary":null,"summary":"auto"}}`,
	`{"thinking":{"type":"adaptive","display":"summarized"}}`,
	`{"thinking":{"type":"enabled","budget_tokens":2048,"display":"omitted"}}`,
	`{"thinking":{"display":"summarized"}}`,
	`{"thinking":{"type":"auto","display":"summarized"}}`,
	`{"thinking":{"type":"enabled","display":"summarized"}}`,
	`{"thinking":{"type":"enabled","budget_tokens":0,"display":"summarized"}}`,
	`{"thinking":{"type":"enabled","budget_tokens":-1,"display":"summarized"}}`,
	`{"thinking":{"type":"enabled","budget_tokens":-1,"display":"omitted"}}`,
	`{"thinking":{"type":"enabled","budget_tokens":"5","display":"omitted"}}`,
	`{"thinking":{"type":"disabled","display":"omitted"}}`,
	`{"generationConfig":{"thinkingConfig":{"includeThoughts":true}}}`,
	`{"generationConfig":{"thinkingConfig":{"include_thoughts":false}}}`,
	`{"generationConfig":{"thinkingConfig":{"includeThoughts":"true"}}}`,
	`{"generation_config":{"thinking_config":{"include_thoughts":false}}}`,
	`{"generation_config":{"thinking_config":{"includeThoughts":true}}}`,
	`{"request":{"generationConfig":{"thinkingConfig":{"includeThoughts":true}}}}`,
	`{"request":{"generationConfig":{"thinkingConfig":{"include_thoughts":false}}}}`,
	`{"request":{"generationConfig":{"thinking_config":{"includeThoughts":true}}}}`,
	`{"generation_config":{"thinking_summaries":"auto"}}`,
	`{"generation_config":{"thinkingSummaries":"none"}}`,
	`{"generation_config":{"thinking_summaries":"detailed"}}`,
	`{"generation_config":{"thinking_summaries":true}}`,
	`{"generation_config":{"thinking_summaries":"none"},"reasoning":{"summary":"auto"}}`,
	`{"generation_config":{"thinking_summaries":"none","thinking_config":{"include_thoughts":true}}}`,
	`{"generation_config":{"thinking_config":{"include_thoughts":"false"}}}`,
	`{"generation_config":{"thinkingConfig":{"include_thoughts":true}}}`,
	`{"generation_config":{"thinkingConfig":{"includeThoughts":false}}}`,
	`{"reasoning":{"summary":"auto"},"generation_config":{"thinking_config":{"include_thoughts":false}}}`,
	`{"thinking":{"type":"enabled"`,
}

func buildSummaryExtractCases() []summaryExtractCase {
	var cases []summaryExtractCase
	for _, format := range summaryFormats {
		for _, body := range summaryBodies {
			target := "claude"
			cases = append(cases, summaryExtractCase{
				Format: format, Target: target, Body: body,
				Summary:    toSummaryJSON(thinking.ExtractSummaryConfig([]byte(body), format)),
				Explicit:   toSummaryJSON(thinking.ExtractExplicitSummaryConfig([]byte(body), format)),
				Translated: toSummaryJSON(thinking.ExtractTranslatedSummaryConfig([]byte(body), format, target)),
			})
		}
	}
	return cases
}

func buildSummaryApplyCases() []summaryApplyCase {
	configs := []summaryJSON{
		{Mode: "disabled"}, {Mode: "enabled", Detail: "detailed"}, {Mode: "enabled", Detail: "weird"},
	}
	var cases []summaryApplyCase
	for _, format := range []string{"openai", "openai-response", "codex", "claude", "gemini", "antigravity", "interactions", "unknown"} {
		for _, body := range summaryBodies {
			for _, cfg := range configs {
				cases = append(cases, newSummaryApply(summaryApplyCase{Kind: "plain", Format: format, Body: body, Config: cfg},
					thinking.ApplySummaryConfig([]byte(body), format, fromSummaryJSON(cfg))))
			}
		}
	}
	// Model-aware activation of Claude thinking for an enabled summary (static catalog + resolved definitions).
	claudeBodies := []string{
		`{"max_tokens":32000}`, `{"max_tokens":1000}`, `{"max_tokens":1024}`, `{}`, `{"model":"claude-opus-5"}`, `{"model":"claude-haiku-4-5-20251001(high)","max_tokens":5000}`,
		`{"thinking":{"type":"disabled"}}`, `{"thinking":{"type":"adaptive"}}`, `{"thinking":{"type":"enabled","budget_tokens":2048}}`, `{"thinking":{"type":"enabled","budget_tokens":0}}`,
	}
	for _, model := range []string{"claude-opus-5", "claude-haiku-4-5-20251001", "claude-sonnet-4-6", "claude-3-5-haiku-20241022", "unknown-model", "claude-opus-5(high)", ""} {
		for _, body := range claudeBodies {
			for _, cfg := range configs[:2:2] {
				cases = append(cases, newSummaryApply(summaryApplyCase{Kind: "model", Format: "claude", Model: model, Body: body, Config: cfg},
					thinking.ApplySummaryConfigForModel([]byte(body), "claude", model, fromSummaryJSON(cfg))))
			}
		}
	}
	// Source → Claude translation helper.
	sources := []struct{ format, body string }{
		{"openai", `{"reasoning_effort":"high"}`}, {"openai", `{"reasoning_effort":"high","reasoning":{"exclude":true}}`},
		{"openai-response", `{"reasoning":{"summary":"auto"}}`}, {"openai-response", `{"reasoning":{"summary":null}}`}, {"openai-response", `{"reasoning":{"effort":"high"}}`},
		{"gemini", `{"generationConfig":{"thinkingConfig":{"includeThoughts":true}}}`}, {"interactions", `{"generation_config":{"thinking_summaries":"none"}}`},
		{"claude", `{"thinking":{"type":"adaptive","display":"summarized"}}`},
	}
	for _, src := range sources {
		for _, out := range []string{`{"model":"claude-opus-5","max_tokens":32000}`, `{"model":"claude-haiku-4-5-20251001","max_tokens":32000}`, `{"thinking":{"type":"adaptive"}}`, `{}`} {
			for _, model := range []string{"claude-opus-5", "claude-haiku-4-5-20251001", ""} {
				cases = append(cases, newSummaryApply(summaryApplyCase{Kind: "translated", Format: src.format, Model: model, Body: out, Source: src.body},
					thinking.ApplyTranslatedSummaryToClaude([]byte(out), []byte(src.body), src.format, model)))
			}
		}
	}
	return cases
}

func buildStripCases() []stripCase {
	bodies := []string{
		`{}`,
		`{"thinking":{"type":"enabled","budget_tokens":1024},"output_config":{"effort":"high"},"max_tokens":1}`,
		`{"output_config":{"effort":"high","other":1}}`,
		`{"output_config":{"effort":"high"},"model":"x"}`,
		`{"output_config":{}}`,
		`{"generationConfig":{"thinkingConfig":{"thinkingBudget":1},"temperature":1}}`,
		`{"request":{"generationConfig":{"thinkingConfig":{"thinkingLevel":"high"},"temperature":1}}}`,
		`{"generation_config":{"thinking_level":"high","thinkingLevel":"low","thinking_budget":1,"thinkingBudget":2,"thinking_summaries":"auto","thinkingSummaries":"none","thinking_config":{"a":1},"thinkingConfig":{"b":2},"temperature":1}}`,
		`{"reasoning_effort":"high","reasoning":{"effort":"low","summary":"auto"},"messages":[]}`,
		`{"thinking":{"type":"enabled","effort":"high"},"reasoning_effort":"low"}`,
		`{"reasoning":{"effort":"low","summary":"auto"},"input":"x"}`,
		`[1,2]`,
		`"str"`,
		``,
		`{"thinking":`,
	}
	var cases []stripCase
	for _, provider := range []string{"claude", "gemini", "antigravity", "interactions", "openai", "kimi", "kimi-ai", "kimi.ai", "kimi.com", "codex", "xai", "openai-response", "unknown", "Claude"} {
		for _, body := range bodies {
			c := stripCase{Provider: provider, Body: body}
			if out := string(thinking.StripThinkingConfig([]byte(body), provider)); out == body {
				c.Same = true
			} else {
				c.Out = out
			}
			cases = append(cases, c)
		}
	}
	return cases
}

func buildTextCases() []textCase {
	parts := []string{
		`{"text":"hello"}`, `{"thinking":"deep"}`, `{"text":"a","thinking":"b"}`, `{"thinking":{"text":"inner","cache_control":{"type":"ephemeral"}}}`,
		`{"thinking":{"thinking":"nested"}}`, `{"thinking":{"text":1}}`, `{"thinking":{"other":"x"}}`, `{"thinking":5}`, `{"text":5,"thinking":"fallback"}`,
		`{"thought":true,"text":"gemini"}`, `{}`, `{"thinking":null}`, `{"text":null}`, `"string"`, `[]`, `{"thinking":{"text":"t","thinking":"u"}}`,
	}
	cases := make([]textCase, 0, len(parts))
	for _, part := range parts {
		cases = append(cases, textCase{Part: part, Text: thinkingText(part)})
	}
	return cases
}

func buildUsageCases() []usageCase {
	bodies := []string{
		`{"model":"gpt-6-astra","reasoning":{"effort":"xhigh","summary":"auto"},"input":[{"type":"configuration_update","reasoning":{"effort":"low"}}]}`,
		`{"reasoning":{"effort":"xhigh"},"input":[{"type":"configuration_update","reasoning":{"effort":"low"}},{"role":"user","content":"second turn"},{"type":"configuration_update","reasoning":{"effort":"medium"}}]}`,
		`{"reasoning":{"effort":"xhigh","summary":"auto"},"input":[{"type":"configuration_update","tools":[]}]}`,
		`{"reasoning":{"effort":"xhigh"},"input":[{"type":"configuration_update","reasoning":{"effort":"none"}}]}`,
		`{"reasoning":{"effort":"xhigh"},"input":[{"type":"configuration_update","reasoning":{"effort":"auto"}}]}`,
		`{"reasoning":{"effort":"xhigh"},"input":[{"type":"configuration_update","reasoning":{"effort":"low"}},{"type":"configuration_update","tools":[]}]}`,
		`{"model":"gpt-6-astra","reasoning":{"effort":"xhigh"},"input":`,
		`{"reasoning":{"effort":"xhigh"},"input":[{"role":"user","content":"hello"}]}`,
		`{"reasoning":{"effort":"xhigh"},"input":[{"type":"configuration_update","reasoning":{"effort":"low"}}]}`,
		`{"reasoning_effort":"high"}`, `{"reasoning_effort":"none"}`, `{"reasoning_effort":"Medium"}`,
		`{"thinking":{"type":"enabled","budget_tokens":8192}}`, `{"thinking":{"type":"disabled"}}`, `{"thinking":{"type":"adaptive"},"output_config":{"effort":"max"}}`,
		`{"thinking":{"type":"enabled"}}`,
		`{"generationConfig":{"thinkingConfig":{"thinkingBudget":-1}}}`, `{"generationConfig":{"thinkingConfig":{"thinkingLevel":"HIGH"}}}`,
		`{"request":{"generationConfig":{"thinkingConfig":{"thinkingBudget":1024}}}}`,
		`{"generation_config":{"thinking_level":"low"}}`, `{"generation_config":{"thinking_budget":40000}}`,
		`{"thinking":{"type":"enabled","effort":"max"}}`, `{"thinking":{"type":"disabled"},"reasoning_effort":"high"}`,
		`{}`,
	}
	var cases []usageCase
	for _, provider := range []string{"codex", "openai-response", "openai", "xai", "claude", "gemini", "antigravity", "interactions", "kimi", "Codex", "unknown"} {
		for _, body := range bodies {
			for _, model := range []string{"gpt-6-astra", "gpt-6-astra(high)", "gpt-6-astra(8192)"} {
				cases = append(cases, usageCase{
					Provider: provider, Model: model, Body: body,
					Request:    thinking.ExtractReasoningEffort([]byte(body), provider, model),
					Translated: thinking.ExtractTranslatedReasoningEffort([]byte(body), provider),
				})
			}
		}
	}
	return cases
}

func newSummaryApply(c summaryApplyCase, out []byte) summaryApplyCase {
	if string(out) == c.Body {
		c.Same = true
	} else {
		c.Out = string(out)
	}
	return c
}
