package main

import (
	"fmt"

	"github.com/router-for-me/CLIProxyAPI/v8/internal/thinking"
)

func buildSuffixCases() []suffixCase {
	inputs := []string{
		"claude-sonnet-4-5", "claude-sonnet-4-5(16384)", "gpt-5.2(high)", "gpt-5.2(HIGH)", "gemini-2.5-pro(8192)",
		"model(none)", "model(NONE)", "model(auto)", "model(Auto)", "model(-1)", "model(0)", "model(08192)",
		"model(+5)", "model(-5)", "model(1.5)", "model(ultra)", "model()", "model(minimal)", "model(low)", "model(medium)",
		"model(xhigh)", "model(max)", "model(MAX)", "model(abc", "model)", "model(a)(b)", "model(a(b)", "(high)", "a(b)c",
		"model(9223372036854775807)", "model(9223372036854775808)", "model(99999999999999999999)", "model( high )",
		"provider/model(high)", "", "(", ")", "()",
	}
	cases := make([]suffixCase, 0, len(inputs))
	for _, input := range inputs {
		res := thinking.ParseSuffix(input)
		c := suffixCase{Input: input, ModelName: res.ModelName, HasSuffix: res.HasSuffix, RawSuffix: res.RawSuffix}
		c.Numeric, c.NumericOK = thinking.ParseNumericSuffix(res.RawSuffix)
		mode, ok := thinking.ParseSpecialSuffix(res.RawSuffix)
		c.SpecialOK = ok
		if ok {
			c.Special = mode.String()
		}
		level, ok := thinking.ParseLevelSuffix(res.RawSuffix)
		c.LevelOK = ok
		c.Level = string(level)
		c.Effort = thinking.ExtractReasoningEffort(nil, "openai", input)
		cases = append(cases, c)
	}
	return cases
}

func buildConvertCases() convertFixture {
	var fx convertFixture
	for _, level := range []string{"none", "auto", "minimal", "low", "medium", "high", "xhigh", "max", "HIGH", "Max", "ultra", ""} {
		budget, ok := thinking.ConvertLevelToBudget(level)
		fx.LevelToBudget = append(fx.LevelToBudget, struct {
			Level  string `json:"level"`
			OK     bool   `json:"ok"`
			Budget int    `json:"budget"`
		}{level, ok, budget})
	}
	for _, budget := range []int{-100, -2, -1, 0, 1, 511, 512, 513, 1023, 1024, 1025, 8191, 8192, 8193, 24575, 24576, 24577, 32768, 128000, 1000000} {
		level, ok := thinking.ConvertBudgetToLevel(budget)
		fx.BudgetToLevel = append(fx.BudgetToLevel, struct {
			Budget int    `json:"budget"`
			OK     bool   `json:"ok"`
			Level  string `json:"level"`
		}{budget, ok, level})
	}
	for _, level := range []string{"", " ", "minimal", "low", "Medium", " high ", "xhigh", "max", "MAX", "auto", "none", "ultra"} {
		for _, supportsMax := range []bool{false, true} {
			effort, ok := thinking.MapToClaudeEffort(level, supportsMax)
			fx.ClaudeEffort = append(fx.ClaudeEffort, struct {
				Level       string `json:"level"`
				SupportsMax bool   `json:"supportsMax"`
				OK          bool   `json:"ok"`
				Effort      string `json:"effort"`
			}{level, supportsMax, ok, effort})
		}
	}
	for _, c := range []struct {
		levels []string
		target string
	}{
		{nil, "low"}, {[]string{"low", "high"}, "low"}, {[]string{"low", "high"}, "LOW"}, {[]string{" Low ", "high"}, "low"},
		{[]string{"low", "high"}, "medium"}, {[]string{"none", "low"}, "none"},
	} {
		fx.HasLevel = append(fx.HasLevel, struct {
			Levels []string `json:"levels"`
			Target string   `json:"target"`
			Result bool     `json:"result"`
		}{c.levels, c.target, thinking.HasLevel(c.levels, c.target)})
	}
	return fx
}

