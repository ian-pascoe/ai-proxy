// Command jsonpath emits golden fixtures for the TypeScript gjson/sjson path engine (src/json).
//
// Every case is executed against the real tidwall/gjson and tidwall/sjson versions used by the Go server, so the
// TypeScript tests can verify behavioural parity. Run from the repository root:
//
//	go run ./tools/fixturegen/jsonpath
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"

	"github.com/tidwall/gjson"
	"github.com/tidwall/sjson"
)

type getCase struct {
	JSON   string  `json:"json"`
	Path   string  `json:"path"`
	Exists bool    `json:"exists"`
	Raw    string  `json:"raw,omitempty"`
	String string  `json:"string"`
	Int    int64   `json:"int"`
	Float  float64 `json:"float"`
	Bool   bool    `json:"bool"`
}

type setCase struct {
	JSON  string          `json:"json"`
	Path  string          `json:"path"`
	Kind  string          `json:"kind"` // value | raw | delete
	Value json.RawMessage `json:"value,omitempty"`
	Out   string          `json:"out,omitempty"`
	Error bool            `json:"error,omitempty"`
}

type fixtures struct {
	Get []getCase `json:"get"`
	Set []setCase `json:"set"`
}

const friendsDoc = `{"name":{"first":"Tom","last":"Anderson"},"age":37,"children":["Sara","Alex","Jack"],"fav.movie":"Deer Hunter","friends":[{"first":"Dale","last":"Murphy","age":44,"nets":["ig","fb","tw"]},{"first":"Roger","last":"Craig","age":68,"nets":["fb","tw"]},{"first":"Jane","last":"Murphy","age":47,"nets":["ig","tw"]}]}`

const chatDoc = `{"model":"gpt-5","messages":[{"role":"system","content":"be nice"},{"role":"user","content":[{"type":"text","text":"hi"},{"type":"image_url","image_url":{"url":"x"}}]},{"role":"assistant","content":null,"tool_calls":[{"id":"call_1","type":"function","function":{"name":"f","arguments":"{}"}}]},{"role":"tool","tool_call_id":"call_1","content":"ok"}],"tools":[{"type":"function","name":"exec","description":"d"},{"type":"x_search"},{"type":"function","name":"apply_patch"}],"stream":true,"temperature":0.5,"max_tokens":100,"flag":false,"nothing":null}`

const respDoc = `{"input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"a"}]},{"type":"additional_tools","tools":[{"type":"x_search"},{"type":"function","name":"q"}]},{"type":"reasoning","id":"rs_1","summary":[]},{"type":"additional_tools","tools":[{"type":"function","name":"z"}]},{"type":"function_call_output","call_id":"call_dropped","output":"x"}],"tools":[{"type":"image_generation"},{"type":"function","name":"wait"}]}`

const geminiDoc = `{"request":{"contents":[{"role":"user","parts":[{"text":"hello","thought":true},{"text":"b","thought":false}]},{"role":"model","parts":[{"functionCall":{"name":"lookup"},"thoughtSignature":"sig"},{"thought":true,"text":"t"}]}],"tools":[{"googleSearch":{}},{"functionDeclarations":[{"name":"lookup"},{"name":"other"}]}]},"systemInstruction":{"parts":[{"text":"x-anthropic-billing-header: abc"},{"text":"real"}]},"generationConfig":{"temperature":1}}`

const miscDoc = `{"a.b":1,"a":{"b":{"c":[1,2,3]},"*":"star","?":"q"},"arr":[[1,2],[3,[4,5]],[]],"nums":[1,5,10,15],"flags":[true,false,true],"strs":["apple","banana","cherry"],"obj":{"x":1,"y":2,"z":3},"e":"","big":12345678901,"neg":-4.5,"s":"he said \"hi\"","w":{"1":"one","two":2},"u":"héllo"}`

