package main

import (
	"strings"

	"github.com/router-for-me/CLIProxyAPI/v8/internal/thinking"
)

func buildApplierCases() []applierCase {
	configs := []thinking.ThinkingConfig{
		{Mode: thinking.ModeNone},
		{Mode: thinking.ModeNone, Level: "low"},
		{Mode: thinking.ModeNone, Level: "none"},
		{Mode: thinking.ModeNone, Budget: 128, Level: "minimal"},
		{Mode: thinking.ModeAuto, Budget: -1},
		{Mode: thinking.ModeBudget, Budget: 0},
		{Mode: thinking.ModeBudget, Budget: 1024},
		{Mode: thinking.ModeBudget, Budget: 8192},
		{Mode: thinking.ModeBudget, Budget: 40000},
		{Mode: thinking.ModeLevel, Level: "high"},
		{Mode: thinking.ModeLevel, Level: "xhigh"},
		{Mode: thinking.ModeLevel, Level: "max"},
		{Mode: thinking.ModeLevel, Level: "low"},
		{Mode: thinking.ModeLevel},
	}
	type applierSpec struct {
		name   string
		models []string
		bodies []string
	}
	catalogOr := func(ids ...string) []string { return ids }
	specs := []applierSpec{
		{"claude", catalogOr("", "user-defined", "nothink", "claude-manual", "claude-adaptive", "adaptive-only", "catalog:claude-opus-4-6"), []string{
			`{}`, `{"max_tokens":4096,"thinking":{"type":"enabled","budget_tokens":2000,"display":"summarized"},"output_config":{"effort":"high","other":1}}`, `{"max_tokens":1000}`, `{"a":`}},
		{"openai", catalogOr("", "user-defined", "nothink", "level", "level-none", "level-xhigh", "budget-zero"), []string{
			`{}`, `{"reasoning_effort":"low","messages":[]}`, `{"a":`}},
		{"codex", catalogOr("", "user-defined", "nothink", "level", "level-none", "level-xhigh", "budget-zero"), []string{
			`{}`, `{"reasoning":{"effort":"low","summary":"auto"},"input":[]}`, `{"a":`}},
		{"xai", catalogOr("", "level", "level-none", "catalog:grok-4.3", "catalog:grok-build-0.1"), []string{`{}`, `{"reasoning":{"effort":"low"}}`}},
		{"gemini", catalogOr("", "user-defined", "nothink", "budget-zero", "gemini-level", "hybrid", "catalog:gemini-2.5-flash"), []string{
			`{}`, `{"generationConfig":{"thinkingConfig":{"thinkingLevel":"low","thinking_budget":5,"includeThoughts":true}}}`,
			`{"generationConfig":{"thinkingConfig":{"thinkingBudget":9,"include_thoughts":false}}}`, `{"a":`}},
		{"antigravity", catalogOr("", "user-defined", "nothink", "hybrid", "antigravity-claude", "claude-manual", "catalog:claude-opus-4-6-thinking", "catalog:gemini-3-flash"), []string{
			`{}`, `{"request":{"generationConfig":{"maxOutputTokens":500,"thinkingConfig":{"thinkingLevel":"low","thinking_budget":5,"includeThoughts":true}}}}`,
			`{"request":{"generationConfig":{"maxOutputTokens":2000,"thinkingConfig":{"thinkingBudget":9,"include_thoughts":false}}}}`}},
		{"kimi", catalogOr("", "user-defined", "nothink", "kimi-level", "kimi-nozero", "catalog:kimi-k2.8"), []string{
			`{}`, `{"reasoning_effort":"high","thinking":{"type":"enabled","keep":"all","effort":"low"}}`, `{"a":`}},
		{"interactions", catalogOr("", "user-defined", "nothink", "level", "level-subset", "hybrid", "catalog:gemini-3-flash-preview"), []string{
			`{}`, `{"generation_config":{"thinking_level":"low","thinking_summaries":"none","thinking_config":{"include_thoughts":true}},"generationConfig":{"thinkingBudget":1}}`,
			`{"generation_config":{"thinkingConfig":{"includeThoughts":false}}}`}},
	}
	var cases []applierCase
	for _, spec := range specs {
		applier := thinking.GetProviderApplier(spec.name)
		if applier == nil {
			panic("no applier " + spec.name)
		}
		for _, modelKey := range spec.models {
			var model *modelSpec
			switch {
			case modelKey == "":
			case strings.HasPrefix(modelKey, "catalog:"):
				model = specFromInfoByID(strings.TrimPrefix(modelKey, "catalog:"))
			default:
				model = syntheticTable[modelKey]
				if model == nil {
					panic("no synthetic model " + modelKey)
				}
			}
			for _, config := range configs {
				for _, body := range spec.bodies {
					out, err := applier.Apply([]byte(body), config, model.info())
					c := applierCase{Applier: spec.name, Model: modelKey, Config: encodeFull(config), Body: body}
					if string(out) == body {
						c.Same = true
					} else {
						c.Out = string(out)
					}
					if err != nil {
						c.Error = err.Error()
					}
					cases = append(cases, c)
				}
			}
		}
	}
	return cases
}

// encodeFull is the lossless "mode|budget|level" form (appliers receive unvalidated configs).
func encodeFull(c thinking.ThinkingConfig) string {
	return c.Mode.String() + "|" + itoa(c.Budget) + "|" + string(c.Level)
}
