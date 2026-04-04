# FirstHand Local Design System

This file is the implementation-facing design reference for the current
FirstHand UI. It is derived from the live code in `src/app/globals.css` and the
main app surfaces, so it should track what is actually shipped rather than an
aspirational future system.

It is not the same thing as the product-planning bundle in
`FirstHand Starter Documentation`. That bundle defines MVP intent. This file
defines the current visual language, reusable UI primitives, and usage rules in
the codebase.

## Purpose

Use this document when:

- extending the participant runtime
- adding reviewer surfaces
- refining copy or layout without changing the overall visual language
- deciding whether a new component should reuse an existing pattern

## Design Direction

FirstHand uses a warm editorial product language rather than a default SaaS UI.
The system mixes:

- soft paper-toned backgrounds
- dark navy typography
- terracotta accenting
- large rounded containers with glassy translucency
- serif display type paired with a clean sans serif for body copy

The intended feel is:

- guided
- calm
- trustworthy
- observational rather than salesy

## Foundations

### Typography

- Display font: `Fraunces`
- Sans/body font: `Manrope`
- Display usage: `h1`, `h2`, `h3`, major section titles, demo target section titles
- Sans usage: body copy, labels, controls, helper text, chips

Guidance:

- Use display type for page-level hierarchy, not for dense interface text.
- Keep body and status copy in the sans font.
- Preserve the existing uppercase eyebrow/meta-label pattern for section framing.

### Color Tokens

Defined in [`src/app/globals.css`](/Users/nickster/code/FirstHand/src/app/globals.css):

- `--bg: #f7f2ea`
- `--card: rgba(255, 251, 246, 0.9)`
- `--ink: #14213d`
- `--muted: #5f6b7a`
- `--line: rgba(20, 33, 61, 0.12)`
- `--accent: #dd6e42`
- `--accent-strong: #b9552d`
- `--success: #2f6f5e`
- `--danger: #a63d40`
- `--shadow: 0 24px 70px rgba(20, 33, 61, 0.08)`

Usage rules:

- `--ink` is the default high-emphasis text and primary button color.
- `--muted` is for explanatory copy and secondary metadata.
- `--accent` is for active progress states, selected chips/cards, and warm emphasis.
- `--success` and `--danger` are reserved for operational state and feedback.
- Borders should usually use `--line` or low-opacity `--ink`, not pure gray.

### Background Treatment

The app background is part of the system, not just page chrome:

- layered radial gradients
- warm cream-to-paper vertical blend
- translucent elevated cards over that background

Guidance:

- Avoid dropping flat white boxes directly onto pages unless they are embedded
  content, like the study workspace frame.
- New top-level surfaces should usually inherit the same card treatment used by
  `.hero`, `.session-card`, `.panel`, `.status-card`, `.step-card`,
  `.runner-card`, and `.review-item`.

## Core Surface Primitives

### Elevated Surface

Used by:

- `.hero`
- `.session-card`
- `.panel`
- `.status-card`
- `.step-card`
- `.runner-card`
- `.review-item`

Visual recipe:

- translucent warm card background
- thin navy border
- large radius, usually `28px`
- long soft shadow
- blur/backdrop feel

Use this for any primary information container.

### Soft Panel

Used by:

- `.soft-panel`
- input sections inside auth/setup flows

Visual recipe:

- inherits panel shape
- removes heavy shadow
- sits inside larger cards

Use this for nested sections when a full elevated card would feel too heavy.

### Alerts

Classes:

- `.alert-banner`
- `.alert-success`
- `.alert-danger`
- `.alert-neutral`

Use alerts for:

- auth failures
- transcript queue/result notices
- empty states
- interrupted run recovery
- historical attempt warnings

Alert structure should stay consistent:

- one bold summary line in `strong`
- one short supporting paragraph in `.status-copy`

## Layout Patterns

### Page Shells

Key layout classes:

- `.shell`: marketing-style overview width container
- `.session-layout`: app/reviewer page width container
- `.session-grid`: split main content + side rail
- `.panel-grid`, `.status-grid`, `.review-grid`: responsive information grids

Guidance:

- Use `.shell` for the homepage.
- Use `.session-layout` for participant and reviewer flows.
- Prefer responsive grid layouts over custom one-off flex compositions.

### Flow Progress

Key classes:

- `.flow-header`
- `.flow-steps`
- `.flow-step`
- `.flow-step.is-active`

Use this pattern for multi-stage participant progress only. It has a specific
meaning in the product and should not be reused for unrelated tabs or stepper
controls.

### Review Grids

Key classes:

- `.review-grid`
- `.review-list`
- `.review-heading`
- `.attempt-grid`
- `.attempt-card`

These are the core reviewer-surface list primitives. New reviewer views should
reuse these before introducing alternative card systems.

## Reusable Components and Patterns

### Buttons

Classes:

- `.button`
- `.button.secondary`

Rules:

- Primary button uses `--ink` fill with white text.
- Secondary button uses low-contrast ink tint.
- Buttons are pill-shaped and bold.
- Do not introduce square-corner or outline-button variants unless the system
  expands intentionally.

### Chips

Classes:

- `.chip`
- `.chip-selected`
- `.chip-row`
- `.compact-chip-row`

Used for:

- reviewer identity/status tags
- lightweight study filters
- attempt navigation links
- contextual metadata

Rules:

