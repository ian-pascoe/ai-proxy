---
version: 1
slug: "web-src-routes-index-tsx"
primary_target: "web/src/routes/index.tsx"
related_targets: ["web/src/routes/accounts.tsx","web/src/routes/keys.tsx","web/src/routes/models.tsx","web/src/routes/usage.tsx","web/src/routes/settings.tsx"]
---

# Control panel (all routes)

Scope: the whole cliproxy control panel, a new `web/` app served at `/` behind the Access admin gate, replacing the
upstream panel. Primary surface: Overview; the same world covers Accounts, API keys, Models, Usage, Settings.
Visitor mode: Operate. Build path: code-led (no image generation; wireframes chose the direction).

Audience and job: the single operator (PRODUCT.md). Weekly: is the gateway healthy, how much of each account's quota is
used, when does it reset, what failed. Occasionally: connect or re-authorize an account. Rarely: keys, model rules,
settings, raw config.

Constraints: show only what applies on Workers; no secrets in the browser (server-side quota probing); version-checked
writes; desktop first, usable on mobile; WCAG 2.2 AA, full keyboard.

Memorable moment: the account statement block, with use against allowance, past windows and a large "resets in" box.

Open decisions: history bars need per-account usage per quota window from D1 (new grouped summary) and, for allowance
history, stored quota snapshots (ControlPlane) or tokens only; final pictogram/icon set; whether a dark theme ships.

## Direction contract

THESIS: Every account reads like a utility statement: this window's use against its allowance, the past windows beside
it, and the date it resets. Refuses the stat-card dashboard (big number, small label, sparkline, grey cards).

OWN-WORLD: Statement white #FBFBF8 ground, utility blue #1D4F91 header band and links, allowance grey #DADDE2 for
unused capacity, ink #1E2329 text, amber #E09F1F near a limit, red #C8312B only for cut-off or failed. Public Sans for
everything, tabular right-aligned figures. Ruled statement blocks with a blue title strip, 2px corners, no shadows, no
gradients. Meters are flat bars on the shared 0-100% scale.

STORY: The operator sees at a glance which account is closest to its limit and when it frees up, trusts the figures
because they are itemised like a bill, and follows any name (account, model, key) to its one home to act.

FIRST VIEWPORT: Utility-blue band with product name, page links and refresh. One amber line under it only when
something needs attention. Then account statements in urgency order, two per row at 1440: header (provider, account),
5-hour and weekly meters with percentages, a 12-bar history of past windows with the current one in blue, and a boxed
"Resets in 2 h 35 m" at the right. Below: itemised usage for the last 24 h (requests, failures, tokens by model).
Primary action per statement: Refresh quota; Connect account sits in the band.

FORM: Utility statement, my ranked list position 1 (chosen as IMPECCABLE'S PICK over the dealt Munich '72), seed key
3043ec39 (re-roll 1).

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and
every shipping raster carrying its provenance
