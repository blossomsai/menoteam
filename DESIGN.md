---
name: Menoteam Work Map
description: A calm shared surface for durable team context.
colors:
  work-green: "oklch(0.400 0.087 160)"
  work-green-soft: "oklch(0.955 0.020 160)"
  signal-amber: "oklch(0.690 0.135 70)"
  signal-amber-soft: "oklch(0.965 0.032 78)"
  ink: "oklch(0.205 0.018 250)"
  ink-muted: "oklch(0.500 0.018 250)"
  canvas: "oklch(0.990 0.003 250)"
  surface: "oklch(1 0 0)"
  surface-subtle: "oklch(0.970 0.006 250)"
  line: "oklch(0.885 0.010 250)"
  danger: "oklch(0.555 0.175 25)"
typography:
  display:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "clamp(2rem, 4vw, 3.5rem)"
    fontWeight: 650
    lineHeight: 1.05
    letterSpacing: "-0.035em"
  headline:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "clamp(1.35rem, 2vw, 1.75rem)"
    fontWeight: 620
    lineHeight: 1.2
    letterSpacing: "-0.02em"
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.55
  label:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "0.75rem"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "0.035em"
rounded:
  sm: "6px"
  md: "10px"
  lg: "16px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "16px"
  lg: "24px"
  xl: "32px"
components:
  button-primary:
    backgroundColor: "{colors.work-green}"
    textColor: "{colors.surface}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    padding: "10px 16px"
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "16px"
  filter-chip:
    backgroundColor: "{colors.surface-subtle}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "7px 10px"
---

# Design System: Menoteam Work Map

<!-- SEED: Re-document from the implemented interface after the first production UI is stable. -->

## Overview

**Creative North Star: "The Engineering Review Room"**

Menoteam feels like a bright review room at mid-morning: clear screens, printed system maps, quiet focus, and enough structure for a team to reason together. It is calm, precise, and information-dense without becoming visually heavy.

The interface should recede behind Work, ownership, relationships, and durable context. It explicitly rejects sci-fi agent command centers, org charts, Kanban conventions, generic card-grid dashboards, and decorative AI theatrics.

**Key Characteristics:**

- A white, daylight-neutral working canvas.
- Deep green used sparingly for selected or authoritative context.
- Graph and list as equal, synchronized representations.
- Strong typography and thin structural lines instead of decorative containers.
- Inferences visibly labeled and never presented as confirmed facts.

## Colors

The palette is restrained and factual: near-white surfaces, dark ink, a grounded work green, and amber reserved for uncertainty or attention.

### Primary

- **Work Green** (`oklch(0.400 0.087 160)`): active navigation, selected Work, focus accents, and the most important actions.
- **Work Green Soft** (`oklch(0.955 0.020 160)`): selected rows and subtle relationship context.

### Secondary

- **Signal Amber** (`oklch(0.690 0.135 70)`): inferred owners, unresolved state, and warnings that are not errors.
- **Signal Amber Soft** (`oklch(0.965 0.032 78)`): the background for inference labels and attention notices.

### Neutral

- **Ink** (`oklch(0.205 0.018 250)`): primary text and high-priority structure.
- **Muted Ink** (`oklch(0.500 0.018 250)`): metadata and supporting context.
- **Canvas** (`oklch(0.990 0.003 250)`): application background.
- **Surface** (`oklch(1 0 0)`): documents, drawers, and primary working regions.
- **Subtle Surface** (`oklch(0.970 0.006 250)`): controls and secondary bands.
- **Line** (`oklch(0.885 0.010 250)`): dividers, graph edges, and container boundaries.

### Named Rules

**The Evidence Rule.** Green means selected or confirmed; amber means inferred or unresolved. Neither meaning may rely on color alone.

**The One Voice Rule.** Work Green should occupy less than ten percent of a screen. Its rarity gives it authority.

## Typography

**Display Font:** system sans (`-apple-system`, `BlinkMacSystemFont`, `Segoe UI`, sans-serif)
**Body Font:** system sans (`-apple-system`, `BlinkMacSystemFont`, `Segoe UI`, sans-serif)
**Label/Mono Font:** system mono (`ui-monospace`, `SFMono-Regular`, `Menlo`, monospace)

