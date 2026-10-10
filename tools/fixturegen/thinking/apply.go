package main

import (
	"encoding/json"
	"fmt"

	"github.com/router-for-me/CLIProxyAPI/v8/internal/thinking"
)

// runApply executes one case with the Go entry point matching its variant and records the result.
func runApply(c applyCase, info *modelSpec, infoResolved bool) applyCase {
	body := []byte(c.Body)
	var source []byte
	if c.Source != nil {
		source = []byte(*c.Source)
	}
	var summary thinking.SummaryConfig
	if c.Summary != nil {
		summary = fromSummaryJSON(*c.Summary)
	}
	var out []byte
	var err error
	switch c.Variant {
	case "plain":
		out, err = thinking.ApplyThinking(body, c.Model, c.From, c.To, c.ProviderKey)
	case "summary":
		out, err = thinking.ApplyThinkingWithSummary(body, c.Model, c.From, c.To, c.ProviderKey, summary)
	case "source":
		out, err = thinking.ApplyThinkingWithSourceAndSummary(body, source, c.Model, c.From, c.To, c.ProviderKey, summary, c.Normalized)
	case "modelInfo":
		out, err = thinking.ApplyThinkingWithModelInfo(body, source, c.Model, c.From, c.To, c.ProviderKey, info.info())
	case "modelInfoSummary":
		out, err = thinking.ApplyThinkingWithModelInfoAndSummary(body, source, c.Model, c.From, c.To, c.ProviderKey, info.info(), summary, c.Normalized)
	default:
		panic("unknown variant " + c.Variant)
	}
	if infoResolved {
		if info != nil && synthRef(info) {
			c.ModelRef = info.ID
		} else if info == nil {
			c.ModelInfo = json.RawMessage("null")
		} else {
			raw, errMarshal := json.Marshal(info)
			if errMarshal != nil {
				panic(errMarshal)
			}
			c.ModelInfo = raw
		}
	}
	if string(out) == c.Body {
		c.Same = true
	} else {
		c.Out = string(out)
	}
	c.Error = toErrJSON(err)
	return c
}

var suffixes = []string{
	"", "(none)", "(auto)", "(0)", "(1024)", "(24576)", "(minimal)", "(low)", "(high)", "(xhigh)", "(max)", "(bogus)",
}

type applyTarget struct {
	to          string
	providerKey string
	froms       []string
	models      []string // static catalog ids (registry lookup path); the last may be unknown
	synthetic   []string // synthetic model ids (resolved model info path)
	bodies      []string
}

var syntheticTable = func() map[string]*modelSpec {
	out := map[string]*modelSpec{}
	for _, m := range syntheticModels() {
		out[m.ID] = m
	}
	return out
}()

func syntheticByID() map[string]*modelSpec { return syntheticTable }

func buildApplyCases() []applyCase {
	synth := syntheticByID()
	var cases []applyCase
	for _, t := range applyTargets() {
		primary := t.froms[0]
		for _, model := range t.models {
			// Every body without suffix.
			for _, body := range t.bodies {
				cases = append(cases, runApply(applyCase{
					Variant: "plain",
					Body:    body, Model: model, From: primary, To: t.to, ProviderKey: t.providerKey,
				}, nil, false))
			}
			// Every suffix over an empty body and over a body that already carries configuration.
			for _, suffix := range suffixes[1:] {
				cases = append(cases, runApply(applyCase{
					Variant: "plain",
					Body:    `{}`, Model: model + suffix, From: primary, To: t.to, ProviderKey: t.providerKey,
				}, nil, false))
			}
			for _, suffix := range []string{"(none)", "(8192)", "(high)"} {
				cases = append(cases, runApply(applyCase{
					Variant: "plain",
					Body:    t.bodies[len(t.bodies)/2], Model: model + suffix, From: primary, To: t.to, ProviderKey: t.providerKey,
				}, nil, false))
			}
			// Other source formats change the strictness of validation.
			for _, from := range t.froms[1:] {
				for i := 0; i < len(t.bodies); i += 4 {
					cases = append(cases, runApply(applyCase{
						Variant: "plain",
						Body:    t.bodies[i], Model: model, From: from, To: t.to, ProviderKey: t.providerKey,
					}, nil, false))
				}
				for _, suffix := range []string{"(none)", "(1024)", "(high)", "(max)"} {
					cases = append(cases, runApply(applyCase{
						Variant: "plain",
						Body:    `{}`, Model: model + suffix, From: from, To: t.to, ProviderKey: t.providerKey,
					}, nil, false))
				}
			}
		}
		// Synthetic (resolved) model definitions: user-defined, no-thinking and every capability class.
		for _, id := range t.synthetic {
			info := synth[id]
			for _, suffix := range suffixes {
				cases = append(cases, runApply(applyCase{
					Variant: "modelInfo",
					Body:    `{}`, Model: id + suffix, From: primary, To: t.to, ProviderKey: t.providerKey,
				}, info, true))
			}
			for i := 0; i < len(t.bodies); i += 4 {
				cases = append(cases, runApply(applyCase{
					Variant: "modelInfo",
					Body:    t.bodies[i], Model: id, From: primary, To: t.to, ProviderKey: t.providerKey,
				}, info, true))
			}
		}
	}
	cases = append(cases, handwrittenApplyCases()...)
	cases = append(cases, providerSummaryCases()...)
	return cases
}

