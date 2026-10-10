/**
 * The BPE encodings used by the Go token counters and the model -> encoding mappings.
 *
 * Go source: tokenizer@v0.8.1/codec/{o200k_base,cl100k_base}.go (pre-tokenisation regexes, translated to JavaScript:
 * `(?i:...)` contractions are spelled out and Go's `\s` (`unicode.IsSpace`) is written as an explicit class),
 * internal/runtime/executor/helps/token_helpers.go (`TokenizerForModel`) and codex_executor_tokens.go
 * (`tokenizerForCodexModel`). The rank assets are generated from the Go vocabularies by
 * `go run ./tools/fixturegen/tokens`.
 */
import { BpeCodec } from "./bpe.ts"
import cl100kRanks from "./ranks/cl100k_base.bin"
import o200kRanks from "./ranks/o200k_base.bin"
import { GO_SPACE_CLASS, GO_SPACE_NO_NEWLINE_CLASS, goTrimSpace } from "./text.ts"

export type EncodingName = "o200k_base" | "cl100k_base"

const S = GO_SPACE_CLASS

// Go's generated matcher behaves as if `\s*[\r\n]+` were lazy: the piece ends at the first newline run, so " \n \n" is two pieces.
const LEADING_SPACE = GO_SPACE_NO_NEWLINE_CLASS

// Go's generated matcher (regexp2cg) never matches U+007F: DEL is not part of any negated class, so it is dropped.
const DEL = "\\u007f"

const CONTRACTION = "'[sS\u017f]|'[tT]|'[rR][eE]|'[vV][eE]|'[mM]|'[lL][lL]|'[dD]"

const O200K_PATTERN = [
  `[^\\r\\n\\p{L}\\p{N}${DEL}]?[\\p{Lu}\\p{Lt}\\p{Lm}\\p{Lo}\\p{M}]*[\\p{Ll}\\p{Lm}\\p{Lo}\\p{M}]+(?:${CONTRACTION})?`,
  `[^\\r\\n\\p{L}\\p{N}${DEL}]?[\\p{Lu}\\p{Lt}\\p{Lm}\\p{Lo}\\p{M}]+[\\p{Ll}\\p{Lm}\\p{Lo}\\p{M}]*(?:${CONTRACTION})?`,
  `\\p{N}{1,3}`,
  ` ?[^${S}\\p{L}\\p{N}${DEL}]+[\\r\\n/]*`,
  `[${LEADING_SPACE}]*[\\r\\n]+`,
  `[${S}]+(?![^${S}])`,
  `[${S}]+`
].join("|")

const CL100K_PATTERN = [
  `(?:${CONTRACTION})`,
  `[^\\r\\n\\p{L}\\p{N}${DEL}]?\\p{L}+`,
  `\\p{N}{1,3}`,
  ` ?[^${S}\\p{L}\\p{N}${DEL}]+[\\r\\n]*`,
  `[${LEADING_SPACE}]*[\\r\\n]+`,
  `[${S}]+(?![^${S}])`,
  `[${S}]+`
].join("|")

const codecs = new Map<EncodingName, BpeCodec>()

/** The codec of an encoding. Creating it is cheap; its vocabulary is parsed on the first `count`. */
export const getCodec = (name: EncodingName): BpeCodec => {
  let codec = codecs.get(name)

  if (codec === undefined) {
    codec =
      name === "o200k_base"
        ? new BpeCodec(name, o200kRanks, new RegExp(O200K_PATTERN, "u"))
        : new BpeCodec(name, cl100kRanks, new RegExp(CL100K_PATTERN, "u"))
    codecs.set(name, codec)
  }

  return codec
}

/** `helps.TokenizerForModel` (OpenAI-compatibility counting). */
export const encodingForModel = (model: string): EncodingName => {
  const m = goTrimSpace(model).toLowerCase()

  if (m === "") return "cl100k_base"

  if (m.startsWith("gpt-5") || m.startsWith("gpt-4.1") || m.startsWith("gpt-4o")) return "o200k_base"

  if (m.startsWith("gpt-4") || m.startsWith("gpt-3")) return "cl100k_base"

  if (m.startsWith("o1") || m.startsWith("o3") || m.startsWith("o4")) return "o200k_base"

  return "o200k_base"
}

/** `tokenizerForCodexModel` (Codex counting; unknown models use `cl100k_base`). */
export const encodingForCodexModel = (model: string): EncodingName => {
  const m = goTrimSpace(model).toLowerCase()

  if (m.startsWith("gpt-5") || m.startsWith("gpt-4.1") || m.startsWith("gpt-4o")) return "o200k_base"

  return "cl100k_base"
}
