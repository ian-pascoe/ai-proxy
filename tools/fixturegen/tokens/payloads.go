package main

// Request payloads per client protocol. Every payload is compact JSON (the TypeScript port counts
// JSON.stringify output where Go counts the raw bytes it was given).

var openAIChatPayloads = []string{
	`{"model":"gpt-4o","messages":[{"role":"user","content":"Hello there, how are you today?"}]}`,
	`{"model":"gpt-4o","messages":[{"role":"system","content":"You are a helpful assistant. Don't be verbose."},{"role":"user","content":"What's the weather in Paris?"},{"role":"assistant","content":null,"tool_calls":[{"id":"call_1","type":"function","function":{"name":"get_weather","arguments":"{\"city\":\"Paris\"}"}}]},{"role":"tool","tool_call_id":"call_1","content":"{\"temp\":21,\"unit\":\"C\"}"},{"role":"assistant","content":"It is 21C in Paris."}],"tools":[{"type":"function","function":{"name":"get_weather","description":"Get the weather for a city","parameters":{"type":"object","properties":{"city":{"type":"string","description":"City name"}},"required":["city"]}}}],"tool_choice":"auto"}`,
	`{"model":"gpt-4o","messages":[{"role":"user","content":[{"type":"text","text":"Describe this image"},{"type":"image_url","image_url":{"url":"https://example.com/cat.png"}},{"type":"text","text":"and be brief"}]}],"response_format":{"type":"json_schema","json_schema":{"name":"answer","schema":{"type":"object","properties":{"text":{"type":"string"}}}}}}`,
	`{"model":"gpt-4o","messages":[{"role":"user","name":"alice","content":"你好，请用中文回答。😀"}],"functions":[{"name":"lookup","description":"Look something up","parameters":{"type":"object","properties":{"q":{"type":"string"}}}}],"tool_choice":{"type":"function","function":{"name":"lookup"}}}`,
	`{"model":"gpt-4o","messages":[{"role":"assistant","content":"calling","function_call":{"name":"lookup","arguments":"{\"q\":\"x\"}"}},{"role":"user","content":[{"type":"input_audio","id":"audio_1"},{"type":"output_text","text":"prior text"}]}],"prompt":"legacy prompt","input":"legacy input"}`,
	`{"model":"gpt-4o","messages":[{"role":"user","content":"   "},{"role":"user","content":"\n"},{"role":"assistant","content":""}]}`,
	`{"model":"gpt-4o","messages":[{"role":"user","content":"short"}],"max_tokens":100,"temperature":0.2,"stream":false}`,
}

var responsesPayloads = []string{
	`{"model":"gpt-5","input":"Say hello in three languages."}`,
	`{"model":"gpt-5","instructions":"You are a terse coding assistant.","input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"List files in the repo."}]},{"type":"function_call","call_id":"c1","name":"shell","arguments":"{\"cmd\":\"ls -la\"}"},{"type":"function_call_output","call_id":"c1","output":"README.md\nmain.go\n"},{"type":"message","role":"assistant","content":[{"type":"output_text","text":"There are two files."}]}],"tools":[{"type":"function","name":"shell","description":"Run a shell command","parameters":{"type":"object","properties":{"cmd":{"type":"string"}},"required":["cmd"]}}],"text":{"format":{"type":"json_schema","name":"files","schema":{"type":"object","properties":{"files":{"type":"array","items":{"type":"string"}}}}}}}`,
	`{"model":"gpt-5","input":[{"type":"reasoning","summary":[{"type":"summary_text","text":"Thinking about the problem."}]},{"type":"message","role":"user","content":[{"type":"input_text","text":"What's next?"},{"type":"input_image","image_url":"https://example.com/a.png"},{"type":"input_file","filename":"notes.txt","file_id":"file_1"}]},{"type":"function_call_output","call_id":"c2","output":{"ok":true,"items":[1,2,3]}}]}`,
	`{"model":"gpt-5","input":[{"type":"message","role":"user","content":"plain string content"},{"text":"loose text"}],"tools":[{"type":"web_search"},{"type":"function","name":"f","parameters":"{\"type\":\"object\"}"}]}`,
	`{"model":"gpt-5","input":"こんにちは\n\n世界 😀","instructions":"  padded instructions  "}`,
}