// syntheticModels cover every capability class and validation flag combination.
func syntheticModels() []*modelSpec {
	return []*modelSpec{
		{ID: "nothink"},
		{ID: "emptythink", Thinking: &thinkSpec{}},
		{ID: "budget", Thinking: &thinkSpec{Min: 1024, Max: 32000}},
		{ID: "budget-zero", Thinking: &thinkSpec{Max: 24576, ZeroAllowed: true, DynamicAllowed: true}},
		{ID: "budget-min", Thinking: &thinkSpec{Min: 128, Max: 32768, DynamicAllowed: true}},
		{ID: "level", Thinking: &thinkSpec{Levels: []string{"low", "medium", "high"}}},
		{ID: "level-xhigh", Thinking: &thinkSpec{Levels: []string{"low", "medium", "high", "xhigh", "max"}, ZeroAllowed: true}},
		{ID: "level-none", Thinking: &thinkSpec{Levels: []string{"none", "low", "high"}}},
		{ID: "level-subset", Thinking: &thinkSpec{Levels: []string{"low", "high"}, DynamicAllowed: false}},
		{ID: "level-spaced", Thinking: &thinkSpec{Levels: []string{" Low ", "HIGH"}, DynamicAllowed: true}},
		{ID: "hybrid", Thinking: &thinkSpec{Min: 128, Max: 32768, Levels: []string{"minimal", "low", "medium", "high"}, DynamicAllowed: true}},
		{ID: "hybrid-nodyn", Thinking: &thinkSpec{Min: 1024, Max: 64000, Levels: []string{"low", "medium", "high", "max"}, ZeroAllowed: true}},
		{ID: "adaptive-only", Thinking: &thinkSpec{ZeroAllowed: true, DynamicAllowed: true, Levels: []string{"low", "medium", "high", "xhigh", "max"}}},
		{ID: "claude-manual", Type: "claude", MaxCompletionTokens: 64000, Thinking: &thinkSpec{Min: 1024, Max: 128000, ZeroAllowed: true}},
		{ID: "claude-adaptive", Type: "claude", MaxCompletionTokens: 128000, Thinking: &thinkSpec{Min: 1024, Max: 128000, ZeroAllowed: true, Levels: []string{"low", "medium", "high", "max"}}},
		{ID: "gemini-budget", Type: "gemini", Thinking: &thinkSpec{Max: 24576, ZeroAllowed: true, DynamicAllowed: true}},
		{ID: "gemini-level", Type: "gemini", Thinking: &thinkSpec{Min: 128, Max: 32768, DynamicAllowed: true, Levels: []string{"low", "high"}}},
		{ID: "kimi-level", Type: "kimi", Thinking: &thinkSpec{ZeroAllowed: true, Levels: []string{"low", "high"}}},
		{ID: "kimi-nozero", Type: "kimi", Thinking: &thinkSpec{Levels: []string{"low", "high", "max"}}},
		{ID: "openai-level", Type: "openai", Thinking: &thinkSpec{Levels: []string{"low", "medium", "high"}}},
		{ID: "codex-level", Type: "codex", Thinking: &thinkSpec{Levels: []string{"low", "medium", "high", "xhigh"}}},
		{ID: "compat-level", Type: "openai-compatibility", Thinking: &thinkSpec{Levels: []string{"high", "max"}}},
		{ID: "antigravity-claude", Type: "antigravity", MaxCompletionTokens: 64000, Thinking: &thinkSpec{Min: 1024, Max: 64000, ZeroAllowed: true, DynamicAllowed: true}},
		{ID: "user-defined", UserDefined: true},
		{ID: "user-defined-thinking", UserDefined: true, Type: "claude", Thinking: &thinkSpec{Levels: []string{"low"}}},
	}
}

func syntheticConfigs() []configJSON {
	configs := []configJSON{
		{Mode: "none"},
		{Mode: "auto", Budget: -1},
		{Mode: "level", Level: ""},
	}
	for _, budget := range []int{-5, 0, 100, 512, 1024, 8192, 24576, 64000, 200000} {
		configs = append(configs, configJSON{Mode: "budget", Budget: budget})
	}
	for _, level := range []string{"none", "auto", "minimal", "low", "medium", "high", "xhigh", "max", "ultra", "HIGH", "Low"} {
		configs = append(configs, configJSON{Mode: "level", Level: level})
	}
	return configs
}

func buildValidateCases() []validateGroup {
	type combo struct {
		from, to   string
		fromSuffix bool
	}
	combos := []combo{
		{"claude", "claude", false}, {"claude", "claude", true}, {"claude", "gemini", false}, {"gemini", "antigravity", true},
		{"openai", "codex", false}, {"openai-response", "codex", true}, {"openai", "claude", false}, {"kimi", "kimi", false},
		{"", "claude", false},
	}
	configs := syntheticConfigs()
	run := func(model *modelSpec, combos []combo) validateGroup {
		group := validateGroup{Model: model}
		for _, config := range configs {
			for _, cb := range combos {
				out, err := thinking.ValidateConfig(fromConfigJSON(config), model.info(), cb.from, cb.to, cb.fromSuffix)
				c := validateCase{Config: encodeConfig(fromConfigJSON(config)), From: cb.from, To: cb.to, FromSuffix: cb.fromSuffix}
				if err != nil {
					e := toErrJSON(err)
					c.Error = e.Code + ": " + e.Message
				} else {
					c.Out = encodeConfig(*out)
				}
				group.Cases = append(group.Cases, c)
			}
		}
		return group
	}
	var groups []validateGroup
	for _, model := range syntheticModels() {
		groups = append(groups, run(model, combos))
	}
	groups = append(groups, run(nil, combos[:1]))
	for _, id := range []string{"claude-opus-4-7", "claude-sonnet-4-5-20250929", "gemini-3-flash-preview", "gemini-2.5-flash", "kimi-k2.8", "gpt-6-astra", "grok-4.3"} {
		groups = append(groups, run(specFromInfoByID(id), combos[:8]))
	}
	return groups
}

func specFromInfoByID(id string) *modelSpec {
	info := lookupStatic(id)
	if info == nil {
		panic(fmt.Sprintf("model %q missing from the static catalog", id))
	}
	return info
}
