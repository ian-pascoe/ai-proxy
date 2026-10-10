package main

import (
	"math/rand"
	"strings"
)

// textCorpus returns the strings counted with every encoding. It mixes hand-written edge cases (contractions,
// whitespace classes that differ between regex engines, special-token look-alikes, CJK, emoji, combining marks,
// very long pieces) with seeded pseudo-random mixtures.
func textCorpus() []string {
	texts := []string{
		"",
		" ",
		"\n",
		"hello world",
		"Hello, World!",
		"The quick brown fox jumps over the lazy dog.\nPack my box with five dozen liquor jugs.",
		"don't I've she'll WE'RE I'M you'D it'S THEY'LL we'Ve",
		"it\u017f ca'\u017f 'ſ 'S 'T 'RE 'Ve 'LL 'D 'x",
		"1234567890 3.14159 1,000,000 0x1F 1e-9 007 12345678901234567890",
		"func main() {\n\tfmt.Println(\"hello\")\n\tfor i := 0; i < 10; i++ {\n\t\tx += i * 2\n\t}\n}\n",
		"{\"name\":\"get_weather\",\"parameters\":{\"type\":\"object\",\"properties\":{\"city\":{\"type\":\"string\"}},\"required\":[\"city\"]}}",
		"# Title\n\n* item one\n* item two\n\n```python\nprint('hi')\n```\n\n> quote\n",
		"https://example.com/path/to/page?query=1&other=%E4%BD%A0%E5%A5%BD#fragment",
		"camelCaseWordsHTTPServerXMLParser snake_case_words kebab-case-words PascalCaseWord ALLCAPS lowercase",
		"你好，世界！这是一个测试。今天天气很好，我们去公园玩吧。",
		"こんにちは世界。これはテストです。カタカナとひらがなと漢字。",
		"안녕하세요 세계! 이것은 테스트입니다.",
		"Привет, мир! Это тест. Ёжик в тумане.",
		"مرحبا بالعالم! هذا اختبار.",
		"שלום עולם! זהו מבחן.",
		"สวัสดีชาวโลก นี่คือการทดสอบ",
		"नमस्ते दुनिया! यह एक परीक्षण है।",
		"😀 😃 😄 👨‍👩‍👧‍👦 🏳️‍🌈 🇺🇸 👍🏽 ❤️",
		"e\u0301 a\u0308 o\u0302\u0323 n\u0303 ñ ü é ß ǅ ǈ Ǆ",
		"a  b   c    d",
		"a \n b \n\n c \r\n d \r\n\r\n e",
		"\t\tindent\n\t    mixed",
		"trailing spaces   \nnext line   ",
		"leading\n\n\n\nmany newlines\n\n",
		"x\u0085y z\u0085\u0085 w",
		"\ufeffBOM at start and \ufeff inside",
		"nbsp\u00a0here and\u00a0\u00a0there",
		"line\u2028separator\u2029paragraph",
		"zero\u200bwidth\u200cjoiners\u200dhere",
		"mongolian\u180evowel and ogham\u1680space and ideographic\u3000space",
		"em\u2003space en\u2002space thin\u2009space narrow\u202fnbsp medium\u205fmath",
		"vertical\u000btab and form\u000cfeed",
		"ctrl\x00\x01\x02\x1f\x7f chars",
		"x\x7fy", "!!\x7f!!", "\x7fabc", " \x7f ", "a\x7f\x7fb", "\n\x7f\n", "\x7f\u0301", "\x7f", "ab \x7f\x7f cd\x7f", "\t\x7f\t", "$\x7f$ \x7f.\x7f",
		"<|endoftext|>",
		"before<|endoftext|>after <|endofprompt|> <|fim_prefix|> <|fim_middle|> <|fim_suffix|> <|im_start|>user<|im_end|>",
		"<|endoftext|><|endoftext|><|endoftext|>",
		"!!!??? ... --- *** ((( ))) [[[ ]]] {{{ }}} @@@ ### $$$ %%% ^^^ &&& +++ === ~~~ ``` ''' \"\"\"",
		"a/b\\c|d:e;f,g.h?i!j\nk\r\nl/\n/\r/",
		"   ", "\n\n\n", " \n ", "\r", "\r\n", "\t",
		strings.Repeat("a", 1000),
		strings.Repeat("a", 6000),
		strings.Repeat("ab", 700),
		strings.Repeat("the cat sat on the mat. ", 300),
		strings.Repeat("你好世界", 800),
		strings.Repeat("\n", 300),
		strings.Repeat(" ", 500),
		strings.Repeat(" a", 500),
		strings.Repeat("0123456789", 100),
		strings.Repeat("😀", 400),
		strings.Repeat("ZZZ", 600),
		strings.Repeat("Hello ", 50) + strings.Repeat("\u00e9", 500),
	}

	rng := rand.New(rand.NewSource(25))
	words := []string{
		"the", "of", "and", "token", "Tokenizer", "BPE", "proxy", "Cloudflare", "Worker", "function", "return",
		"don't", "I'm", "they're", "X", "x", "A", "Z", "über", "naïve", "façade", "日本語", "中文", "한국어", "кириллица",
		"123", "4567", "89", "3.14", "-", "--", "->", "=>", "::", "//", "/*", "*/", "{", "}", "(", ")", "[", "]", ";", ",", ".",
		"\n", "\n\n", "\r\n", "\t", "  ", "   ", "😀", "👍", "\u0301", "\u00a0", "\u2003", "_", "__init__", "snake_case", "camelCase",
		"https://example.com/a?b=c", "0xDEADBEEF", "<tag attr=\"v\">", "</tag>", "\"quoted\"", "'single'", "`code`",
	}
	for i := 0; i < 80; i++ {
		var b strings.Builder
		n := 3 + rng.Intn(40+i*10)
		for j := 0; j < n; j++ {
			b.WriteString(words[rng.Intn(len(words))])
			if rng.Intn(4) != 0 {
				b.WriteByte(' ')
			}
		}
		texts = append(texts, b.String())
	}

	// Random printable ASCII and random unicode runes (no surrogates, no private use).
	for i := 0; i < 20; i++ {
		n := 20 + rng.Intn(400)
		var b strings.Builder
		for j := 0; j < n; j++ {
			b.WriteByte(byte(32 + rng.Intn(95)))
		}
		texts = append(texts, b.String())
	}
	for i := 0; i < 20; i++ {
		n := 10 + rng.Intn(200)
		var b strings.Builder
		for j := 0; j < n; j++ {
			var r rune
			switch rng.Intn(5) {
			case 0:
				r = rune(0x20 + rng.Intn(0x5f))
			case 1:
				r = rune(0xa0 + rng.Intn(0x500))
			case 2:
				r = rune(0x2000 + rng.Intn(0x100))
			case 3:
				r = rune(0x4e00 + rng.Intn(0x500))
			default:
				r = rune(0x1f300 + rng.Intn(0x200))
			}
			b.WriteRune(r)
		}
		texts = append(texts, b.String())
	}

	// Dense mixtures of whitespace classes, newlines, symbols, apostrophes, marks and DEL: these exercise the
	// pre-tokenisation regex alternatives (and the places where regex engines disagree).
	atoms := []string{
		" ", " ", "  ", "\n", "\n", "\r", "\r\n", "\t", "\u00a0", "\u2028", "\u0085", "\u000b", "\u000c", "\u3000", "\ufeff", "\u200b",
		"a", "B", "z", "Q", "1", "22", "333", "4444", "!", "?", ".", ",", "/", "'", "s", "re", "ll", "'s", "'LL", "-", "_", "\u007f", "\u0301",
		"\u00e9", "\u4e2d", "\u0e01", "\U0001f600", "\u0000", "\u001f", "$", "#", "\\", "\"",
	}
	for i := 0; i < 200; i++ {
		n := 2 + rng.Intn(30)
		var b strings.Builder
		for j := 0; j < n; j++ {
			b.WriteString(atoms[rng.Intn(len(atoms))])
		}
		texts = append(texts, b.String())
	}
	return texts
}

// modelNames covers every prefix branch of helps.TokenizerForModel and the Codex variant.
func modelNames() []string {
	return []string{
		"", "  ", "gpt-5", "gpt-5.4", "GPT-5-mini", "gpt-5.1-codex", "gpt-4.1", "gpt-4.1-mini", "gpt-4o", "gpt-4o-mini", "GPT-4O",
		"gpt-4", "gpt-4-turbo", "gpt-4-32k", "gpt-3.5-turbo", "gpt-3.5", "gpt-3", "gpt-35-turbo", "o1", "o1-mini", "o1-preview",
		"o3", "o3-mini", "o4-mini", "o4", "claude-sonnet-4", "grok-4", "qwen3-coder", "deepseek-chat", "text-davinci-003",
		"gpt-oss-120b", "gemini-2.5-pro", "  gpt-4o  ", "gpt-image-1", "o2",
	}
}
