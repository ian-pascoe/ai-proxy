package main

import (
	"github.com/router-for-me/CLIProxyAPI/v8/internal/thinking"
	"github.com/tidwall/gjson"
)

func thinkingText(part string) string {
	return thinking.GetThinkingText(gjson.Parse(part))
}
