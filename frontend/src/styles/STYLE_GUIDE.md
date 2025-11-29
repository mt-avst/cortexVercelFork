# Momentum Design System - Style Guide

This guide documents the CSS architecture for the AdaptaLabs frontend, built on the Momentum Design System.

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Design Tokens](#design-tokens)
3. [Utility Classes](#utility-classes)
4. [Component Patterns](#component-patterns)
5. [Theme Implementation](#theme-implementation)
6. [Best Practices](#best-practices)

---

## Architecture Overview

The CSS is organized using CSS Layers for predictable specificity:

```css
@layer reset, tokens, base, components, utilities, themes;
```

**Layer Order (lowest to highest specificity):**
1. `reset` - Browser reset and normalization
2. `tokens` - CSS custom properties (design tokens)
3. `base` - Raw HTML element styling
4. `components` - Reusable UI component styles
5. `utilities` - Single-purpose utility classes
6. `themes` - Theme-specific overrides (light/dark)

**Entry Point:** `main.css` imports all layers in order.

---

## Design Tokens

Design tokens are CSS custom properties defined in `_tokens.css`. Always use tokens instead of hardcoded values.

### Colors

```css
/* Background Colors */
--bg-app: #0A091A;                    /* App background */
--bg-card: rgba(255, 255, 255, 0.05); /* Card backgrounds */
--bg-hover: rgba(255, 255, 255, 0.08); /* Hover states */
--bg-input: rgba(255, 255, 255, 0.05); /* Form inputs */

/* Text Colors */
--text-primary: #E0E0E0;              /* Headings */
--text-body: rgba(224, 224, 224, 0.8); /* Body text */
--text-muted: rgba(224, 224, 224, 0.6); /* Secondary text */

/* Brand Colors */
--brand-headline: #FF4E50;            /* Brand coral (dark mode) */
--brand-primary: #FF4E50;
--brand-secondary: #FC913A;

/* CTA Colors */
--cta-bg: #FF4E50;
--cta-bg-hover: #ff5e60;
--cta-text: #FFFFFF;
--cta-border: #FF4E50;
```

### Spacing

```css
--spacing-1: 0.25rem;   /* 4px */
--spacing-2: 0.5rem;    /* 8px */
--spacing-3: 0.75rem;   /* 12px */
--spacing-4: 1rem;      /* 16px */
--spacing-5: 1.25rem;   /* 20px */
--spacing-6: 1.5rem;    /* 24px */
--spacing-8: 2rem;      /* 32px */
--spacing-12: 3rem;     /* 48px */
```

### Typography

```css
--font-family-base: 'Inter', -apple-system, sans-serif;
--font-family-heading: 'Montserrat', -apple-system, sans-serif;

--font-size-xs: 0.75rem;    /* 12px */
--font-size-sm: 0.875rem;   /* 14px */
--font-size-body: 1rem;     /* 16px */
--font-size-lg: 1.125rem;   /* 18px */
--font-size-h1: 2.5rem;     /* 40px */
--font-size-h2: 2rem;       /* 32px */
--font-size-h3: 1.75rem;    /* 28px */

--line-height-body: 1.6;
--line-height-heading: 1.2;
```

### Borders & Shadows

```css
--card-radius: 12px;
--btn-radius: 8px;
--input-radius: 8px;

--shadow-card: 0 4px 16px rgba(0, 0, 0, 0.2);
--shadow-dropdown: 0 8px 32px rgba(0, 0, 0, 0.4);
```

---

## Utility Classes

Bootstrap-compatible utility classes are available in `_utilities.css`.

### Display

```css
.d-none          /* display: none */
.d-block         /* display: block */
.d-flex          /* display: flex */
.d-inline        /* display: inline */
.d-inline-flex   /* display: inline-flex */
.d-grid          /* display: grid */
```

### Flexbox

```css
.flex-row        /* flex-direction: row */
.flex-column     /* flex-direction: column */
.flex-wrap       /* flex-wrap: wrap */
.justify-content-start
.justify-content-center
.justify-content-end
.justify-content-between
.align-items-start
.align-items-center
.align-items-end
.gap-1 to .gap-5 /* gap spacing */
```

### Spacing

```css
/* Margin */
.m-0 to .m-5     /* all sides */
.mt-0 to .mt-5   /* top */
.mb-0 to .mb-5   /* bottom */
.ms-0 to .ms-5   /* start (left in LTR) */
.me-0 to .me-5   /* end (right in LTR) */
.mx-auto         /* center horizontally */

/* Padding */
.p-0 to .p-5     /* all sides */
.pt-0 to .pt-5   /* top */
.pb-0 to .pb-5   /* bottom */
.py-5            /* vertical */
.px-5            /* horizontal */
```

### Text

```css
.text-center
.text-start
.text-end
.text-muted      /* var(--text-muted) */
.text-primary    /* var(--text-primary) */
.fw-bold         /* font-weight: 700 */
.fw-semibold     /* font-weight: 600 */
.fw-medium       /* font-weight: 500 */
.fst-italic      /* font-style: italic */
.text-uppercase
```

### Responsive Utilities

All display, flex, and spacing utilities have responsive variants:
- `d-md-flex` - Apply at medium breakpoint (768px+)
- `d-lg-none` - Apply at large breakpoint (992px+)

---

## Component Patterns

### Cards

```html
<div class="card">
  <div class="card-header">Header</div>
  <div class="card-body">Content</div>
  <div class="card-footer">Footer</div>
</div>

<!-- Clickable card -->
<div class="card card-clickable">...</div>

<!-- Admin card with full height -->
<div class="card admin-card admin-card-main">...</div>
```

### Buttons

```html
<button class="btn btn-primary">Primary Action</button>
<button class="btn btn-outline-secondary">Secondary</button>
<button class="btn btn-sm">Small Button</button>
<button class="btn btn-nowrap">No Wrap</button>
```

### Forms

```html
<div class="filter-field">
  <label class="form-label">Label</label>
  <input type="text" class="form-control" />
</div>

<div class="filter-field-sm">
  <label class="form-label">Dropdown</label>
  <select class="form-select">...</select>
</div>
```

### Stat Cards

```html
<div class="card stat-card admin-stat-card">
  <div class="card-body stat-card-body">
    <div class="stat-card-header">
      <span class="stat-label">Label</span>
      <Icon class="stat-icon" />
    </div>
    <h2 class="stat-value">42</h2>
    <small class="stat-subtitle">Subtitle</small>
  </div>
</div>
```

### Empty States

```html
<div class="empty-state">
  <Icon class="empty-state-icon" />
  <h4 class="empty-state-title">No Items Found</h4>
  <p class="empty-state-text">Description text</p>
</div>
```

### Loading States

```html
<div class="loading-container">
  <div class="spinner-border" role="status">
    <span class="visually-hidden">Loading...</span>
  </div>
</div>
```

### Layout Patterns

```html
<!-- Page container -->
<div class="container-fluid admin-page-fullheight">...</div>

<!-- Analytics container (max-width) -->
<div class="container-fluid analytics-container">...</div>

<!-- Filters row -->
<div class="filters-row">
  <div class="filter-field">...</div>
  <div class="filter-field-sm">...</div>
</div>

<!-- Tab container -->
<div class="tabs-container">
  <ul class="nav nav-tabs nav-fill">...</ul>
</div>
<div class="tab-content tab-content-padded">...</div>
```

---

## Theme Implementation

### How Themes Work

1. **Dark Mode (Default)**: Tokens in `:root` define dark theme values
2. **Light Mode**: `body.theme-light` overrides tokens with light values
3. **Theme Toggle**: React `ThemeContext` applies class to `<body>`

### Theme Variables by Mode

| Token | Dark Mode | Light Mode |
|-------|-----------|------------|
| `--bg-app` | #0A091A | #FFFFFF |
| `--bg-card` | rgba(255,255,255,0.05) | #FFFFFF |
| `--text-primary` | #E0E0E0 | #1A1A1A |
| `--brand-headline` | #FF4E50 | #E86C24 |

### Theme-Specific Styles

For component-specific theme overrides, add to `_themes.css`:

```css
body.theme-light .my-component {
  background: var(--bg-card);
  color: var(--text-body);
}

body.theme-dark .my-component {
  background: rgba(30, 30, 50, 0.95);
  color: #E0E0E0;
}
```

---

## Best Practices

### ✅ DO

1. **Use design tokens** for all colors, spacing, and typography
2. **Use utility classes** for simple, one-off styling
3. **Use component classes** for reusable patterns
4. **Use CSS custom properties** for dynamic values
5. **Test both themes** after making style changes

### ❌ DON'T

1. **Avoid inline styles** unless truly dynamic (calculated values)
2. **Avoid hardcoded colors** - use CSS variables
3. **Avoid `!important`** unless overriding third-party styles
4. **Avoid creating new CSS** for one-time use - use utilities

### When to Use Inline Styles

Inline styles are acceptable for:
- Truly dynamic values (calculated at runtime)
- Animation values
- One-time positioning adjustments

```tsx
// ✅ Good - dynamic value
<div style={{ height: `${calculatedHeight}px` }}>

// ❌ Bad - should use CSS class
<div style={{ display: 'flex', marginBottom: '1rem' }}>
```

### Adding New Components

1. Define styles in `_components.css`
2. Use existing tokens for colors/spacing
3. Add theme variants to `_themes.css` if needed
4. Document in this style guide

---

## File Reference

| File | Purpose |
|------|---------|
| `main.css` | Entry point, layer imports |
| `_reset.css` | Browser normalization |
| `_tokens.css` | Design tokens (CSS variables) |
| `_base.css` | HTML element defaults |
| `_components.css` | Reusable component styles |
| `_utilities.css` | Utility classes |
| `_themes.css` | Light/dark theme overrides |

---

*Last updated: November 2025*








