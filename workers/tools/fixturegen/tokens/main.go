// Command tokens emits the tokenizer assets and golden fixtures for the TypeScript token counting code
// (workers/src/tokenizer, workers/src/executor/helps/token-count.ts).
//
//   - workers/src/tokenizer/ranks/{o200k_base,cl100k_base}.bin: the vocabularies of the Go tokenizer
//     (tiktoken-go/tokenizer) in rank order, so the TypeScript BPE uses exactly the ranks Go uses.
//   - workers/test/fixtures/tokens.json: token counts of a text corpus per encoding, the model -> encoding mapping of
//     helps.TokenizerForModel, the real Go executors' CountTokens answers (Codex, OpenAI-compatibility, xAI, Meta,
//     Claude local estimate), the Claude input estimate over request corpora and the Claude stream message_start
//     patching (helps.TranslateStreamWithClaudeInputTokens).
//
// Run from the repository root:
//
//	go run ./workers/tools/fixturegen/tokens
package main

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"flag"
	"fmt"
	"net/http"
	"os"
	"path/filepath"

	"github.com/router-for-me/CLIProxyAPI/v8/internal/config"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/runtime/executor"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/runtime/executor/helps"
	_ "github.com/router-for-me/CLIProxyAPI/v8/internal/translator"
	cliproxyauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	cliproxyexecutor "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/executor"
	sdktranslator "github.com/router-for-me/CLIProxyAPI/v8/sdk/translator"
	"github.com/tiktoken-go/tokenizer"
)

type countCase struct {
	Text  string `json:"text"`
	Count int    `json:"count"`
}

type modelCase struct {
	Model    string `json:"model"`
	Encoding string `json:"encoding"`
}

type executorCase struct {
	Provider string `json:"provider"`
	Model    string `json:"model"`
	Source   string `json:"source"`
	Payload  string `json:"payload"`
	Out      string `json:"out,omitempty"`
	Error    string `json:"error,omitempty"`
}

type claudeCase struct {
	Payload string `json:"payload"`
	Count   int64  `json:"count"`
}

type streamStep struct {
	In  string   `json:"in"`
	Out []string `json:"out"`
}

type streamCase struct {
	Name     string `json:"name"`
	Upstream string `json:"upstream"`
	Original string `json:"original"`
	// Translated is the provider-format request handed to the response translator ("" = none).
	Translated string       `json:"translated,omitempty"`
	Model      string       `json:"model"`
	Steps      []streamStep `json:"steps"`
}

type fixtures struct {
	Counts    map[string][]countCase `json:"counts"`
	Models    []modelCase            `json:"models"`
	Claude    []claudeCase           `json:"claude"`
	Executors []executorCase         `json:"executors"`
	Streams   []streamCase           `json:"streams"`
}

func main() {
	outPath := flag.String("out", "workers/test/fixtures/tokens.json", "fixture output file")
	ranksDir := flag.String("ranks", "workers/src/tokenizer/ranks", "rank asset output directory")
	flag.Parse()

	if err := writeRanks(*ranksDir); err != nil {
		fatal(err)
	}

	out := fixtures{Counts: map[string][]countCase{}}
	texts := textCorpus()
	for _, name := range []tokenizer.Encoding{tokenizer.O200kBase, tokenizer.Cl100kBase} {
		codec, err := tokenizer.Get(name)
		if err != nil {
			fatal(err)
		}
		for _, text := range texts {
			n, errCount := codec.Count(text)
			if errCount != nil {
				fatal(errCount)
			}
			out.Counts[string(name)] = append(out.Counts[string(name)], countCase{Text: text, Count: n})
		}
	}

	for _, model := range modelNames() {
		codec, err := helps.TokenizerForModel(model)
		if err != nil {
			fatal(err)
		}
		out.Models = append(out.Models, modelCase{Model: model, Encoding: codec.GetName()})
	}

	for _, payload := range claudePayloads {
		n, err := helps.CountClaudeInputTokens([]byte(payload))
		if err != nil {
			fatal(err)
		}
		out.Claude = append(out.Claude, claudeCase{Payload: payload, Count: n})
	}

	out.Executors = executorScenarios()
	out.Streams = streamScenarios()

	data, err := json.MarshalIndent(out, "", "  ")
	if err != nil {
		fatal(err)
	}
	if err = os.MkdirAll(filepath.Dir(*outPath), 0o755); err != nil {
		fatal(err)
	}
	if err = os.WriteFile(*outPath, append(data, '\n'), 0o644); err != nil {
		fatal(err)
	}
	fmt.Printf("wrote %s (%d count cases per encoding, %d executor scenarios, %d stream scenarios)\n",
		*outPath, len(texts), len(out.Executors), len(out.Streams))
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, err)
	os.Exit(1)
}

