// Command translator emits golden fixtures for the TypeScript translators (workers/src/translator).
//
// Every corpus case is run through the real Go translator registry (sdk/translator with the built-in
// internal/translator registrations): the client request is translated to the provider format, every upstream
// response line is fed to the stream translator with one shared per-request state, and the upstream body to the
// non-stream translator. Provider slices only add corpus files. Run from the repository root:
//
//	go run ./workers/tools/fixturegen/translator
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/router-for-me/CLIProxyAPI/v8/internal/config"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/runtime/executor/helps"
	sdktranslator "github.com/router-for-me/CLIProxyAPI/v8/sdk/translator"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/translator/builtin"
)

// corpusCase is the authored input of a case.
type corpusCase struct {
	Name string `json:"name"`
	// From is the client format, To the provider format.
	From   string `json:"from"`
	To     string `json:"to"`
	Model  string `json:"model"`
	Stream bool   `json:"stream"`
	// Needs lists TypeScript capabilities the case depends on (e.g. "thinking-summary"); the TS harness skips
	// cases whose needs are not implemented yet.
	Needs []string `json:"needs,omitempty"`
	// Alt is the Gemini `alt` request option the handlers put into the translator context (`ctx.Value("alt")`).
	Alt     *string         `json:"alt,omitempty"`
	Request json.RawMessage `json:"request"`
	// ResponseLines are raw upstream SSE lines (without line terminators) for the stream translator.
	ResponseLines []string `json:"responseLines,omitempty"`
	// ResponseBody is the raw upstream body for the non-stream translator.
	ResponseBody json.RawMessage `json:"responseBody,omitempty"`
	// TokenCount, when set, is passed to the token-count translator with TokenCountUsage as provider JSON.
	TokenCount      *int64          `json:"tokenCount,omitempty"`
	TokenCountUsage json.RawMessage `json:"tokenCountUsage,omitempty"`
	// Executor runs the request through the executor-level helper (helps.TranslateRequestReturningError: compat
	// request variants, Codex multi-agent v2 and orphan delegation rewriting) instead of the bare registry.
	Executor *executorSpec `json:"executor,omitempty"`
}

// executorSpec is the executor context of a case.
type executorSpec struct {
	Headers              map[string]string `json:"headers,omitempty"`
	Compat               bool              `json:"compat,omitempty"`
	OptimizeMultiAgentV2 bool              `json:"optimizeMultiAgentV2,omitempty"`
	OrphanDelegation     bool              `json:"orphanDelegation,omitempty"`
}

type fixtureCase struct {
	corpusCase
	// TranslatedRequest is the provider body produced by the request translator (raw Go bytes).
	TranslatedRequest string `json:"translatedRequest"`
	// RequestError is the request-scoped refusal, if any.
	RequestError string `json:"requestError,omitempty"`
	// ResponseBodyText is the exact upstream body fed to the non-stream translator.
	ResponseBodyText string `json:"responseBodyText,omitempty"`
	// StreamOutputs holds the client chunks emitted for each response line.
	StreamOutputs [][]string `json:"streamOutputs,omitempty"`
	// NonStreamOutput is the client body produced from ResponseBody (null when the translator failed).
	NonStreamOutput  *string `json:"nonStreamOutput,omitempty"`
	TokenCountOutput *string `json:"tokenCountOutput,omitempty"`
}

// compactJSON strips insignificant whitespace like a client's JSON encoder would, so raw-text reads in the Go
// translators (gjson `.Raw`) do not depend on how the corpus file is formatted.
func compactJSON(raw []byte) []byte {
	var buf bytes.Buffer
	if err := json.Compact(&buf, raw); err != nil {
		return raw
	}
	return buf.Bytes()
}

