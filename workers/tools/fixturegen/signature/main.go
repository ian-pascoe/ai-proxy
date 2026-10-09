// Command signature emits golden fixtures for the TypeScript signature decision table (workers/src/signature).
//
// A corpus of synthetic signature envelopes (Claude E/R/Q/CAIS, Gemini, GPT, SWE, prefixed and malformed values) is
// run through the real internal/signature functions: provider detection, compatibility decisions for every target
// provider, Claude validation under each option set and the Antigravity Claude normalisation. Run from the
// repository root:
//
//	go run ./workers/tools/fixturegen/signature
package main

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"flag"
	"fmt"
	"os"

	"github.com/router-for-me/CLIProxyAPI/v8/internal/signature"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/signature/signaturetest"
	"google.golang.org/protobuf/encoding/protowire"
)

func varint(dst []byte, field protowire.Number, value uint64) []byte {
	return protowire.AppendVarint(protowire.AppendTag(dst, field, protowire.VarintType), value)
}

func bytesField(dst []byte, field protowire.Number, value []byte) []byte {
	return protowire.AppendBytes(protowire.AppendTag(dst, field, protowire.BytesType), value)
}

func b64(raw []byte) string { return base64.StdEncoding.EncodeToString(raw) }

// classicPayload builds the 0x12 envelope: top-level field 2 container -> field 1 channel block.
func classicPayload(channelID uint64, infra *uint64, model string) []byte {
	var channel []byte
	channel = varint(channel, 1, channelID)
	if infra != nil {
		channel = varint(channel, 2, *infra)
	}
	channel = varint(channel, 3, 2)
	channel = bytesField(channel, 5, make([]byte, 64))
	if model != "" {
		channel = bytesField(channel, 6, []byte(model))
	}
	container := bytesField(nil, 1, channel)
	container = bytesField(container, 2, make([]byte, 12))
	return bytesField(nil, 2, container)
}

func cais(version uint64, modelText string) []byte {
	var channel []byte
	channel = varint(channel, 1, 16)
	channel = varint(channel, 3, 2)
	channel = bytesField(channel, 5, make([]byte, 64))
	if modelText != "" {
		channel = bytesField(channel, 6, []byte(modelText))
	}
	channel = bytesField(channel, 8, []byte("thinking"))
	container := bytesField(nil, 1, channel)
	payload := varint(nil, 1, version)
	payload = bytesField(payload, 2, container)
	return varint(payload, 3, 1)
}

// gemini builds the protobuf_field_2 envelope around a Tink-prefixed opaque payload.
func geminiField2(opaque []byte) []byte {
	return bytesField(nil, 2, bytesField(nil, 1, opaque))
}

type result struct {
	Name           string            `json:"name"`
	Signature      string            `json:"signature"`
	Detected       map[string]string `json:"detected"`
	Compatible     map[string]any    `json:"compatible"`
	Decisions      map[string]any    `json:"decisions"`
	AntigravityTag any               `json:"antigravityClaude"`
	ClaudeValid    map[string]bool   `json:"claudeValid"`
	Normalized     map[string]any    `json:"normalized"`
}

type decision struct {
	Compatible bool   `json:"compatible"`
	Action     string `json:"action"`
	Detected   string `json:"detected"`
	Normalized string `json:"normalized"`
	Replace    string `json:"replacement"`
}