**Character:** Native system type keeps the dashboard fast and tool-like. Tight headings establish hierarchy; comfortable body copy makes Living Docs readable for long sessions.

### Hierarchy

- **Display** (650, `clamp(2rem, 4vw, 3.5rem)`, 1.05): rare page-level framing.
- **Headline** (620, `clamp(1.35rem, 2vw, 1.75rem)`, 1.2): panel and Work titles.
- **Title** (600, `1.05rem`, 1.3): rows, nodes, and document sections.
- **Body** (400, `1rem`, 1.55): descriptions and Living Docs, constrained to about 72 characters per line where practical.
- **Label** (600, `0.75rem`, `0.035em`): metadata, states, refs, and compact filters; labels use sentence case.

### Named Rules

**The Document Rule.** Living Docs read like documents, not metadata cards. Give them line length, rhythm, and uninterrupted vertical space.

## Elevation

The system is flat by default. Tonal contrast, dividers, and spatial overlap establish hierarchy. A soft shadow is allowed only for temporary layers such as a node detail drawer or menu; graph nodes and list rows remain flat.

### Shadow Vocabulary

- **Temporary Layer** (`box-shadow: 0 16px 48px oklch(0.205 0.018 250 / 0.14)`): drawers, dialogs, and menus only.
- **Focus Ring** (`0 0 0 3px oklch(0.400 0.087 160 / 0.22)`): keyboard focus paired with a solid green outline.

### Named Rules

**The Flat-by-Default Rule.** If a border or spacing change can communicate the hierarchy, do not add a shadow.

## Components

Components should feel precise and durable, with modest radii and visible interaction states.

### Buttons

- **Shape:** compact rounded rectangle (`6px`).
- **Primary:** Work Green with white text and `10px 16px` padding.
- **Hover / Focus:** slight luminance change; a visible two-part focus treatment; no scale transform.
- **Secondary / Ghost:** neutral surface or transparent background with a one-pixel line.

### Chips

- **Style:** compact sentence-case text on Subtle Surface; selected chips use Work Green Soft and a green border.
- **State:** selected state uses text, border, and color together. Inference chips always include the word “Inferred.”

### Cards / Containers

- **Corner Style:** modest (`10px`) or square where the content is table-like.
- **Background:** Surface over Canvas.
- **Shadow Strategy:** flat at rest; see Elevation.
- **Border:** one-pixel Line when separation is necessary.
- **Internal Padding:** `16px` compact, `24px` standard, `32px` for document panels.

### Inputs / Fields

- **Style:** white surface, one-pixel Line, `6px` radius, stable height.
- **Focus:** Work Green border plus visible focus ring.
- **Error / Disabled:** textual explanation accompanies color; disabled controls remain legible.

### Navigation

Use a restrained horizontal app header on wide screens and a compact top region on mobile. Active views use a green text-and-line treatment. Navigation never resembles an agent roster or command console.

### Work Graph

Nodes display title, owner, and state without becoming cards full of metrics. Edges distinguish hierarchy from dependency through line style and labels, and every graph fact has an equivalent list or detail representation.

## Do's and Don'ts

### Do:

- **Do** prioritize title, owner, state, relationship, recency, and Living Doc in that order.
- **Do** preserve a complete list representation for keyboard, mobile, and accessibility use.
- **Do** label candidate ownership as “Inferred” and show its evidence when available.
- **Do** use the `4/8/16/24/32px` spacing rhythm and visible WCAG 2.2 AA focus states.
- **Do** make empty, loading, error, and overflow behavior explicit.

### Don't:

- **Don't** build a sci-fi agent command center or chat-bot control room.
- **Don't** turn the team into an org chart, company simulator, or agent-observability console.
- **Don't** imitate a Kanban board or generic project-management suite.
- **Don't** use a cream-and-gradient AI SaaS palette, glassmorphism, or a decorative card grid.
- **Don't** imply uncertain inferences are verified facts.
- **Don't** hide information in hover-only states or communicate state through color alone.
