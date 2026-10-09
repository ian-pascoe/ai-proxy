// Command devinstatus emits golden fixtures for the TypeScript Devin `GetUserStatus` refresh
// (workers/src/credentials/devin-status.ts, workers/src/oauth/flows/devin-status.ts). The real Go
// DevinExecutor.Refresh runs against a local Connect-RPC stub serving scripted protobuf answers; the resulting metadata,
// attributes and quota signals are recorded. Run from the repository root:
//
//	go run ./workers/tools/fixturegen/devinstatus
package main

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"

	"github.com/router-for-me/CLIProxyAPI/v8/internal/auth/devin"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/config"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/runtime/executor"
	cliproxyauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	"google.golang.org/protobuf/encoding/protowire"
)

type msg struct{ b []byte }

func (m *msg) str(num protowire.Number, v string) *msg {
	m.b = protowire.AppendTag(m.b, num, protowire.BytesType)
	m.b = protowire.AppendString(m.b, v)
	return m
}

func (m *msg) sub(num protowire.Number, v *msg) *msg {
	m.b = protowire.AppendTag(m.b, num, protowire.BytesType)
	m.b = protowire.AppendBytes(m.b, v.b)
	return m
}

func (m *msg) varint(num protowire.Number, v uint64) *msg {
	m.b = protowire.AppendTag(m.b, num, protowire.VarintType)
	m.b = protowire.AppendVarint(m.b, v)
	return m
}

func (m *msg) fixed32(num protowire.Number, v uint32) *msg {
	m.b = protowire.AppendTag(m.b, num, protowire.Fixed32Type)
	m.b = protowire.AppendFixed32(m.b, v)
	return m
}

type scenario struct {
	Name       string         `json:"name"`
	Seed       string         `json:"seed,omitempty"`
	Response   string         `json:"response"`
	Status     int            `json:"httpStatus"`
	Metadata   map[string]any `json:"metadata"`
	Attributes map[string]any `json:"attributes"`
	Signals    map[string]any `json:"signals,omitempty"`
	Error      bool           `json:"error"`
	Request    string         `json:"requestHex,omitempty"`
}

func fullStatus() []byte {
	org := (&msg{}).str(4, "org_1").str(8, "Acme Inc")
	planInfo := (&msg{}).str(2, "Pro").sub(33, org)
	start := (&msg{}).varint(1, 1700000000)
	end := (&msg{}).varint(1, 1702592000)
	plan := (&msg{}).sub(1, planInfo).sub(2, start).sub(3, end).
		varint(14, 87).varint(15, 42).varint(17, 1700086400).varint(18, 1700604800)
	user := (&msg{}).str(3, "ada").str(5, "team_9").str(7, "ada@example.com").sub(13, plan).str(36, "user_7").fixed32(40, 7)
	return (&msg{}).sub(1, user).b
}

func partialStatus() []byte {
	planInfo := (&msg{}).str(2, "Free")
	plan := (&msg{}).sub(1, planInfo).varint(14, 100).varint(17, 0)
	user := (&msg{}).str(7, "free@example.com").sub(13, plan)
	return (&msg{}).sub(1, user).b
}

func run(name string, seed string, status int, body []byte) scenario {
	var request []byte
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		request, _ = io.ReadAll(r.Body)
		w.WriteHeader(status)
		_, _ = w.Write(body)
	}))
	defer server.Close()
	exec := executor.NewDevinExecutor(&config.Config{})
	auth := &cliproxyauth.Auth{
		ID:       "devin-1",
		Provider: "devin",
		Attributes: map[string]string{
			"api_key":     "devin-session-token$abc",
			"base_url":    server.URL,
			"device_seed": seed,
			"keep":        "yes",
		},
		Metadata: map[string]any{"api_key": "devin-session-token$abc", "old": "kept"},
	}
	updated, err := exec.Refresh(context.Background(), auth)
	result := scenario{Name: name, Seed: seed, Response: hex.EncodeToString(body), Status: status, Error: err != nil}
	if updated != nil {
		result.Metadata = map[string]any{}
		for key, value := range updated.Metadata {
			result.Metadata[key] = value
		}
		result.Attributes = map[string]any{}
		for key, value := range updated.Attributes {
			result.Attributes[key] = value
		}
		if err == nil {
			result.Signals = map[string]any{}
			for key, value := range updated.Quota.Signals {
				result.Signals[key] = value
			}
		}
	}
	result.Request = hex.EncodeToString(request)
	return result
}

func main() {
	outPath := flag.String("out", "workers/test/fixtures/devin-status.json", "output file")
	flag.Parse()
	deterministic := hex.EncodeToString(devin.BuildGetUserStatusRequest("devin-session-token$abc", devin.GenerateDeviceFingerprint("seed-1")))
	scenarios := []scenario{
		run("full status", "seed-1", 200, fullStatus()),
		run("partial status keeps missing quota at zero", "seed-1", 200, partialStatus()),
		run("upstream error leaves the credential untouched", "seed-1", 500, []byte("boom")),
		run("empty answer", "seed-1", 200, nil),
	}
	doc := map[string]any{"scenarios": scenarios, "deterministicRequest": deterministic}
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
	fmt.Printf("wrote %s (%d scenarios)\n", *outPath, len(scenarios))
}