func applyTargets() []applyTarget {
	return []applyTarget{
		{
			to: "claude", providerKey: "claude", froms: []string{"claude", "openai", "gemini", "openai-response"},
			models:    []string{"claude-sonnet-4-5-20250929", "claude-opus-4-6", "claude-opus-5", "claude-opus-4-1-20250805", "claude-3-5-haiku-20241022", "kimi-k2.8", "unknown-claude-model"},
			synthetic: []string{"nothink", "emptythink", "budget", "claude-manual", "claude-adaptive", "adaptive-only", "level", "user-defined", "user-defined-thinking", "compat-level"},
			bodies: []string{
				`{}`,
				`{"model":"m","max_tokens":4096}`,
				`{"thinking":{"type":"disabled"}}`,
				`{"thinking":{"type":"disabled","budget_tokens":2048},"output_config":{"effort":"high"}}`,
				`{"thinking":{"type":"enabled","budget_tokens":8192},"max_tokens":16000}`,
				`{"thinking":{"type":"enabled","budget_tokens":8192},"max_tokens":4096}`,
				`{"thinking":{"type":"enabled","budget_tokens":8192},"max_tokens":1500}`,
				`{"thinking":{"type":"enabled","budget_tokens":8192},"max_tokens":1000}`,
				`{"thinking":{"type":"enabled","budget_tokens":500}}`,
				`{"thinking":{"type":"enabled","budget_tokens":200000}}`,
				`{"thinking":{"type":"enabled","budget_tokens":-1}}`,
				`{"thinking":{"type":"enabled","budget_tokens":0,"display":"summarized"}}`,
				`{"thinking":{"type":"enabled"}}`,
				`{"thinking":{"type":"enabled"},"output_config":{"effort":"high"}}`,
				`{"thinking":{"type":"enabled"},"output_config":{"effort":"none"}}`,
				`{"thinking":{"type":"adaptive"},"output_config":{"effort":"low"}}`,
				`{"thinking":{"type":"adaptive","display":"summarized"},"output_config":{"effort":"max"}}`,
				`{"thinking":{"type":"adaptive"},"output_config":{"effort":"xhigh","other":1}}`,
				`{"thinking":{"type":"adaptive"},"output_config":{"effort":"auto"}}`,
				`{"thinking":{"type":"adaptive"},"output_config":{"effort":"ultra"}}`,
				`{"thinking":{"type":"adaptive"}}`,
				`{"thinking":{"type":"auto"},"output_config":{"effort":"medium"},"max_tokens":0}`,
				`{"thinking":{"type":"enabled","budget_tokens":2048,"display":"omitted"},"output_config":{"effort":"low"},"max_tokens":8000}`,
				`{"thinking":{"type":"enabled","budget_tokens":"4096"}}`,
				`{"thinking":{"type":"enabled","budget_tokens":null}}`,
				`{"output_config":{"effort":"high"}}`,
				`{"thinking":"on"}`,
				`{"thinking":{"type":"disabled"`,
			},
		},
		{
			to: "gemini", providerKey: "gemini", froms: []string{"gemini", "openai", "claude"},
			models:    []string{"gemini-2.5-pro", "gemini-2.5-flash", "gemini-3-flash-preview", "gemini-3-pro-preview", "gemini-2.5-flash-image", "unknown-gemini-model"},
			synthetic: []string{"nothink", "budget", "budget-zero", "level", "hybrid", "hybrid-nodyn", "gemini-budget", "gemini-level", "user-defined"},
			bodies: []string{
				`{}`,
				`{"generationConfig":{"temperature":1}}`,
				`{"generationConfig":{"thinkingConfig":{"thinkingBudget":0}}}`,
				`{"generationConfig":{"thinkingConfig":{"thinkingBudget":-1}}}`,
				`{"generationConfig":{"thinkingConfig":{"thinkingBudget":50}}}`,
				`{"generationConfig":{"thinkingConfig":{"thinkingBudget":128}}}`,
				`{"generationConfig":{"thinkingConfig":{"thinkingBudget":8192}}}`,
				`{"generationConfig":{"thinkingConfig":{"thinkingBudget":40000}}}`,
				`{"generationConfig":{"thinkingConfig":{"thinking_budget":1024}}}`,
				`{"generationConfig":{"thinkingConfig":{"thinkingLevel":"high"}}}`,
				`{"generationConfig":{"thinkingConfig":{"thinkingLevel":"low"}}}`,
				`{"generationConfig":{"thinkingConfig":{"thinkingLevel":"none"}}}`,
				`{"generationConfig":{"thinkingConfig":{"thinkingLevel":"auto"}}}`,
				`{"generationConfig":{"thinkingConfig":{"thinkingLevel":"ultra"}}}`,
				`{"generationConfig":{"thinkingConfig":{"thinkingLevel":"HIGH"}}}`,
				`{"generationConfig":{"thinkingConfig":{"thinkingLevel":"minimal"}}}`,
				`{"generationConfig":{"thinkingConfig":{"thinking_level":"medium"}}}`,
				`{"generationConfig":{"thinkingConfig":{"thinkingLevel":"high","thinkingBudget":1024}}}`,
				`{"generationConfig":{"thinkingConfig":{"thinkingBudget":8192,"includeThoughts":true}}}`,
				`{"generationConfig":{"thinkingConfig":{"thinkingLevel":"low","include_thoughts":false}}}`,
				`{"generationConfig":{"thinkingConfig":{"thinkingBudget":0,"includeThoughts":true}}}`,
				`{"generationConfig":{"thinkingConfig":{"thinkingBudget":2048,"includeThoughts":"true"}}}`,
				`{"generationConfig":{"thinkingConfig":{}}}`,
				`{"contents":[],"generationConfig":{"thinkingConfig":{"thinkingBudget":4096,"extra":1}}}`,
				`{"generationConfig":"x"}`,
			},
		},
		{
			to: "antigravity", providerKey: "antigravity", froms: []string{"antigravity", "gemini"},
			models:    []string{"claude-opus-4-6-thinking", "gemini-3-flash", "gemini-3.1-pro-low", "gemini-3.1-flash-lite", "gpt-oss-120b-medium", "unknown-antigravity-model"},
			synthetic: []string{"nothink", "budget", "budget-zero", "level", "hybrid", "antigravity-claude", "claude-manual", "user-defined", "user-defined-thinking"},
			bodies: []string{
				`{}`,
				`{"request":{"generationConfig":{"temperature":1}}}`,
				`{"request":{"generationConfig":{"thinkingConfig":{"thinkingBudget":0}}}}`,
				`{"request":{"generationConfig":{"thinkingConfig":{"thinkingBudget":-1}}}}`,
				`{"request":{"generationConfig":{"thinkingConfig":{"thinkingBudget":512}}}}`,
				`{"request":{"generationConfig":{"thinkingConfig":{"thinkingBudget":8192}}}}`,
				`{"request":{"generationConfig":{"thinkingConfig":{"thinkingBudget":100000}}}}`,
				`{"request":{"generationConfig":{"maxOutputTokens":2000,"thinkingConfig":{"thinkingBudget":8192}}}}`,
				`{"request":{"generationConfig":{"maxOutputTokens":500,"thinkingConfig":{"thinkingBudget":8192}}}}`,
				`{"request":{"generationConfig":{"maxOutputTokens":1500,"thinkingConfig":{"thinkingBudget":8192,"includeThoughts":true}}}}`,
				`{"request":{"generationConfig":{"thinkingConfig":{"thinkingLevel":"high"}}}}`,
				`{"request":{"generationConfig":{"thinkingConfig":{"thinkingLevel":"low","includeThoughts":false}}}}`,
				`{"request":{"generationConfig":{"thinkingConfig":{"thinkingLevel":"none"}}}}`,
				`{"request":{"generationConfig":{"thinkingConfig":{"thinking_level":"auto"}}}}`,
				`{"request":{"generationConfig":{"thinkingConfig":{"thinkingLevel":"ultra"}}}}`,
				`{"request":{"generationConfig":{"thinkingConfig":{"thinking_budget":2048,"include_thoughts":true}}}}`,
				`{"generationConfig":{"thinkingConfig":{"thinkingBudget":1024}}}`,
			},
		},
		{
			to: "interactions", providerKey: "gemini-interactions", froms: []string{"interactions", "gemini"},
			models:    []string{"gemini-3-flash-preview", "gemini-3.1-pro-preview", "gemini-2.5-pro", "gemini-2.5-flash-image", "unknown-interactions-model"},
			synthetic: []string{"nothink", "level", "level-subset", "hybrid", "budget", "user-defined"},
			bodies: []string{
				`{}`,
				`{"generation_config":{"temperature":1}}`,
				`{"generation_config":{"thinking_level":"high"}}`,
				`{"generation_config":{"thinking_level":"low","thinking_summaries":"auto"}}`,
				`{"generation_config":{"thinkingLevel":"MEDIUM"}}`,
				`{"generation_config":{"thinking_level":"none"}}`,
				`{"generation_config":{"thinking_level":"auto"}}`,
				`{"generation_config":{"thinking_level":"max"}}`,
				`{"generation_config":{"thinking_level":"xhigh","thinkingSummaries":"none"}}`,
				`{"generation_config":{"thinking_level":"ultra"}}`,
				`{"generation_config":{"thinking_budget":0}}`,
				`{"generation_config":{"thinking_budget":-1}}`,
				`{"generation_config":{"thinkingBudget":1024,"thinking_summaries":"none"}}`,
				`{"generation_config":{"thinking_budget":8192}}`,
				`{"generation_config":{"thinking_budget":40000}}`,
				`{"generation_config":{"thinking_config":{"thinking_level":"low","include_thoughts":true}}}`,
				`{"generation_config":{"thinkingConfig":{"thinkingBudget":2048,"includeThoughts":false}}}`,
				`{"generation_config":{"thinking_config":{"thinking_budget":4096}}}`,
				`{"generationConfig":{"thinkingLevel":"high","thinkingBudget":100},"generation_config":{"thinking_summaries":"auto"}}`,
				`{"generation_config":{"thinking_summaries":"detailed","thinking_level":"high"}}`,
			},
		},
		{
			to: "openai", providerKey: "openai", froms: []string{"openai", "claude"},
			models:    []string{"gpt-5.5", "grok-3-mini", "kimi-k2.5", "gemini-2.5-pro", "gpt-oss-120b-medium", "unknown-openai-model"},
			synthetic: []string{"nothink", "level", "level-xhigh", "level-none", "level-subset", "openai-level", "compat-level", "budget", "user-defined"},
			bodies: []string{
				`{}`,
				`{"messages":[{"role":"user","content":"hi"}]}`,
				`{"reasoning_effort":"high"}`,
				`{"reasoning_effort":"none"}`,
				`{"reasoning_effort":"low"}`,
				`{"reasoning_effort":"xhigh"}`,
				`{"reasoning_effort":"max"}`,
				`{"reasoning_effort":"auto"}`,
				`{"reasoning_effort":"minimal"}`,
				`{"reasoning_effort":"HIGH"}`,
				`{"reasoning_effort":"ultra"}`,
				`{"reasoning_effort":""}`,
				`{"reasoning_effort":17}`,
				`{"reasoning_effort":null}`,
				`{"reasoning_effort":"high","reasoning":{"exclude":false}}`,
				`{"reasoning_effort":"medium","include_reasoning":true,"reasoning":{"summary":"auto"}}`,
				`{"reasoning":{"exclude":true,"effort":"low"}}`,
				`{"model":"x","messages":[],"reasoning_effort":"medium","stream":true}`,
			},
		},
		{
			to: "codex", providerKey: "codex", froms: []string{"codex", "openai-response", "openai"},
			models:    []string{"gpt-6-astra", "gpt-5.5", "gpt-6-luna", "grok-build-0.1", "unknown-codex-model"},
			synthetic: []string{"nothink", "level", "level-xhigh", "level-none", "codex-level", "budget", "user-defined"},
			bodies: []string{
				`{}`,
				`{"reasoning":{"effort":"high"}}`,
				`{"reasoning":{"effort":"none"}}`,
				`{"reasoning":{"effort":"xhigh","summary":"auto"}}`,
				`{"reasoning":{"effort":"max","summary":"concise"}}`,
				`{"reasoning":{"effort":"auto"}}`,
				`{"reasoning":{"effort":"low","generate_summary":"detailed"}}`,
				`{"reasoning":{"effort":"ultra"}}`,
				`{"reasoning":{"summary":"auto"}}`,
				`{"reasoning":{"summary":null}}`,
				`{"reasoning":{"effort":null,"other":7}}`,
				`{"reasoning":{"effort":"high"},"input":[{"type":"configuration_update","reasoning":{"effort":"low"}},{"role":"user","content":"ok"}]}`,
				`{"reasoning":{"effort":"xhigh","summary":"auto"},"input":[{"role":"user","content":"a"},{"type":"configuration_update","reasoning":{"effort":"medium"}},{"type":"configuration_update","tools":[]}]}`,
				`{"input":[{"type":"configuration_update","reasoning":{"effort":"none"}}]}`,
				`{"input":[{"type":"configuration_update","reasoning":{"effort":"auto"}},{"role":"user","content":"ok"}]}`,
				`{"reasoning":{"summary":"auto"},"input":{"type":"configuration_update"}}`,
				`{"model":"x","input":"hello","reasoning":{"effort":"medium"}}`,
				`{"reasoning":{"effort":"xhigh"},"input":[`,
			},
		},
		{
			to: "xai", providerKey: "xai", froms: []string{"xai", "openai-response"},
			models:    []string{"grok-4.3", "grok-4.7", "grok-3-mini", "grok-build-0.1", "unknown-xai-model"},
			synthetic: []string{"nothink", "level", "level-none", "level-xhigh", "user-defined"},
			bodies: []string{
				`{}`,
				`{"reasoning":{"effort":"high"}}`,
				`{"reasoning":{"effort":"none"}}`,
				`{"reasoning":{"effort":"xhigh","summary":"auto"}}`,
				`{"reasoning":{"effort":"max"}}`,
				`{"reasoning":{"effort":"auto"}}`,
				`{"reasoning":{"summary":"detailed"}}`,
				`{"reasoning":{"effort":"low"},"input":[{"type":"configuration_update","reasoning":{"effort":"high"}}]}`,
				`{"input":[{"type":"configuration_update","tools":[]},{"role":"user","content":"ok"}]}`,
			},
		},
		{
			to: "kimi", providerKey: "kimi", froms: []string{"kimi", "claude", "openai"},
			models:    []string{"kimi-k2.8", "kimi-k2.7-code", "kimi-k2.5", "kimi-k2", "unknown-kimi-model"},
			synthetic: []string{"nothink", "kimi-level", "kimi-nozero", "level", "level-none", "budget", "user-defined"},
			bodies: []string{
				`{}`,
				`{"thinking":{"type":"disabled"}}`,
				`{"thinking":{"type":"enabled"}}`,
				`{"thinking":{"type":"enabled","effort":"high"}}`,
				`{"thinking":{"type":"enabled","effort":"LOW","keep":"all"}}`,
				`{"thinking":{"type":"enabled","effort":"none"}}`,
				`{"thinking":{"type":"enabled","effort":"auto"}}`,
				`{"thinking":{"effort":"max"}}`,
				`{"thinking":{"type":"enabled","effort":""}}`,
				`{"thinking":{"keep":"all"}}`,
				`{"reasoning_effort":"high"}`,
				`{"reasoning_effort":"none"}`,
				`{"reasoning_effort":"max","messages":[]}`,
				`{"reasoning_effort":"low","thinking":{"type":"enabled"}}`,
				`{"reasoning_effort":"high","thinking":{"type":"disabled"}}`,
				`{"thinking":{"type":"adaptive"},"output_config":{"effort":"max"}}`,
			},
		},
	}
}