func run(registry *sdktranslator.Registry, c corpusCase) (fixtureCase, error) {
	ctx := context.Background()
	if c.Alt != nil {
		ctx = context.WithValue(ctx, "alt", *c.Alt)
	}
	c.Request = compactJSON(c.Request)
	from := sdktranslator.FromString(c.From)
	to := sdktranslator.FromString(c.To)
	out := fixtureCase{corpusCase: c}

	var env sdktranslator.RequestEnvelope
	if c.Executor != nil {
		cfg := &config.Config{}
		cfg.Client.Codex.OptimizeMultiAgentV2 = c.Executor.OptimizeMultiAgentV2
		cfg.Codex.OrphanDelegationCompatibility = c.Executor.OrphanDelegation
		headers := http.Header{}
		for key, value := range c.Executor.Headers {
			headers.Set(key, value)
		}
		body, err := helps.TranslateRequestReturningError(ctx, headers, cfg, from, to, c.Model, []byte(c.Request), c.Stream, c.Executor.Compat)
		env.Body = body
		env.Err = err
	} else {
		env = registry.TranslateRequestEnvelope(ctx, from, to, sdktranslator.RequestEnvelope{
			Format: from,
			Model:  c.Model,
			Stream: c.Stream,
			Body:   []byte(c.Request),
		})
	}
	out.TranslatedRequest = string(env.Body)
	if env.Err != nil {
		out.RequestError = env.Err.Error()
	}

	if len(c.ResponseLines) > 0 {
		var param any
		for _, line := range c.ResponseLines {
			chunks := registry.TranslateStream(ctx, to, from, c.Model, []byte(c.Request), env.Body, []byte(line), &param)
			outputs := make([]string, 0, len(chunks))
			for _, chunk := range chunks {
				outputs = append(outputs, string(chunk))
			}
			out.StreamOutputs = append(out.StreamOutputs, outputs)
		}
	}
	if len(c.ResponseBody) > 0 {
		var param any
		body := compactJSON(c.ResponseBody)
		// A JSON string holds a raw (possibly non-JSON) body.
		var raw string
		if json.Unmarshal(body, &raw) == nil {
			body = []byte(raw)
		}
		out.ResponseBodyText = string(body)
		if result := registry.TranslateNonStream(ctx, to, from, c.Model, []byte(c.Request), env.Body, body, &param); result != nil {
			text := string(result)
			out.NonStreamOutput = &text
		}
	}
	if c.TokenCount != nil {
		result := string(registry.TranslateTokenCount(ctx, to, from, *c.TokenCount, []byte(c.TokenCountUsage)))
		out.TokenCountOutput = &result
	}
	return out, nil
}

func main() {
	corpusDir := flag.String("corpus", "workers/tools/fixturegen/translator/corpus", "directory with corpus *.json files")
	outDir := flag.String("out", "workers/test/fixtures/translator", "output directory")
	flag.Parse()

	files, err := filepath.Glob(filepath.Join(*corpusDir, "*.json"))
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	sort.Strings(files)
	if err = os.MkdirAll(*outDir, 0o755); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	registry := builtin.Registry()
	for _, file := range files {
		data, errRead := os.ReadFile(file)
		if errRead != nil {
			fmt.Fprintln(os.Stderr, errRead)
			os.Exit(1)
		}
		var cases []corpusCase
		if errUnmarshal := json.Unmarshal(data, &cases); errUnmarshal != nil {
			fmt.Fprintf(os.Stderr, "%s: %v\n", file, errUnmarshal)
			os.Exit(1)
		}
		fixtures := make([]fixtureCase, 0, len(cases))
		for _, c := range cases {
			if strings.TrimSpace(c.Name) == "" || c.From == "" || c.To == "" {
				fmt.Fprintf(os.Stderr, "%s: case without name/from/to\n", file)
				os.Exit(1)
			}
			fixture, errRun := run(registry, c)
			if errRun != nil {
				fmt.Fprintf(os.Stderr, "%s: %s: %v\n", file, c.Name, errRun)
				os.Exit(1)
			}
			fixtures = append(fixtures, fixture)
		}
		encoded, errMarshal := json.MarshalIndent(fixtures, "", " ")
		if errMarshal != nil {
			fmt.Fprintln(os.Stderr, errMarshal)
			os.Exit(1)
		}
		target := filepath.Join(*outDir, filepath.Base(file))
		if errWrite := os.WriteFile(target, append(encoded, '\n'), 0o644); errWrite != nil {
			fmt.Fprintln(os.Stderr, errWrite)
			os.Exit(1)
		}
		fmt.Printf("wrote %d translator cases to %s\n", len(fixtures), target)
	}
}
