---
name: cliproxy control panel
description: A personal LLM gateway panel set as Swiss hiking trail signage (Wanderweg), where quota is a walk to the next reset.
colors:
  white: "#ffffff"
  stone-1: "#f3f3f1"
  stone-2: "#e3e3df"
  stone-3: "#c4c5c0"
  stone-4: "#6a6c69"
  ink: "#1b1c1b"
  yellow: "#f5c400"
  yellow-deep: "#dcae00"
  red: "#d52b1e"
typography:
  totals:
    fontFamily: "Atkinson Hyperlegible Next Variable, Atkinson Hyperlegible Next, system-ui, sans-serif"
    fontSize: "2.25rem"
    fontWeight: 750
    lineHeight: 1.1
    letterSpacing: "-0.025em"
  status:
    fontFamily: "Atkinson Hyperlegible Next Variable, Atkinson Hyperlegible Next, system-ui, sans-serif"
    fontSize: "2rem"
    fontWeight: 750
    lineHeight: 1.15
    letterSpacing: "-0.025em"
  section:
    fontFamily: "Atkinson Hyperlegible Next Variable, Atkinson Hyperlegible Next, system-ui, sans-serif"
    fontSize: "1.375rem"
    fontWeight: 750
    lineHeight: 1.15
    letterSpacing: "-0.015em"
  body:
    fontFamily: "Atkinson Hyperlegible Next Variable, Atkinson Hyperlegible Next, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.5
  table:
    fontFamily: "Atkinson Hyperlegible Next Variable, Atkinson Hyperlegible Next, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.5
  caption:
    fontFamily: "Atkinson Hyperlegible Next Variable, Atkinson Hyperlegible Next, system-ui, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 600
    lineHeight: 1.5
rounded:
  default: "3px"
spacing:
  1: "4px"
  2: "8px"
  3: "12px"
  4: "16px"
  5: "24px"
  6: "40px"
  7: "64px"
components:
  shell-bar:
    backgroundColor: "{colors.yellow}"
    textColor: "{colors.ink}"
    height: "64px"
  button-connect:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.white}"
    rounded: "{rounded.default}"
    height: "40px"
    padding: "0 16px 0 12px"
  button-refresh:
    backgroundColor: "{colors.yellow}"
    textColor: "{colors.ink}"
    rounded: "{rounded.default}"
    size: "40px"
  button-refresh-hover:
    backgroundColor: "{colors.yellow-deep}"
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.white}"
    rounded: "{rounded.default}"
    height: "44px"
    padding: "0 24px 0 16px"
  button-secondary:
    backgroundColor: "{colors.white}"
    textColor: "{colors.ink}"
    rounded: "{rounded.default}"
    height: "40px"
    padding: "0 16px"
  button-secondary-hover:
    backgroundColor: "{colors.stone-1}"
  reset-blade:
    backgroundColor: "{colors.yellow}"
    textColor: "{colors.ink}"
    height: "34px"
    width: "192px"
  reset-blade-closed:
    backgroundColor: "{colors.red}"
    textColor: "{colors.white}"
  meter-track:
    backgroundColor: "{colors.stone-2}"
    height: "8px"
  meter-fill:
    backgroundColor: "{colors.ink}"
  meter-fill-out:
    backgroundColor: "{colors.red}"
  trail-mark:
    backgroundColor: "{colors.red}"
    width: "16px"
    height: "8px"
---

# Design System: cliproxy control panel

## Overview

**Creative North Star: "The Trail Signpost"**

Quota is a walk to the next reset. Each account reads like a Swiss Wanderweg signpost: where it stands now, and how long until capacity is back, in walking-sign time. The ground is plain white; the only loud things are the yellow route (the shell bar and the reset blades) and, when something is wrong, red. It is a glance tool for one operator at a desktop monitor between agent runs, usable down to 390 px.

Structure comes from hairlines and one ink rule under table headings. There are no cards, no boxes inside boxes, no shadows, and no per-section colour strips. Type is Atkinson Hyperlegible Next with tabular figures throughout.

**Key Characteristics:**

- White ground, yellow shell bar, black sign ink.
- One meaning per colour; stone is the only neutral ramp.
- Every figure is labelled once, by its column.
- The reset blade is the memorable object; its unfold is the only authored motion.
- Hairlines, no cards, no shadows.

## Colors

A signage palette: white, sign ink, one route yellow, one danger red, and a fixed stone ramp.

### Primary

