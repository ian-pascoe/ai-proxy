# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Control panel: React 19 + Vite with Effect Atom (`effect/reactivity`, `@effect/atom-react`) for state and data, a typed
client derived from an Effect `HttpApi` contract shared with the Worker, TanStack Router, accessible headless primitives,
CodeMirror for raw config. Served by the Worker's static assets at `/`, behind the Cloudflare Access admin gate. The rest
of the project is TypeScript + Effect v4 on Cloudflare Workers, deployed with Alchemy.

## Users

One operator: the owner of the deployment, who is also its only administrator. Uses the panel on a desktop browser, in
English, signed in through Cloudflare Access. Day to day the proxy is consumed by coding agents (pi, Claude Code, Codex)
on the same person's machines; the panel is where they go to check on it or change it.

## Product Purpose

A personal LLM gateway: a Cloudflare Workers fork of CLIProxyAPI that pools subscription accounts (Claude, Codex, xAI,
Antigravity, Kimi, Meta, Devin, Vertex) and provider API keys behind OpenAI-, Claude- and Gemini-compatible endpoints.
The panel answers "is my gateway healthy, what is it costing my accounts, and what needs my attention", and lets the
operator connect or re-authorize accounts, manage API keys, shape model routing and edit settings. Success: a weekly
glance shows the state in seconds; fixing a problem (expired account, exhausted quota, bad key) takes one obvious path.

## Positioning

The panel of this fork, not the upstream one: authenticated by Cloudflare Access (no management key, no login screen),
built on Workers-native data (D1 usage records with tokens and latency, the ControlPlane's credential state, cooldowns
and quota signals), and showing only what actually applies on Workers. It is a distinct fork; upstream panel
compatibility is not a goal.

## Operating Context

- Weekly: check health, account quota and usage.
- Occasionally: connect a new account or re-authorize one (device-code, pasted-callback, Vertex service-account import,
  credential JSON upload).
- Rarely: edit provider API keys, model aliases/exclusions, routing and other settings, or the raw config.
- Every pull request gets a preview deployment on workers.dev with empty storage; production is
  https://proxy.ianpascoe.dev.

## Capabilities and Constraints

- Management API under `/v8/management` (config document with versioned writes, credentials, OAuth sessions, usage
  summaries and records, upstream probe). It may change freely to serve the panel; breaking changes are acceptable.
- Tokens, API keys and credential secrets never reach the browser except where the operator explicitly downloads a
  credential file.
- Not available on Workers and must not appear: plugins, file logs, management key, server host/port/TLS, outbound proxy
  URLs, the deprecated `/v0/management`.
- Terminology: an **account** is an OAuth/auth-file credential; an **API key** belongs to a provider key group or an
  OpenAI-compatible endpoint; a **principal** is the Access identity that made a request.

## Evidence on Hand

Real live data through the API: accounts (currently Claude and xAI), one OpenAI-compatible group, about 150 served
models, D1 usage records. No logo, illustrations or brand assets exist; the upstream panel's "CPAMC" branding is not
binding. No testimonials or marketing claims apply.

## Product Principles

1. Attention first: lead with what is broken, expiring or exhausted; healthy things stay quiet.
2. Truthful surface: show only settings and data that take effect on this deployment.
3. One home per concept: each account, key, model rule and setting is edited in exactly one place.
4. Secrets stay server-side: the server probes quotas and upstreams; the browser receives results.
5. Safe writes: every change is version-checked and its effect is visible immediately.

## Accessibility & Inclusion

No product-specific requirement was established; WCAG 2.2 AA and full keyboard operation are the baseline (assumed
default).