// handwrittenApplyCases mirror the Go unit tests in internal/thinking plus extra routing edge cases.
func handwrittenApplyCases() []applyCase {
	var cases []applyCase
	str := func(s string) *string { return &s }
	add := func(c applyCase, info *modelSpec, resolved bool) {
		cases = append(cases, runApply(c, info, resolved))
	}
	sumAuto := &summaryJSON{Mode: "enabled", Detail: "auto"}
	sumOff := &summaryJSON{Mode: "disabled"}
	sumNone := &summaryJSON{Mode: "unspecified"}

	// Claude enabled with output_config.effort routed to an unknown OpenAI model.
	for i, body := range []string{
		`{"model":"custom-openai","messages":[{"role":"user","content":"hi"}],"thinking":{"type":"enabled"},"output_config":{"effort":"high"}}`,
		`{"model":"custom-openai","messages":[{"role":"user","content":"hi"}],"thinking":{"type":"enabled","budget_tokens":8192},"output_config":{"effort":"high"}}`,
		`{"model":"custom-openai","messages":[{"role":"user","content":"hi"}],"thinking":{"type":"enabled"}}`,
		`{"model":"custom-openai","messages":[{"role":"user","content":"hi"}],"thinking":{"type":"enabled"},"output_config":{"effort":""}}`,
		`{"model":"custom-openai","messages":[{"role":"user","content":"hi"}],"thinking":{"type":"enabled"},"output_config":{"effort":"   "}}`,
		`{"model":"custom-openai","messages":[{"role":"user","content":"hi"}],"thinking":{"type":"enabled"},"output_config":{"effort":123}}`,
	} {
		add(applyCase{Name: fmt.Sprintf("claude enabled effort #%d", i), Variant: "plain", Body: body, Model: "custom-openai", From: "claude", To: "openai", ProviderKey: "openai"}, nil, false)
	}
	add(applyCase{Name: "chained claude->openai with source", Variant: "source", Body: `{"model":"custom-openai","messages":[{"role":"user","content":"hi"}],"reasoning_effort":"high"}`,
		Source: str(`{"model":"custom-openai","messages":[{"role":"user","content":"hi"}],"thinking":{"type":"enabled"},"output_config":{"effort":"high"}}`),
		Model:  "custom-openai", From: "claude", To: "openai", ProviderKey: "openai", Summary: sumNone}, nil, false)

	// Kimi served through the Claude protocol.
	for _, model := range []string{"kimi-k2.8", "kimi-k2.5"} {
		add(applyCase{Name: "kimi via claude " + model, Variant: "plain", Body: `{"model":"` + model + `","messages":[{"role":"user","content":"hi"}],"thinking":{"type":"adaptive"},"output_config":{"effort":"max"}}`,
			Model: model, From: "claude", To: "claude", ProviderKey: "claude"}, nil, false)
	}

	// Cross-family high-intent mapping (resolved model info).
	for _, src := range []string{"xhigh", "max"} {
		for _, levels := range [][]string{{"high", "max", "xhigh"}, {"high", "max"}, {"high", "xhigh"}, {"high"}} {
			info := &modelSpec{ID: "claude-upstream", Type: "claude", Thinking: &thinkSpec{Levels: levels}}
			add(applyCase{Name: fmt.Sprintf("high intent %s -> %v", src, levels), Variant: "modelInfo",
				Body: `{"thinking":{"type":"adaptive"},"output_config":{"effort":"low"}}`, Source: str(`{"reasoning_effort":"` + src + `"}`),
				Model: "claude-upstream", From: "openai", To: "claude", ProviderKey: "claude"}, info, true)
		}
	}
	add(applyCase{Name: "compat high intent", Variant: "modelInfo", Body: `{"reasoning_effort":"high"}`, Source: str(`{"reasoning_effort":"xhigh"}`),
		Model: "compat-upstream", From: "openai", To: "openai", ProviderKey: "compat-provider"},
		&modelSpec{ID: "compat-upstream", Type: "openai-compatibility", Thinking: &thinkSpec{Levels: []string{"high", "max"}}}, true)
	add(applyCase{Name: "responses->codex high intent", Variant: "modelInfo", Body: `{"reasoning":{"effort":"high"}}`, Source: str(`{"reasoning":{"effort":"max"}}`),
		Model: "codex-upstream", From: "openai-response", To: "codex", ProviderKey: "codex"},
		&modelSpec{ID: "codex-upstream", Type: "codex", Thinking: &thinkSpec{Levels: []string{"high", "xhigh"}}}, true)
	add(applyCase{Name: "same family stays strict", Variant: "modelInfo", Body: `{"reasoning_effort":"xhigh"}`, Source: str(`{"reasoning_effort":"xhigh"}`),
		Model: "openai-upstream", From: "openai", To: "openai", ProviderKey: "openai"},
		&modelSpec{ID: "openai-upstream", Type: "openai", Thinking: &thinkSpec{Levels: []string{"low", "medium", "high"}}}, true)
	add(applyCase{Name: "responses effort -> claude", Variant: "modelInfo", Body: `{"thinking":{"type":"adaptive"},"output_config":{"effort":"low"}}`, Source: str(`{"reasoning":{"effort":"xhigh"}}`),
		Model: "claude-upstream", From: "openai-response", To: "claude", ProviderKey: "claude"},
		&modelSpec{ID: "claude-upstream", Type: "claude", Thinking: &thinkSpec{Levels: []string{"high", "max"}}}, true)

	// Summary-only requests.
	privateClaude := &modelSpec{ID: "private-claude", Type: "claude", Thinking: &thinkSpec{Levels: []string{"high"}}}
	manualClaude := &modelSpec{ID: "private-manual-claude", Type: "claude", Thinking: &thinkSpec{Min: 1024, Max: 16000}}
	add(applyCase{Name: "summary-only claude enabled", Variant: "modelInfo", Body: `{"model":"private-claude","max_tokens":32000}`, Source: str(`{"reasoning":{"summary":"auto"}}`),
		Model: "private-claude", From: "openai-response", To: "claude", ProviderKey: "claude"}, privateClaude, true)
	add(applyCase{Name: "summary-only claude disabled", Variant: "modelInfo", Body: `{"model":"private-claude","max_tokens":32000}`, Source: str(`{"reasoning":{"summary":null}}`),
		Model: "private-claude", From: "openai-response", To: "claude", ProviderKey: "claude"}, privateClaude, true)
	add(applyCase{Name: "inferred adaptive dropped for manual claude", Variant: "modelInfoSummary", Body: `{"model":"private-manual-claude","max_tokens":32000,"thinking":{"type":"adaptive"}}`,
		Source: str(`{"reasoning":{"summary":"auto"}}`), Model: "private-manual-claude", From: "openai-response", To: "claude", ProviderKey: "claude", Summary: sumNone}, manualClaude, true)
	add(applyCase{Name: "summary-only claude manual enabled", Variant: "modelInfo", Body: `{"model":"private-manual-claude","max_tokens":32000}`, Source: str(`{"reasoning":{"summary":"auto"}}`),
		Model: "private-manual-claude", From: "openai-response", To: "claude", ProviderKey: "claude"}, manualClaude, true)
	add(applyCase{Name: "summary-only claude manual small max_tokens", Variant: "modelInfo", Body: `{"model":"private-manual-claude","max_tokens":1000}`, Source: str(`{"reasoning":{"summary":"auto"}}`),
		Model: "private-manual-claude", From: "openai-response", To: "claude", ProviderKey: "claude"}, manualClaude, true)
	privateOpenAI := &modelSpec{ID: "private-openai", Type: "openai", Thinking: &thinkSpec{Levels: []string{"high", "max"}}}
	add(applyCase{Name: "summary-only openai invents no effort", Variant: "modelInfo", Body: `{"model":"private-openai","messages":[{"role":"user","content":"hi"}]}`,
		Source: str(`{"model":"private-openai","reasoning":{"summary":"auto"},"input":"hi"}`), Model: "private-openai", From: "openai-response", To: "openai", ProviderKey: "openai"}, privateOpenAI, true)
	add(applyCase{Name: "openrouter visibility", Variant: "modelInfo", Body: `{"model":"openrouter-model","messages":[{"role":"user","content":"hi"}]}`,
		Source: str(`{"model":"openrouter-model","reasoning":{"summary":"auto"},"input":"hi"}`), Model: "openrouter-model", From: "openai-response", To: "openai", ProviderKey: "openrouter"},
		&modelSpec{ID: "openrouter-model", Type: "openai-compatibility", Thinking: &thinkSpec{Levels: []string{"high", "max"}}}, true)
	add(applyCase{Name: "openai chat suffix none keeps effort", Variant: "summary", Body: `{"model":"private-openai","messages":[{"role":"user","content":"hi"}]}`,
		Model: "private-openai(none)", From: "openai-response", To: "openai", ProviderKey: "openai", Summary: sumAuto}, nil, false)
	for _, suffix := range []string{"(high)", "(8192)", "(none)", "(auto)"} {
		for _, summary := range []*summaryJSON{sumAuto, sumOff} {
			for _, target := range []struct{ to, body, model string }{
				{"claude", `{"model":"claude-opus-4-6","max_tokens":20000}`, "claude-opus-4-6"},
				{"gemini", `{"generationConfig":{}}`, "gemini-3-flash-preview"},
				{"antigravity", `{"request":{"generationConfig":{}}}`, "gemini-3-flash"},
				{"interactions", `{"generation_config":{}}`, "gemini-3-flash-preview"},
				{"codex", `{"reasoning":{"summary":"auto"}}`, "gpt-5.5"},
				{"openai", `{"messages":[],"reasoning":{"exclude":false}}`, "gpt-5.5"},
			} {
				add(applyCase{Variant: "summary",
					Body: target.body, Model: target.model + suffix, From: target.to, To: target.to, ProviderKey: target.to, Summary: summary}, nil, false)
			}
		}
	}

	// Configuration updates (Responses): routing by model support and suffix.
	updateModel := func(supported, noThinking bool) *modelSpec {
		spec := &modelSpec{ID: "configured-responses", Type: "codex", SupportConfigurationUpdate: supported, Thinking: &thinkSpec{Levels: []string{"low", "medium", "high", "xhigh"}}}
		if noThinking {
			spec.Thinking = nil
		}
		return spec
	}
	updateBodies := []string{
		`{"reasoning":{"effort":"xhigh","summary":"auto"},"input":[{"type":"configuration_update","reasoning":{"effort":"low"}},{"role":"user","content":"ok"}]}`,
		`{"reasoning":{"summary":"auto"},"input":[{"type":"configuration_update","tools":[]},{"role":"user","content":"ok"}]}`,
		`{"reasoning":{"effort":"xhigh","summary":"auto","other":7},"input":[{"role":"user","content":"first"},{"type":"configuration_update","reasoning":{"effort":"low"}},{"type":"configuration_update","reasoning":{"effort":"  "}},{"role":"assistant","content":"reply"},{"type":"configuration_update","reasoning":{"effort":"medium"}},{"type":"configuration_update","tools":[]},{"role":"user","content":"last"}]}`,
		`{"reasoning":{"summary":"auto"},"input":[{"type":"configuration_update","reasoning":{"effort":"low"}},{"type":"configuration_update","reasoning":{"effort":42}},{"type":"configuration_update","reasoning":{"effort":null}},{"role":"user","content":"ok"}]}`,
		`{"input":[{"type":"configuration_update","reasoning":{"effort":"low"}},{"role":"user","content":"ok"}]}`,
		`{"reasoning":{"generate_summary":"auto"},"input":[{"type":"configuration_update","reasoning":{"effort":"low"}},{"role":"user","content":"ok"}]}`,
		`{"reasoning":{"summary":"auto"},"input":{"type":"configuration_update","reasoning":{"effort":"low"}}}`,
		`{"reasoning":{"effort":"xhigh"},"input":[`,
	}
	for i, body := range updateBodies {
		for _, supported := range []bool{false, true} {
			for _, noThinking := range []bool{false, true} {
				for _, suffix := range []string{"", "(high)", "(invalid)", "(none)"} {
					for _, from := range []string{"codex", "openai-response"} {
						// gjson reads the unparsable source leniently for "openai-response" (no validity check in
						// extractCodexConfig); the Workers port only ever sees parsed bodies, so skip that quirk.
						if i == len(updateBodies)-1 && from == "openai-response" {
							continue
						}
						add(applyCase{Variant: "modelInfo",
							Body: body, Source: str(body), Model: "configured-responses" + suffix, From: from, To: from, ProviderKey: "codex"}, updateModel(supported, noThinking), true)
					}
				}
			}
		}
	}
	crossSource := `{"reasoning":{"effort":"xhigh","summary":"auto"},"input":[{"type":"configuration_update","reasoning":{"effort":"low"}},{"role":"user","content":"ok"},{"type":"configuration_update","reasoning":{"effort":"high"}}]}`
	for _, supported := range []bool{false, true} {
		for _, suffix := range []string{"", "(low)"} {
			add(applyCase{Variant: "modelInfo",
				Body: `{"messages":[{"role":"user","content":"ok"}],"reasoning_effort":"medium","other":true}`, Source: str(crossSource), Model: "private-chat" + suffix,
				From: "openai-response", To: "openai", ProviderKey: "openai"},
				&modelSpec{ID: "private", Type: "openai", SupportConfigurationUpdate: supported, Thinking: &thinkSpec{Levels: []string{"low", "medium", "high", "xhigh"}}}, true)
			add(applyCase{Variant: "modelInfo",
				Body: `{"max_tokens":4096,"thinking":{"type":"adaptive"},"output_config":{"effort":"medium"},"other":true}`, Source: str(crossSource), Model: "private-claude" + suffix,
				From: "openai-response", To: "claude", ProviderKey: "claude"},
				&modelSpec{ID: "private", Type: "claude", SupportConfigurationUpdate: supported, Thinking: &thinkSpec{Levels: []string{"low", "medium", "high", "xhigh"}}}, true)
		}
	}
	// Registry-resolved entry points (gpt-6-astra supports configuration updates; unknown gpt-6 routes do not).
	entrySource := `{"reasoning":{"effort":"xhigh","summary":"auto"},"input":[{"type":"configuration_update","reasoning":{"effort":"low"}},{"role":"user","content":"ok"}]}`
	entryTarget := `{"reasoning":{"effort":"xhigh","summary":"auto"},"input":[{"type":"configuration_update","reasoning":{"effort":"medium"}},{"role":"user","content":"ok"}]}`
	for _, model := range []string{"gpt-6-astra", "gpt-6-unknown-routed", "gpt-6-astra(high)", "gpt-6-unknown-routed(high)"} {
		for _, body := range []string{entrySource, entryTarget, `{"reasoning":{"summary":"auto"},"input":{"type":"configuration_update"}}`} {
			add(applyCase{Name: "source entry " + model, Variant: "source", Body: body, Source: str(entrySource), Model: model, From: "openai-response", To: "codex", ProviderKey: "codex",
				Summary: &summaryJSON{Mode: "enabled", Detail: "auto"}}, nil, false)
		}
		add(applyCase{Name: "source entry chat " + model, Variant: "source", Body: `{"reasoning_effort":"xhigh","messages":[{"role":"user","content":"ok"}]}`, Source: str(entrySource), Model: model,
			From: "openai-response", To: "openai", ProviderKey: "openai", Summary: &summaryJSON{Mode: "enabled", Detail: "auto"}}, nil, false)
		add(applyCase{Name: "plain native " + model, Variant: "plain", Body: entrySource, Model: model, From: "codex", To: "codex", ProviderKey: "codex"}, nil, false)
	}
	for _, model := range []string{"gpt-6-sol"} {
		for _, body := range []string{
			`{"model":"gpt-6-sol","reasoning":{"effort":"high","summary":"auto"},"input":[{"type":"configuration_update","reasoning":{"effort":"xhigh"}},{"role":"user","content":"ok"}]}`,
			`{"model":"gpt-6-sol","input":[{"type":"configuration_update","reasoning":{"effort":"none"}}]}`,
		} {
			add(applyCase{Name: "native logging " + model, Variant: "plain", Body: body, Model: model, From: "codex", To: "codex", ProviderKey: "codex"}, nil, false)
		}
	}
	// Invalid targets must not be rebuilt from a separate source update.
	invalidTarget := `{"reasoning":{"effort":"xhigh"},"input":[`
	updateSource := `{"reasoning":{"effort":"medium"},"input":[{"type":"configuration_update","reasoning":{"effort":"low"}},{"role":"user","content":"ok"}]}`
	privateCodex := &modelSpec{ID: "private-codex", Type: "codex", Thinking: &thinkSpec{Levels: []string{"low", "medium", "high", "xhigh"}}}
	for _, normalized := range []bool{false, true} {
		for _, model := range []string{"private-codex", "private-codex(high)"} {
			for _, source := range []*string{nil, str(updateSource)} {
				add(applyCase{Variant: "modelInfoSummary",
					Body: invalidTarget, Source: source, Model: model, From: "codex", To: "codex", ProviderKey: "codex", Summary: sumNone, Normalized: normalized}, privateCodex, true)
				add(applyCase{Variant: "source",
					Body: invalidTarget, Source: source, Model: model, From: "codex", To: "codex", ProviderKey: "codex", Summary: sumNone, Normalized: normalized}, nil, false)
			}
		}
	}
	// Bound model without thinking / user-defined / native.
	body := entrySource
	add(applyCase{Name: "bound nil model", Variant: "modelInfoSummary", Body: body, Source: str(body), Model: "gpt-6-astra", From: "codex", To: "codex", ProviderKey: "codex", Summary: sumAuto}, nil, true)
	add(applyCase{Name: "bound user-defined", Variant: "modelInfoSummary", Body: body, Source: str(body), Model: "custom", From: "codex", To: "codex", ProviderKey: "codex", Summary: sumAuto},
		&modelSpec{ID: "custom", UserDefined: true}, true)
	for _, model := range []string{"custom", "custom(high)"} {
		add(applyCase{Name: "bound native user-defined " + model, Variant: "modelInfoSummary", Body: body, Source: str(body), Model: model, From: "codex", To: "codex", ProviderKey: "codex", Summary: sumAuto},
			&modelSpec{ID: "custom", UserDefined: true, SupportConfigurationUpdate: true}, true)
	}
	return cases
}