var getDocs = map[string][]string{
	friendsDoc: {
		"name.last", "age", "children", "children.#", "children.1", "children.5", "child*.2", "c?ildren.0", `fav\.movie`,
		"friends.#", "friends.#.first", "friends.1.last", "friends.1.nets.#", "friends.#.nets.0", "friends.#.nope", "friends.#.nets.#",
		`friends.#(last=="Murphy").first`, `friends.#(last=="Murphy")#.first`, `friends.#(last=="Murphy")#`,
		"friends.#(age>45)#.last", "friends.#(age>=47).first", "friends.#(age<45)#.first", "friends.#(age<=44).first", "friends.#(age!=44)#.first",
		`friends.#(first%"D*").last`, `friends.#(first!%"D*")#.last`, `friends.#(first%"?o*")#.first`,
		`friends.#(nets.#(=="fb"))#.first`, `friends.#(nets.#(=="fb")).first`, `friends.#(last=="Nobody")`, `friends.#(last=="Nobody")#`, `friends.#(last=="Nobody").first`,
		`friends.#(first)#.first`, `friends.#(nope)`, `friends.#(age)#`,
		"@this", "@reverse", "children.@reverse", "name.@keys", "name.@values", "friends.#.first|@reverse", "@keys", "children|1", "children|#", "friends|0|first",
		"friends.#.first|1", `friends.#(last=="Murphy")#|1`, `friends.#(last=="Murphy")#|#`, `friends.#(last=="Murphy")#.first|0`,
		"name.*", "n*.last", "name.l?st", "nam?.first", "", ".", "name.", "nope", "name.nope.x", "age.x", "children.x", "children.-1", "children.01", "friends.0.nets.2",
		"@flatten", `@this|name`, `name|@this|last`, "children.#.x", "friends.#(age>40)#.nets.#(==\"ig\")",
	},
	chatDoc: {
		"model", "messages.#", "messages.0.role", "messages.#.role", "messages.#.content",
		`messages.#(role=="user").content`, `messages.#(role=="user").content.0.text`, `messages.#(role=="system").content`, `messages.#(role=="tool").tool_call_id`,
		`messages.#(role=="assistant").tool_calls.0.function.arguments`, `messages.#(role=="assistant").tool_calls.0.id`, `messages.#(role=="assistant").content`,
		`messages.#(role=="user")#`, `messages.#(role!="user")#.role`, `messages.1.content.#(type==image_url).image_url.url`, `messages.1.content.#(type=image_url)`,
		`messages.1.content.#(type=="text")#.text`, "messages.1.content.#.type", `tools.#(type=="x_search")`, `tools.#(name=="apply_patch")`, `tools.#(name=="exec").description`,
		`tools.#(type=="function")#.name`, "tools.#(x_search)", "tools.#.name", "tools.#(name)#.name", `tools.#(name=="nope")`,
		"stream", "temperature", "max_tokens", "flag", "nothing", "nothing.x", `tools.#(~true)`, "tools.#(name%\"*_patch\")",
		"stream.x", "messages.2.tool_calls.#", "messages.2.tool_calls.0.function.name", "tools.2", "tools.3", "messages.3.content",
		"temperature|@this", `messages.#(role=="user").content.#`, `messages.#(content=="ok")`, `messages.#(role=="tool")#.content`,
		`messages.#(content==null)`, `messages.#(content~null)`, `tools.#(name=="exec")#`,
	},
	respDoc: {
		`input.#(type=="additional_tools")#`, `input.#(type=="additional_tools")#.tools`, `input.#(type=="additional_tools")#.tools.#(type=="x_search")`,
		`input.#(type=="additional_tools")#.tools.#(name=="z")`, `input.#(type=="reasoning")`, `input.#(call_id=="call_dropped")`, "input.#.id",
		`input.#(type=="message").content.0.text`, "input.0.content.#", `input.0.content.#(type=="input_text")`, `tools.#(type=="image_generation")`, `tools.#(type=="image_generation")#`,
		"input.2.summary.#", "input.2.summary", `input.#(type=="additional_tools").tools.#(name=="q")`, `input.#(type=="additional_tools")#.tools.#.name`,
	},
	geminiDoc: {
		"request.contents.#", `request.contents.#(role=="user")`, `request.contents.#.parts.#(thought=true)#`, `request.contents.#.parts.#(thought==true)#`,
		"request.contents.#.parts.#(thought=false)#", "request.contents.#.parts.#.text", "request.contents.1.parts.0.functionCall.name", "request.contents.0.parts.0.thoughtSignature",
		"request.tools.#(googleSearch)", "request.tools.#(googleSearch)#", `request.tools.#.functionDeclarations.#(name=="lookup")`, `request.tools.#.functionDeclarations.#(name=="lookup")#`,
		`request.tools.#.functionDeclarations.#.name`, `systemInstruction.parts.#(text%"x-anthropic-billing-header:*")`, `systemInstruction.parts.#(text%"x-anthropic-billing-header:*")#`,
		`systemInstruction.parts.#(text!%"x-anthropic-billing-header:*").text`, "generationConfig.temperature", "request.contents.0.parts.#(thought).text",
		"request.contents.#(parts.#(thought==true))", "request.contents.#(parts.#(thought==true))#.role",
	},
	miscDoc: {
		`a\.b`, "a.b", "a.b.c", "a.b.c.#", "a.b.c.2", `a.\*`, `a.\?`, "a.*", "arr.#", "arr.#.#", "arr.1.1.0", "arr.1.1.1", "arr.2.#", "arr.#.0", "arr.#.1",
		"nums.#(>5)", "nums.#(>5)#", "nums.#(>=5)#", "nums.#(<5)", "nums.#(==10)", "nums.#(!=1)#", "nums.#(>100)", "nums.#(>100)#", "flags.#(==true)#", "flags.#(==false)", "flags.#(!=true)#",
		`strs.#(=="banana")`, `strs.#(>"b")#`, `strs.#(%"*an*")`, `strs.#(!%"*an*")#`, `strs.#(=="x")`, "strs.#(<\"b\")",
		"obj.@keys", "obj.@values", "obj.@reverse", "obj.@reverse.@keys", "arr.@flatten", `arr.@flatten:{"deep":true}`, "nums.@reverse|0",
		"e", "big", "neg", "s", "w.1", "w.two", "w.#", "u", "obj.#", "obj.x", "obj.*", "o?j.y", "ob*.z", "nums.1", "nums.-1", "nums.4", "nums.#.x", "nums|@reverse", "obj|@keys",
		`nums.#(>=5)#|#`, `flags.#(~true)#`, `strs.#(~*)#`, `nums.#(~false)#`, `nums.#(>5)#.x`,
	},
}