var claudePayloads = []string{
	`{"model":"claude-sonnet-4","max_tokens":1024,"messages":[{"role":"user","content":"Hello, Claude. How are you doing today?"}]}`,
	`{"model":"claude-sonnet-4","max_tokens":1024,"system":"You are a pirate. Don't break character.","messages":[{"role":"user","content":[{"type":"text","text":"Where is the treasure?"}]},{"role":"assistant","content":[{"type":"thinking","thinking":"I should answer like a pirate.","signature":"sig"},{"type":"text","text":"Arr, 'tis buried!"},{"type":"tool_use","id":"toolu_1","name":"dig","input":{"x":10,"y":20,"where":"beach"}}]},{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1","content":[{"type":"text","text":"Found a chest."},{"type":"image","source":{"type":"base64","media_type":"image/png","data":"AAAA"}}]}]}],"tools":[{"name":"dig","description":"Dig a hole","input_schema":{"type":"object","properties":{"x":{"type":"number"},"y":{"type":"number"},"where":{"type":"string"}},"required":["x","y"]}}],"tool_choice":{"type":"tool","name":"dig"}}`,
	`{"model":"claude-sonnet-4","max_tokens":1024,"system":[{"type":"text","text":"System block one.","cache_control":{"type":"ephemeral"}},{"type":"text","text":"System block two."}],"messages":[{"role":"user","content":[{"type":"document","title":"Doc","context":"ctx","source":{"type":"text","media_type":"text/plain","data":"Document body text."}},{"type":"text","text":"Summarise."}]}],"tool_choice":{"type":"auto"}}`,
	`{"model":"claude-sonnet-4","max_tokens":1024,"messages":[{"role":"user","content":"中文提示：请总结下面的内容。😀"},{"role":"assistant","content":"好的"},{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_9","content":"plain string result"}]}],"tools":[{"type":"custom","name":"c","description":"d","input_schema":{"type":"object"}}],"tool_choice":{"type":"any"}}`,
	`{"model":"claude-sonnet-4","max_tokens":1024,"messages":[{"role":"user","content":[{"type":"web_search_tool_result","tool_use_id":"ws_1","content":[{"type":"web_search_result","title":"Result title","url":"https://example.com/r","page_age":"1 day","encrypted_content":"secret"}]},{"type":"bash_code_execution_tool_result","tool_use_id":"b_1","content":{"type":"bash_code_execution_result","stdout":"out","stderr":"err","return_code":2}},{"type":"tool_result","tool_use_id":"t_1","content":[{"type":"tool_reference","tool_name":"mcp__x__y"}]}]}]}`,
	`{"model":"claude-sonnet-4","max_tokens":10,"messages":[{"role":"user","content":[{"type":"text","text":"   "},{"type":"redacted_thinking","data":"zzz"},{"type":"video","source":{}},{"foo":"bar","n":1}]}],"tool_choice":"auto"}`,
	`{"model":"claude-sonnet-4","max_tokens":10,"system":["bare string system",{"type":"text","text":"typed"}],"messages":[{"role":"user","content":"x"}]}`,
}

var geminiPayloads = []string{
	`{"contents":[{"role":"user","parts":[{"text":"Hello Gemini, tell me a joke."}]}]}`,
	`{"systemInstruction":{"parts":[{"text":"Be funny."}]},"contents":[{"role":"user","parts":[{"text":"What's 2+2?"}]},{"role":"model","parts":[{"functionCall":{"name":"calc","args":{"expr":"2+2"}}}]},{"role":"user","parts":[{"functionResponse":{"name":"calc","response":{"result":4}}}]}],"tools":[{"functionDeclarations":[{"name":"calc","description":"Evaluate arithmetic","parameters":{"type":"object","properties":{"expr":{"type":"string"}},"required":["expr"]}}]}]}`,
}