// writeRanks stores each vocabulary as `count:u32le` followed by `len:u8, bytes` per token in rank order.
func writeRanks(dir string) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	for _, name := range []tokenizer.Encoding{tokenizer.O200kBase, tokenizer.Cl100kBase} {
		codec, err := tokenizer.Get(name)
		if err != nil {
			return err
		}
		var tokens []string
		for id := uint(0); ; id++ {
			piece, errDecode := codec.Decode([]uint{id})
			if errDecode != nil {
				break
			}
			if len(piece) == 0 || len(piece) > 255 {
				return fmt.Errorf("%s: token %d has length %d", name, id, len(piece))
			}
			tokens = append(tokens, piece)
		}
		// Ranks must be contiguous: probing past the end has to fail.
		if _, errProbe := codec.Decode([]uint{uint(len(tokens)) + 1}); errProbe == nil {
			return fmt.Errorf("%s: vocabulary is not contiguous at %d", name, len(tokens))
		}
		buf := binary.LittleEndian.AppendUint32(nil, uint32(len(tokens)))
		for _, piece := range tokens {
			buf = append(buf, byte(len(piece)))
			buf = append(buf, piece...)
		}
		path := filepath.Join(dir, string(name)+".bin")
		if err = os.WriteFile(path, buf, 0o644); err != nil {
			return err
		}
		fmt.Printf("wrote %s (%d tokens, %d bytes)\n", path, len(tokens), len(buf))
	}
	return nil
}

type counter interface {
	CountTokens(context.Context, *cliproxyauth.Auth, cliproxyexecutor.Request, cliproxyexecutor.Options) (cliproxyexecutor.Response, error)
}

// sourcePayloads pairs each client protocol with its payload corpus.
func sourcePayloads() []struct {
	source   string
	payloads []string
} {
	return []struct {
		source   string
		payloads []string
	}{
		{"openai", openAIChatPayloads},
		{"openai-response", responsesPayloads},
		{"claude", claudePayloads},
		{"gemini", geminiPayloads},
	}
}

func executorScenarios() []executorCase {
	cfg := &config.Config{}
	ctx := context.Background()
	headers := http.Header{"User-Agent": []string{"codex_cli_rs/0.1"}}

	var cases []executorCase
	add := func(provider string, exec counter, auth *cliproxyauth.Auth, models []string, sources []string) {
		for _, group := range sourcePayloads() {
			if !contains(sources, group.source) {
				continue
			}
			for _, model := range models {
				for _, payload := range group.payloads {
					c := executorCase{Provider: provider, Model: model, Source: group.source, Payload: payload}
					resp, err := exec.CountTokens(ctx, auth, cliproxyexecutor.Request{Model: model, Payload: []byte(payload)},
						cliproxyexecutor.Options{SourceFormat: sdktranslator.FromString(group.source), Headers: headers})
					if err != nil {
						c.Error = err.Error()
					} else {
						c.Out = string(resp.Payload)
					}
					cases = append(cases, c)
				}
			}
		}
	}

	allSources := []string{"openai", "openai-response", "claude", "gemini"}
	add("codex", executor.NewCodexExecutor(cfg), nil,
		[]string{"gpt-5.4", "gpt-4o", "gpt-4.1", "gpt-4", "gpt-3.5-turbo", "o3", ""}, allSources)
	add("openai-compat", executor.NewOpenAICompatExecutor("openai-compatibility", cfg), nil,
		[]string{"gpt-5", "gpt-4o", "gpt-4.1", "gpt-4", "gpt-3.5-turbo", "o1-mini", "o4-mini", "qwen3-coder", ""}, allSources)
	add("xai", executor.NewXAIExecutor(cfg), nil, []string{"grok-4"}, []string{"openai", "openai-response", "claude"})
	metaAuth := &cliproxyauth.Auth{Provider: "meta", Attributes: map[string]string{"api_key": "fixture-key"}}
	add("meta", executor.NewMetaExecutor(cfg), metaAuth, []string{"muse-spark"}, []string{"openai", "openai-response", "claude"})
	claudeAuth := &cliproxyauth.Auth{Provider: "claude", Attributes: map[string]string{"api_key": "fixture-key", "base_url": "https://gateway.example.com"}}
	add("claude", executor.NewClaudeExecutor(cfg), claudeAuth, []string{"claude-sonnet-4"}, []string{"claude", "openai", "openai-response"})
	return cases
}

func contains(items []string, item string) bool {
	for _, candidate := range items {
		if candidate == item {
			return true
		}
	}
	return false
}
