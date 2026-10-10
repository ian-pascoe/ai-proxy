package main

import (
	"strconv"

	"github.com/router-for-me/CLIProxyAPI/v8/internal/registry"
)

func itoa(n int) string { return strconv.Itoa(n) }

func lookupStatic(id string) *modelSpec {
	info := registry.LookupStaticModelInfo(id)
	if info == nil {
		return nil
	}
	return specFromInfo(info)
}