type setSpec struct {
	json  string
	path  string
	kind  string
	value string // JSON text for kind value/raw
}

// Complex set paths (#, |, *, ?, @) are intentionally absent: sjson rewrites existing matches there, the
// TypeScript port rejects them (see src/json/set.ts).
var setSpecs = []setSpec{
	{`{"a":1}`, "a", "value", `2`},
	{`{"a":1}`, "b", "value", `"x"`},
	{`{"a":1}`, "b.c.d", "value", `true`},
	{`{"a":1}`, "b.0", "value", `"x"`},
	{`{"a":1}`, "b.2", "value", `"x"`},
	{`{"a":1}`, "b.-1", "value", `"x"`},
	{`{"a":1}`, "b.-1.c", "value", `1`},
	{`{"a":1}`, "b.1.c.0", "value", `1`},
	{`{"a":{"b":"str"}}`, "a.b.c", "value", `1`},
	{`{"a":"str"}`, "a.0", "value", `1`},
	{`{"a":[1,2]}`, "a.0", "value", `9`},
	{`{"a":[1,2]}`, "a.1", "value", `9`},
	{`{"a":[1,2]}`, "a.2", "value", `9`},
	{`{"a":[1,2]}`, "a.4", "value", `9`},
	{`{"a":[1,2]}`, "a.-1", "value", `9`},
	{`{"a":[1,2]}`, "a.-1.x", "value", `9`},
	{`{"a":[1,2]}`, "a.x", "value", `9`},
	{`{"a":[1,2]}`, "a.:0", "value", `9`},
	{`{"a":[1,2]}`, "a.:x", "value", `9`},
	{`{"a":{"0":1}}`, "a.0", "value", `9`},
	{`{"a":{}}`, "a.0", "value", `9`},
	{`{"a":{}}`, "a.-1", "value", `9`},
	{`{"a":{}}`, "a.:0", "value", `9`},
	{`{"a":{}}`, `a.b\.c`, "value", `9`},
	{`{"a":{}}`, `a.b\\.c`, "value", `9`},
	{`{"a":[{"b":1},{"b":2}]}`, "a.1.b", "value", `3`},
	{`{"a":[{"b":1},{"b":2}]}`, "a.1.c", "value", `3`},
	{`{"a":[{"b":1},{"b":2}]}`, "a.2.c", "value", `3`},
	{`{"a":[{"b":1},{"b":2}]}`, "a.0", "value", `{"z":1}`},
	{`{"a":[{"b":1},{"b":2}]}`, "a.0", "value", `[1,2]`},
	{`{"a":1}`, "a", "value", `null`},
	{`{"a":1}`, "a", "value", `{"nested":{"k":[1,2,{"x":null}]}}`},
	{`{"a":1}`, "a", "value", `"he said \"hi\" <b>&"`},
	{`{"a":1}`, "a", "value", `1.5`},
	{`{"a":1}`, "a", "value", `false`},
	{`{}`, "a", "value", `1`},
	{``, "a", "value", `1`},
	{``, "0", "value", `1`},
	{``, "2", "value", `1`},
	{``, "-1", "value", `1`},
	{``, "a.b", "value", `1`},
	{``, "a.0.b", "value", `1`},
	{`[]`, "0", "value", `1`},
	{`[]`, "-1", "value", `1`},
	{`[]`, "a", "value", `1`},
	{`[1]`, "0", "value", `2`},
	{`[1]`, "3", "value", `2`},
	{`[1]`, "-1", "value", `2`},
	{`[1]`, "-1.a", "value", `2`},
	{`[[1],[2]]`, "1.-1", "value", `3`},
	{`"str"`, "a", "value", `1`},
	{`"str"`, "0", "value", `1`},
	{`5`, "a.b", "value", `1`},
	{`{"a":1,"b":2,"c":3}`, "b", "value", `"two"`},
	{`{"z":1,"a":2}`, "m", "value", `1`},
	{`{"a":1}`, "", "value", `1`},
	{`{"a":1}`, "a.", "value", `1`},
	{`{"a":1}`, ".a", "value", `1`},
	{`{"a":1}`, `\*`, "value", `1`},
	{`{"a":1}`, `\#`, "value", `1`},
	{`{"a":1}`, `a.\@x`, "value", `1`},
	{`{"a":1}`, "a.:b", "value", `1`},
	{`{"a":1}`, ":a", "value", `2`},
	{`{"a":1}`, "é.ü", "value", `1`},

	{`{"a":1}`, "a", "raw", `{"x":1.5}`},
	{`{"a":1}`, "b.-1", "raw", `[1,2]`},
	{`{"a":[1]}`, "a.-1", "raw", `"s"`},
	{`{"a":[1]}`, "a.-1", "raw", `{"type":"text","text":"hello"}`},
	{`{"a":1}`, "a", "raw", `null`},

	{`{"a":1,"b":2}`, "a", "delete", ``},
	{`{"a":1,"b":2}`, "b", "delete", ``},
	{`{"a":1,"b":2}`, "c", "delete", ``},
	{`{"a":1}`, "a", "delete", ``},
	{`{"a":[1,2,3]}`, "a.0", "delete", ``},
	{`{"a":[1,2,3]}`, "a.1", "delete", ``},
	{`{"a":[1,2,3]}`, "a.2", "delete", ``},
	{`{"a":[1,2,3]}`, "a.3", "delete", ``},
	{`{"a":[1,2,3]}`, "a.-1", "delete", ``},
	{`{"a":[]}`, "a.-1", "delete", ``},
	{`{"a":{"-1":1,"b":2}}`, "a.-1", "delete", ``},
	{`{"a":[{"b":1,"c":2}]}`, "a.0.b", "delete", ``},
	{`{"a":[{"b":1,"c":2}]}`, "a.0.x", "delete", ``},
	{`{"a":[{"b":1,"c":2}]}`, "a.1.b", "delete", ``},
	{`{"a":"str"}`, "a.b", "delete", ``},
	{`{"a":{"b.c":1}}`, `a.b\.c`, "delete", ``},
	{`[1,2,3]`, "1", "delete", ``},
	{`[1,2,3]`, "-1", "delete", ``},
	{`{"a":1}`, "a.#", "delete", ``},
	{`{"a":[1,2]}`, "a.#(>1)", "delete", ``},
	{`{"a":1}`, "", "delete", ``},
	{`{"a":1}`, "nope.deeper", "delete", ``},
	{`{"a":null,"b":1}`, "a", "delete", ``},
}