func main() {
	out := flag.String("out", "workers/test/fixtures/signature.json", "output file")
	flag.Parse()

	infra1, infra2 := uint64(1), uint64(2)
	classicE := b64(classicPayload(11, nil, ""))
	classicE16 := b64(classicPayload(16, nil, "claude-opus-4-7"))
	classicEGoogle := b64(classicPayload(11, &infra2, ""))
	classicEAws := b64(classicPayload(12, &infra1, ""))
	classicNoChannel := b64(bytesField(nil, 2, bytesField(nil, 1, varint(nil, 3, 1))))
	rForm := b64([]byte(classicE))
	rForm16 := b64([]byte(classicE16))
	rFormGoogle := b64([]byte(classicEGoogle))
	badMarker := b64([]byte{0x13, 0x00, 0x01, 0x02})
	rBadStrict := b64([]byte(b64([]byte{0x12, 0x01, 0x00})))
	caqs := signaturetest.AntigravityCAQS()
	caisOpus5 := b64(cais(2, "claude-opus-5"))
	caisNoModel := b64(cais(2, ""))
	geminiTink := b64(geminiField2(append([]byte{0x01}, make([]byte, 40)...)))
	geminiUUID := b64(geminiField2([]byte("123e4567-e89b-12d3-a456-426614174000")))
	fernet := make([]byte, 73)
	fernet[0] = 0x80
	for i := 9; i < len(fernet); i++ {
		fernet[i] = byte(i * 7)
	}
	gptFernet := base64.RawURLEncoding.EncodeToString(fernet)
	kimiRaw := make([]byte, 0, 3255)
	for block := sha256.Sum256([]byte("kimi")); len(kimiRaw) < 3255; block = sha256.Sum256(block[:]) {
		kimiRaw = append(kimiRaw, block[:]...)
	}
	kimiLike := base64.RawStdEncoding.EncodeToString(kimiRaw[:3255])
	caqsBadInfra := func() string {
		var channel []byte
		channel = varint(channel, 1, 18)
		channel = varint(channel, 2, 1)
		channel = bytesField(channel, 8, []byte("thinking"))
		container := bytesField(nil, 1, channel)
		container = bytesField(container, 5, make([]byte, 100))
		payload := varint(nil, 1, 4)
		payload = bytesField(payload, 2, container)
		return b64([]byte(b64(payload)))
	}()

	samples := []struct{ name, sig string }{
		{"empty", ""},
		{"whitespace", "   "},
		{"classic-E-channel11", classicE},
		{"classic-E-channel16-model", classicE16},
		{"classic-E-google", classicEGoogle},
		{"classic-E-aws-channel12", classicEAws},
		{"classic-E-no-channel-id", classicNoChannel},
		{"classic-R-channel11", rForm},
		{"classic-R-channel16-model", rForm16},
		{"classic-R-google", rFormGoogle},
		{"E-bad-marker", badMarker},
		{"R-valid-base64-bad-strict", rBadStrict},
		{"antigravity-CAQS", caqs},
		{"antigravity-CAQS-wrong-infra", caqsBadInfra},
		{"claude-CAIS-opus5", caisOpus5},
		{"claude-CAIS-no-model", caisNoModel},
		{"gemini-tink-envelope", geminiTink},
		{"gemini-uuid-envelope", geminiUUID},
		{"gemini-bypass-skip", "skip_thought_signature_validator"},
		{"gemini-bypass-context", "context_engineering_is_the_way_to_go"},
		{"gpt-fernet", gptFernet},
		{"kimi-like-4340", kimiLike},
		{"swe-sealed", "sealed.v1.abcdef"},
		{"prefixed-claude-R", "claude#" + rForm},
		{"prefixed-gemini-tink", "gemini#" + geminiTink},
		{"prefixed-gemini-bypass", "gemini#skip_thought_signature_validator"},
		{"prefixed-gpt-fernet", "gpt#" + gptFernet},
		{"prefixed-codex-fernet", "codex#" + gptFernet},
		{"prefixed-swe", "swe#sealed.v1.abcdef"},
		{"double-prefix", "claude#gemini#" + rForm},
		{"unknown-prefix", "foo#" + rForm},
		{"hash-in-middle", "abc#def#ghi"},
		{"random-text", "not a signature at all"},
		{"padded-R", "  " + rForm + "  "},
		{"claude-E-newline", classicE[:20] + "\n" + classicE[20:]},
	}
	targets := []signature.SignatureProvider{
		signature.SignatureProviderClaude, signature.SignatureProviderGemini, signature.SignatureProviderGPT,
		signature.SignatureProviderKimi, signature.SignatureProviderGrok, signature.SignatureProviderSWE,
		signature.SignatureProviderUnknown,
	}
	kinds := []signature.SignatureBlockKind{
		signature.SignatureBlockKindUnknown, signature.SignatureBlockKindClaudeThinking,
		signature.SignatureBlockKindGeminiModelPart, signature.SignatureBlockKindGeminiFunctionCall,
	}
	optionSets := map[string]signature.ClaudeSignatureValidationOptions{
		"default":    {},
		"strict":     {Strict: true},
		"prefixOnly": {PrefixOnly: true},
		"base64Only": {Base64Only: true},
	}

	results := make([]result, 0, len(samples))
	for _, s := range samples {
		r := result{
			Name:        s.name,
			Signature:   s.sig,
			Detected:    map[string]string{},
			Decisions:   map[string]any{},
			ClaudeValid: map[string]bool{},
			Normalized:  map[string]any{},
			Compatible:  map[string]any{},
		}
		for _, kind := range kinds {
			r.Detected[string(kind)] = string(signature.DetectSignatureProviderForBlock(s.sig, kind))
			for _, target := range targets {
				d := signature.DecideSignatureCompatibility(target, s.sig, kind)
				r.Decisions[string(target)+"/"+string(kind)] = decision{
					Compatible: d.Compatible,
					Action:     string(d.Action),
					Detected:   string(d.DetectedProvider),
					Normalized: d.NormalizedSignature,
					Replace:    d.ReplacementSignature,
				}
			}
		}
		for name, opts := range optionSets {
			r.ClaudeValid[name] = signature.IsValidClaudeThinkingSignature(s.sig, opts)
			normalized, err := signature.NormalizeClaudeThinkingSignature(s.sig, opts)
			if err != nil {
				r.Normalized[name] = nil
			} else {
				r.Normalized[name] = normalized
			}
			native, errNative := signature.NormalizeClaudeProviderNativeThinkingSignature(s.sig, opts)
			if errNative != nil {
				r.Normalized[name+"Native"] = nil
			} else {
				r.Normalized[name+"Native"] = native
			}
		}
		if normalized, ok := signature.CompatibleAntigravityClaudeThinkingSignature(s.sig); ok {
			r.AntigravityTag = normalized
		}
		for _, provider := range []signature.SignatureProvider{signature.SignatureProviderClaude, signature.SignatureProviderGemini, signature.SignatureProviderGPT} {
			if normalized, ok := signature.CompatibleSignatureForProvider(provider, s.sig); ok {
				r.Compatible[string(provider)] = normalized
			} else {
				r.Compatible[string(provider)] = nil
			}
		}
		results = append(results, r)
	}

	models := []string{"claude-sonnet-4-5", "Claude-Opus-4", "gemini-3-pro-high", "gemini-3-flash", "gpt-5", "gpt-oss-120b-medium",
		"o3-mini", "kimi-k2", "moonshot-v1", "k2-thinking", "grok-4", "swe-1.6", "swe-1", "some-model", " Claude ", "o4", "my-openai-x", "codex-mini"}
	modelProviders := map[string]string{}
	for _, m := range models {
		modelProviders[m] = string(signature.SignatureProviderFromModelName(m))
	}

	encoded, err := json.MarshalIndent(map[string]any{"samples": results, "modelProviders": modelProviders}, "", " ")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if err = os.WriteFile(*out, append(encoded, '\n'), 0o644); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	fmt.Printf("wrote %d signature samples to %s\n", len(results), *out)
}