// providerSummaryCases exercise the provider-aware summary re-application (OpenRouter and other Chat dialects, Claude
// thinking activation from the resolved model) through the exported entry points, with bodies that carry no effort.
func providerSummaryCases() []applyCase {
	var cases []applyCase
	configs := []*summaryJSON{{Mode: "enabled", Detail: "auto"}, {Mode: "disabled"}}
	chatBodies := []string{`{}`, `{"reasoning_effort":"high"}`, `{"reasoning_effort":"max"}`, `{"thinking":{"type":"enabled"}}`, `{"reasoning":{"exclude":false}}`, `{"reasoning":{"exclude":"x"}}`, `{"include_reasoning":true}`, `{"include_reasoning":false,"reasoning":{"exclude":true}}`}
	infos := []*modelSpec{nil, {ID: "chat-model", Type: "openai-compatibility", Thinking: &thinkSpec{Levels: []string{"high", "max"}}}, {ID: "user", UserDefined: true}}
	for _, provider := range []string{"openai", "openrouter", "prod-openrouter", "my_openrouter/x", "deepseek", "kimi", "moonshot", "openai-compatibility", "OpenRouter", "open-router"} {
		for _, info := range infos {
			for _, body := range chatBodies {
				for _, cfg := range configs {
					cases = append(cases, runApply(applyCase{
						Variant: "modelInfoSummary",
						Body:    body, Model: "chat-model", From: "openai", To: "openai", ProviderKey: provider, Summary: cfg,
					}, info, true))
				}
			}
		}
	}
	claudeBodies := []string{`{"max_tokens":32000}`, `{"max_tokens":1000}`, `{"max_tokens":3000}`, `{}`, `{"thinking":{"type":"disabled"}}`, `{"thinking":{"type":"adaptive"}}`, `{"thinking":{"type":"enabled","budget_tokens":2048}}`, `{"thinking":{"type":"enabled","budget_tokens":0}}`}
	for _, info := range []*modelSpec{
		nil,
		{ID: "private-claude", Type: "claude", Thinking: &thinkSpec{Levels: []string{"high"}}},
		{ID: "private-manual", Type: "claude", Thinking: &thinkSpec{Min: 2048, Max: 16000}},
		{ID: "private-zero-min", Type: "claude", Thinking: &thinkSpec{Max: 16000}},
		{ID: "private-user", Type: "claude", UserDefined: true},
	} {
		for _, body := range claudeBodies {
			for _, cfg := range configs {
				for _, from := range []string{"claude", "openai-response"} {
					cases = append(cases, runApply(applyCase{
						Variant: "modelInfoSummary",
						Body:    body, Model: "private", From: from, To: "claude", ProviderKey: "claude", Summary: cfg,
					}, info, true))
				}
			}
		}
	}
	return cases
}

// synthRef reports whether info is one of the shared synthetic models (referenced by id instead of inlined).
func synthRef(info *modelSpec) bool {
	shared, ok := syntheticByID()[info.ID]
	return ok && shared == info
}