func runGet(doc, path string) getCase {
	res := gjson.Get(doc, path)
	return getCase{JSON: doc, Path: path, Exists: res.Exists(), Raw: res.Raw, String: res.String(), Int: res.Int(), Float: res.Float(), Bool: res.Bool()}
}

func runSet(spec setSpec) setCase {
	c := setCase{JSON: spec.json, Path: spec.path, Kind: spec.kind}
	if spec.value != "" {
		c.Value = json.RawMessage(spec.value)
	}
	var (
		out []byte
		err error
	)
	switch spec.kind {
	case "value":
		var v any
		if errUnmarshal := json.Unmarshal([]byte(spec.value), &v); errUnmarshal != nil {
			panic(errUnmarshal)
		}
		out, err = sjson.SetBytes([]byte(spec.json), spec.path, v)
	case "raw":
		out, err = sjson.SetRawBytes([]byte(spec.json), spec.path, []byte(spec.value))
	case "delete":
		out, err = sjson.DeleteBytes([]byte(spec.json), spec.path)
	}
	if err != nil {
		c.Error = true
		return c
	}
	c.Out = string(out)
	if !gjson.Valid(c.Out) {
		// Invalid output can only happen for inputs sjson cannot handle; the TypeScript port reports an error.
		c.Error = true
		c.Out = ""
	}
	return c
}

func main() {
	outPath := flag.String("out", "test/fixtures/json-path.json", "output file")
	flag.Parse()

	var fx fixtures
	docs := []string{friendsDoc, chatDoc, respDoc, geminiDoc, miscDoc}
	for _, doc := range docs {
		for _, path := range getDocs[doc] {
			fx.Get = append(fx.Get, runGet(doc, path))
		}
	}
	for _, spec := range setSpecs {
		fx.Set = append(fx.Set, runSet(spec))
	}

	data, err := json.MarshalIndent(fx, "", " ")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if err = os.MkdirAll(filepath.Dir(*outPath), 0o755); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if err = os.WriteFile(*outPath, append(data, '\n'), 0o644); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	fmt.Printf("wrote %d get and %d set cases to %s\n", len(fx.Get), len(fx.Set), *outPath)
}