- Chips are the default lightweight filter control.
- Selected chips invert to dark fill with white text.
- Avoid overloading chips as dense navigation menus.

### Inputs

Classes:

- `.response-input`
- `.choice-list`
- `.choice-item`
- `.choice-item.is-selected`

Used for:

- reviewer password input
- participant open-text responses
- single-choice steps

Rules:

- Inputs keep the rounded, softly bordered language of the rest of the UI.
- Selected options use warm accent tinting rather than strong dark fills.

### Modals

Classes:

- `.modal-backdrop`
- `.modal-card`
- `.modal-checklist`
- `.modal-actions`

Used for:

- recording start boundary
- return-to-session guidance

Rules:

- Modals should feel like high-focus guidance moments, not system dialogs.
- Keep copy short, operational, and reassuring.

### Recording Status

Classes:

- `.recording-dot`
- `.recording-callout`
- `.recording-callout.is-active`
- `.recording-callout.is-starting`
- `.recording-callout.is-stopping`
- `.recording-callout.is-failed`

Rules:

- Recording status is one of the product’s highest-risk surfaces.
- Use explicit state styling and short status copy.
- Prefer operational clarity over visual subtlety here.

### Attempt History

Classes:

- `.attempt-nav`
- `.attempt-link-stack`
- `.attempt-grid`
- `.attempt-grid-compact`
- `.attempt-card`
- `.attempt-card-selected`

Used for:

- reviewer study-level attempt lists
- reviewer session attempt history

Rules:

- Latest attempt is the canonical view.
- Historical attempts should be visually available but clearly secondary unless
  actively selected.
- Attempt cards should always show status, transcript, recording, and evidence
  counts in a compact, comparable format.

## Product-Specific Surface Rules

### Participant Runtime

Primary sources:

- [`src/components/participant-session-flow.tsx`](/Users/nickster/code/FirstHand/src/components/participant-session-flow.tsx)
- [`src/components/study-runner.tsx`](/Users/nickster/code/FirstHand/src/components/study-runner.tsx)

Guidelines:

- The runtime should feel guided, not app-like in a generic dashboard sense.
- One main decision or action per stage.
- Setup, consent, and recording transitions should emphasize confidence and
  clarity over compactness.
- The workspace area is the functional heart of the flow and can be denser than
  the surrounding chrome.

### Reviewer Surfaces

Primary sources:

- [`src/app/review/study/[studyId]/page.tsx`](/Users/nickster/code/FirstHand/src/app/review/study/%5BstudyId%5D/page.tsx)
- [`src/app/review/session/[sessionId]/page.tsx`](/Users/nickster/code/FirstHand/src/app/review/session/%5BsessionId%5D/page.tsx)
- [`src/app/review/login/page.tsx`](/Users/nickster/code/FirstHand/src/app/review/login/page.tsx)

Guidelines:

- Reviewer UI should feel operational and evidence-focused.
- Dense information is acceptable, but hierarchy must remain obvious.
- Study/session/attempt relationships should always be visually legible.
- Preserve the current mix of chips, metadata grids, and compact attempt cards
  before inventing new review widgets.

### Demo Target Surface

Primary source:

- [`src/app/demo-target/checkout/page.tsx`](/Users/nickster/code/FirstHand/src/app/demo-target/checkout/page.tsx)

Guidelines:

- This surface intentionally mirrors the warm product language while remaining
  visibly distinct from the runtime chrome.
- It is a target artifact, not the core application shell.

## Interaction and Copy Principles

- Prefer short instructional copy over abstract product language.
- Warnings should be explicit and recoverable where possible.
- Status text should describe what happened and what the user can do next.
- Avoid vague labels like "Continue" when a more specific action would reduce
  uncertainty.

## Responsive Rules

Current breakpoints in [`src/app/globals.css`](/Users/nickster/code/FirstHand/src/app/globals.css):

- `@media (max-width: 900px)`: collapses session layout and reduces padding
- `@media (min-width: 720px)`: enhances attempt card headers into split layout

Guidance:

- New layouts should collapse gracefully to one column on narrower widths.
- Reuse existing grid behavior before introducing new breakpoint logic.

## Implementation Guidance

When adding UI:

1. Start by reusing an existing surface class if the semantic job already
   exists.
2. Add a new class only when the pattern is materially distinct.
3. Prefer extending the current token palette instead of adding one-off colors.
4. Keep the warm editorial aesthetic intact unless we intentionally redesign it.

## Current Source of Truth

For implementation, treat these files as canonical:

- [`src/app/globals.css`](/Users/nickster/code/FirstHand/src/app/globals.css)
- [`src/app/layout.tsx`](/Users/nickster/code/FirstHand/src/app/layout.tsx)
- [`src/components/participant-session-flow.tsx`](/Users/nickster/code/FirstHand/src/components/participant-session-flow.tsx)
- [`src/components/study-runner.tsx`](/Users/nickster/code/FirstHand/src/components/study-runner.tsx)
- [`src/app/review/study/[studyId]/page.tsx`](/Users/nickster/code/FirstHand/src/app/review/study/%5BstudyId%5D/page.tsx)
- [`src/app/review/session/[sessionId]/page.tsx`](/Users/nickster/code/FirstHand/src/app/review/session/%5BsessionId%5D/page.tsx)
- [`src/app/review/login/page.tsx`](/Users/nickster/code/FirstHand/src/app/review/login/page.tsx)
