// Golden signature decisions generated from the Go internal/signature package by
// `go run ./workers/tools/fixturegen/signature`.
import { describe, expect, it } from "vitest"
import {
  compatibleAntigravityClaudeThinkingSignature,
  isValidClaudeThinkingSignature,
  normalizeClaudeProviderNativeThinkingSignature,
  normalizeClaudeThinkingSignature
} from "../src/signature/claude.ts"
import {
  compatibleSignatureForProvider,
  decideSignatureCompatibility,
  detectSignatureProvider,
  type SignatureBlockKind,
  type SignatureProvider,
  signatureProviderFromModelName
} from "../src/signature/provider.ts"
import fixture from "./fixtures/signature.json"

interface Decision {
  readonly compatible: boolean
  readonly action: string
  readonly detected: string
  readonly normalized: string
  readonly replacement: string
}

const OPTION_SETS = {
  default: {},
  strict: { strict: true },
  prefixOnly: { prefixOnly: true },
  base64Only: { base64Only: true }
} as const

const tryNormalize = (fn: () => string): string | null => {
  try {
    return fn()
  } catch {
    return null
  }
}

describe("signature fixtures (Go internal/signature)", () => {
  for (const sample of fixture.samples) {
    describe(sample.name, () => {
      it("detects the provider for every block kind", () => {
        for (const [kind, expected] of Object.entries(sample.detected)) {
          expect(detectSignatureProvider(sample.signature, kind as SignatureBlockKind), kind).toBe(expected)
        }
      })

      it("decides compatibility for every target and block kind", () => {
        for (const [key, expected] of Object.entries(sample.decisions as Record<string, Decision>)) {
          const [target, kind] = key.split("/") as [SignatureProvider, SignatureBlockKind]
          const decision = decideSignatureCompatibility(target, sample.signature, kind)
          expect(
            {
              compatible: decision.compatible,
              action: decision.action,
              detected: decision.detectedProvider,
              normalized: decision.normalizedSignature,
              replacement: decision.replacementSignature
            },
            key
          ).toEqual(expected)
        }
      })

      it("validates and normalises Claude signatures under every option set", () => {
        for (const [name, options] of Object.entries(OPTION_SETS)) {
          expect(isValidClaudeThinkingSignature(sample.signature, options), name).toBe(
            (sample.claudeValid as Record<string, boolean>)[name]
          )
          const normalized = sample.normalized as Record<string, string | null>
          expect(
            tryNormalize(() => normalizeClaudeThinkingSignature(sample.signature, options)),
            name
          ).toBe(normalized[name])
          expect(
            tryNormalize(() => normalizeClaudeProviderNativeThinkingSignature(sample.signature, options)),
            `${name}Native`
          ).toBe(normalized[`${name}Native`])
        }
      })

      it("matches CompatibleAntigravityClaudeThinkingSignature and CompatibleSignatureForProvider", () => {
        expect(compatibleAntigravityClaudeThinkingSignature(sample.signature) ?? null).toBe(
          sample.antigravityClaude ?? null
        )
        for (const [provider, expected] of Object.entries(sample.compatible as Record<string, string | null>)) {
          expect(
            compatibleSignatureForProvider(provider as SignatureProvider, sample.signature) ?? null,
            provider
          ).toBe(expected)
        }
      })
    })
  }

  it("maps model names to signature providers", () => {
    for (const [model, expected] of Object.entries(fixture.modelProviders)) {
      expect(signatureProviderFromModelName(model), model).toBe(expected)
    }
  })
})