- **Wanderweg Yellow** (#f5c400): the route. The shell bar and the reset blades only. 12:1 against ink.
- **Pressed Yellow** (#dcae00): hover of the refresh button on the shell bar.

### Secondary

- **Swiss Red** (#d52b1e): closed or failing. The closed blade, the red trail mark, failed counts, meters at 100%, the red band on a near-limit tip. 4.9:1 on white.

### Neutral

- **White** (#ffffff): page ground, secondary button fill, tip bands.
- **Sign Ink** (#1b1c1b): text, figures, the connect button, meter fills, table-heading rules, focus ring.
- **Stone 1** (#f3f3f1): hover and sunk fields.
- **Stone 2** (#e3e3df): meter tracks and row hairlines.
- **Stone 3** (#c4c5c0): strong rules, link underlines, scrollbar.
- **Stone 4** (#6a6c69): secondary text and captions, 5.4:1 on white; also the edge on the near-limit tip.

### Named Rules

**The One Meaning Rule.** Every colour carries one meaning. Yellow is the route, never a link underline or a highlight. Red is closed or failing, never decoration. Stone is the only neutral ramp; no ad-hoc greys.

**The Near-Limit Rule.** Near-limit is never solid red. It is the white-red-white band on the blade tip, with an ink note in the row. Solid red is reserved for closed, failed, and 100%.

## Typography

**Display Font:** Atkinson Hyperlegible Next Variable (with system-ui, sans-serif), self-hosted via @fontsource-variable.
**Body Font:** the same family; one face only.

**Character:** Legible first, in sign-painter weights: heavy for names and totals, plain for table text. Tabular numerals on the whole body so columns of figures align.

### Hierarchy

- **Totals** (750, 2.25rem, 1.1, -0.025em): the day's totals.
- **Status** (750, 2rem desktop / 1.625rem mobile, 1.15, -0.025em): the one sentence under the shell. Headings: 800 at 1.25–2.25rem with -0.03em for the wordmark and empty-page titles.
- **Section** (750, 1.375rem, 1.15): section headings.
- **Body** (400, 1rem, 1.5): prose, capped at 65–70ch; provider names are 750 at 1rem.
- **Table** (400, 0.875rem): table text, nav, buttons (700).
- **Caption** (600, 0.8125rem, stone-4): column headings, meter labels, clock times, notes.

### Named Rules

**The One Label Rule.** A figure is labelled once, by its column head. On narrow screens, where heads disappear, the request figure gets one key line above the list, not a label per row.

## Layout

Single column, max width 80rem, gutter 2.5rem (1rem under 40rem). Page sections stack on a 4rem gap. Spacing scale: 4, 8, 12, 16, 24, 40, 64 px. The accounts table runs in urgency order: marker, provider and address, quota meters (max 26rem), reset blade, requests right-aligned. Below, the last day: a 13rem column of totals beside the by-model table with a thin ink share bar.

Under 48rem each account row becomes a grid: account, quota, then reset blade left and request count right. Under 64rem the shell wraps its page links into a second row that scrolls sideways, with edge fades.

## Elevation & Depth

Flat. Depth is carried by hairlines (1px stone-2 between rows), a 2px ink rule under table headings, and colour blocks. There are no cards and no shadows. The single exception is a drop-shadow filter on the blade tip, used purely as a 1px stone-4 edge so the white band reads against the white page.

### Named Rules

**The Hairline Rule.** Separate with rules, never with boxes or shadows.

## Shapes

Square signage. Buttons take a 3px radius; meters 1px. Blades have a square tail and a pointed head (clip-path polygon, tip 0.875rem) and a fixed length of 12rem, so tips align down the column like blades on one post. The trail mark is a flat 1rem by 0.5rem red band.

## Components

### Shell Bar

- Yellow, min-height 4rem, ink text. Wordmark (800, 1.25rem) over the host in 0.8125rem; page links 0.9375rem; the active link has a 4px ink underline inset, hover a pale one. Connect account is an ink button; refresh is a 2px ink outline square that turns Pressed Yellow on hover and spins while loading.

### Buttons

- **Primary / Connect:** ink fill, white text, 3px radius, 700 weight, leading icon from lucide-react; 44px tall in pages, 40px in the shell. Hover mixes ink toward white.
- **Secondary:** white, 2px ink border, 40px tall; hover fills stone-1.
- **Focus:** 3px ink outline, 2px offset, on every element.

### Reset Blade (signature)

- 12rem by 2.125rem. Yellow with ink text; the destination (window name, 500) sits left and the time (750, "1 h 34 min") right; the clock time sits beneath in a stone-4 caption. Closed: red with white text, destination "Back in". Near limit: a white-red-white band on the tip, with extra right padding. It has a role=img and a full aria-label.
- **Motion:** on load the blades unfold left to right (520ms, ease-out-expo), staggered 45ms per row; the tip band fades in 420ms later. Reduced motion collapses it.

### Meter

- Grid of label (4rem), track, value (2.75rem). Track stone-2, 8px high; fill ink; at 100% fill and value turn red. The scale is a shared 0–100%.

### Trail Mark

- The red 1rem by 0.5rem band beside a closed or failing item, including load-error messages.

### Tables

- 0.875rem text, 1rem cell padding, a 2px ink rule under headings, stone-2 hairlines between rows, numbers right-aligned. A failed count above zero is red.

### Links

- Ink text with a 2px stone-3 underline that goes ink on hover. Never yellow.

## Do's and Don'ts

### Do:

- **Do** keep yellow to the shell bar and the reset blades.
- **Do** use red only for closed, failing, and 100%; show near-limit as the tip band plus an ink note.
- **Do** draw every neutral from stone-1 to stone-4.
- **Do** give blades a fixed 12rem length with destination left and time right.
- **Do** label each figure once, by its column; give the mobile request figure one key line above the list.
- **Do** separate with 1px stone-2 hairlines and the 2px ink heading rule.
- **Do** keep the unfold as the only authored motion and respect reduced motion.

### Don't:

- **Don't** use cards, boxes inside boxes, shadows, or per-section colour strips.
- **Don't** colour link underlines yellow, or add a second accent.
- **Don't** fill a meter or blade solid red for near-limit.
- **Don't** repeat a label on every row.
- **Don't** add greys outside the stone ramp.
